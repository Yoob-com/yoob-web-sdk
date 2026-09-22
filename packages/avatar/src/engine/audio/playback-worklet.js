const RESAMPLER_TABLES = new Map();

function concatenateFloat32(left, right) {
  const output = new Float32Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
}

function coefficientTable(sourceRate, targetRate, taps, phases) {
  const key = `${sourceRate}:${targetRate}:${taps}:${phases}`;
  const cached = RESAMPLER_TABLES.get(key);
  if (cached) return cached;
  const half = Math.floor(taps / 2);
  const cutoff = 0.5 * Math.min(1, targetRate / sourceRate) * 0.94;
  const table = new Float32Array(phases * taps);
  for (let phase = 0; phase < phases; phase += 1) {
    const fraction = phase / phases;
    let gain = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      const offset = tap - half;
      const distance = offset - fraction;
      const angle = 2 * Math.PI * cutoff * distance;
      const sinc = Math.abs(angle) < 1e-9 ? 1 : Math.sin(angle) / angle;
      const window = 0.42
        + 0.5 * Math.cos(Math.PI * offset / half)
        + 0.08 * Math.cos(2 * Math.PI * offset / half);
      const value = 2 * cutoff * sinc * window;
      table[phase * taps + tap] = value;
      gain += value;
    }
    for (let tap = 0; tap < taps; tap += 1) {
      table[phase * taps + tap] /= gain;
    }
  }
  RESAMPLER_TABLES.set(key, table);
  return table;
}

/** Stateful native-24-kHz to hardware-rate windowed-sinc resampler. */
export class BandlimitedResampler {
  constructor(sourceRate, targetRate, taps = 33, phases = 1024) {
    if (!(sourceRate > 0) || !(targetRate > 0) || taps < 5 || taps % 2 !== 1) {
      throw new Error("invalid band-limited resampler configuration");
    }
    this.sourceRate = sourceRate;
    this.targetRate = targetRate;
    this.taps = taps;
    this.phases = phases;
    this.half = Math.floor(taps / 2);
    this.step = sourceRate / targetRate;
    this.table = coefficientTable(sourceRate, targetRate, taps, phases);
    this.buffer = new Float32Array(this.half);
    this.position = this.half;
    this.realSamples = 0;
    this.flushed = false;
  }

  push(input) {
    if (this.flushed) throw new Error("resampler was already flushed");
    if (input.length === 0) return new Float32Array();
    this.realSamples += input.length;
    this.buffer = concatenateFloat32(this.buffer, input);
    return this.consume(Number.POSITIVE_INFINITY);
  }

  flush() {
    if (this.flushed || this.realSamples === 0) return new Float32Array();
    this.flushed = true;
    const lastRealPosition = this.buffer.length - 1;
    this.buffer = concatenateFloat32(
      this.buffer,
      new Float32Array(this.half + Math.ceil(this.step) + 1),
    );
    return this.consume(lastRealPosition);
  }

  consume(maxPosition) {
    const output = [];
    while (
      this.position <= maxPosition
      && Math.floor(this.position) + this.half < this.buffer.length
    ) {
      const center = Math.floor(this.position);
      const fraction = this.position - center;
      const phase = Math.min(this.phases - 1, Math.floor(fraction * this.phases));
      const tableOffset = phase * this.taps;
      let value = 0;
      for (let tap = 0; tap < this.taps; tap += 1) {
        value += this.buffer[center + tap - this.half] * this.table[tableOffset + tap];
      }
      output.push(value);
      this.position += this.step;
    }
    const discard = Math.max(0, Math.floor(this.position) - this.half);
    if (discard > 0) {
      this.buffer = this.buffer.slice(discard);
      this.position -= discard;
    }
    return Float32Array.from(output);
  }
}

const WorkletProcessorBase = globalThis.AudioWorkletProcessor || class {};

// After the buffer runs dry mid-utterance, playback resumes only with this much audio queued (or after the tail wait,
// for a reply's last syllables). Resuming on each small packet made a jittery connection a string of tiny bursts:
// choppy, robotic voice. The Luna app and the iOS SDK use the same values.
export const RESTART_CUSHION_SECONDS = 0.16;
export const TAIL_START_SECONDS = 0.12;

export class Serve320PlaybackProcessor extends WorkletProcessorBase {
  constructor() {
    super();
    this.reset(0, false);
    this.port.onmessage = ({ data }) => {
      if (data.type === "load") {
        this.reset(data.epoch);
        this.enqueue(this.resampler.push(new Float32Array(data.samples)));
        this.enqueue(this.resampler.flush());
        this.final = true;
      } else if (data.type === "begin") {
        this.reset(data.epoch);
      } else if (data.type === "append" && data.epoch === this.epoch) {
        this.enqueue(this.resampler.push(new Float32Array(data.samples)));
      } else if (data.type === "finalize" && data.epoch === this.epoch) {
        this.finishUnderrun();
        this.enqueue(this.resampler.flush());
        this.final = true;
      } else if (data.type === "start" && data.epoch === this.epoch) {
        this.started = true;
        this.running = this.current.length > 0 || this.queue.length > 0;
        this.postTick();
      } else if (data.type === "pause" && data.epoch === this.epoch) {
        this.started = false;
        this.running = false;
        this.underrunDeviceSamples = 0;
      } else if (data.type === "clear") {
        this.reset(data.epoch);
      }
    };
  }

  reset(epoch, notify = true) {
    this.resampler = new BandlimitedResampler(24000, sampleRate);
    this.current = new Float32Array();
    this.queue = [];
    this.position = 0;
    this.playedDeviceSamples = 0;
    this.running = false;
    this.started = false;
    this.final = false;
    this.epoch = epoch;
    this.blocks = 0;
    this.drainedSent = false;
    this.bufferedDeviceSamples = 0;
    this.underrunDeviceSamples = 0;
    this.resumeWait = 0;
    this.underrunCount = 0;
    this.totalUnderrunSamples = 0;
    this.maxUnderrunSamples = 0;
    if (notify) this.postTick();
  }

  enqueue(samples) {
    if (samples.length === 0) return;
    this.bufferedDeviceSamples += samples.length;
    if (this.current.length === 0) this.current = samples;
    else this.queue.push(samples);
    if (this.started && !this.running) this.resume(false);
  }

  /** Starts playback at once unless it is recovering from an underrun without enough audio queued yet. */
  resume(force) {
    const cushion = RESTART_CUSHION_SECONDS * sampleRate;
    if (!force && this.underrunDeviceSamples > 0 && !this.final && this.bufferedDeviceSamples < cushion) return;
    this.finishUnderrun();
    this.running = true;
    this.resumeWait = 0;
  }

  bufferedSamples() {
    return Math.max(0, Math.floor(this.bufferedDeviceSamples * 24000 / sampleRate));
  }

  postTick() {
    this.port.postMessage({
      type: "tick",
      epoch: this.epoch,
      playedSamples: this.playedSamples(),
      bufferedSamples: this.bufferedSamples(),
      started: this.started,
      final: this.final,
    });
  }

  finishUnderrun() {
    if (this.underrunDeviceSamples <= 0) return;
    const durationSamples = Math.max(
      1,
      Math.floor(this.underrunDeviceSamples * 24000 / sampleRate),
    );
    this.underrunCount += 1;
    this.totalUnderrunSamples += durationSamples;
    this.maxUnderrunSamples = Math.max(this.maxUnderrunSamples, durationSamples);
    this.port.postMessage({
      type: "underrun",
      epoch: this.epoch,
      playedSamples: this.playedSamples(),
      bufferedSamples: this.bufferedSamples(),
      started: this.started,
      final: this.final,
      durationSamples,
    });
    this.underrunDeviceSamples = 0;
  }

  advanceChunk() {
    while (this.current.length > 0 && this.position >= this.current.length) {
      this.playedDeviceSamples += this.current.length;
      this.position = 0;
      this.current = this.queue.shift() || new Float32Array();
    }
    if (this.current.length === 0 && this.queue.length > 0) {
      this.current = this.queue.shift();
    }
    return this.current.length > 0;
  }

  playedSamples() {
    const deviceSamples = this.playedDeviceSamples
      + Math.min(this.current.length, Math.floor(this.position));
    return Math.floor(deviceSamples * 24000 / sampleRate);
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    output.fill(0);
    let written = 0;
    if (this.running) {
      for (; written < output.length; written += 1) {
        if (!this.advanceChunk()) {
          this.running = false;
          break;
        }
        output[written] = this.current[this.position++];
      }
    }
    this.bufferedDeviceSamples = Math.max(0, this.bufferedDeviceSamples - written);
    if (this.started && !this.final && written < output.length) {
      this.underrunDeviceSamples += output.length - written;
    }
    // Audio is waiting for the cushion after an underrun: a short tail plays after TAIL_START_SECONDS anyway.
    if (this.started && !this.running && this.bufferedDeviceSamples > 0) {
      this.resumeWait = (this.resumeWait || 0) + output.length;
      if (this.resumeWait >= TAIL_START_SECONDS * sampleRate) this.resume(true);
    }
    this.advanceChunk();
    this.blocks += 1;
    if (this.blocks % 4 === 0) this.postTick();
    if (!this.running && this.final && this.current.length === 0
        && this.queue.length === 0 && !this.drainedSent) {
      this.drainedSent = true;
      this.port.postMessage({
        type: "drained",
        epoch: this.epoch,
        playedSamples: this.playedSamples(),
        bufferedSamples: 0,
        started: this.started,
        final: true,
        underrunCount: this.underrunCount,
        totalUnderrunSamples: this.totalUnderrunSamples,
        maxUnderrunSamples: this.maxUnderrunSamples,
      });
    }
    return true;
  }
}

if (typeof registerProcessor === "function") {
  registerProcessor("serve320-playback", Serve320PlaybackProcessor);
}
