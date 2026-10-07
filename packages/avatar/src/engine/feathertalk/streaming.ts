// StreamingAvatar (language-companions AvatarRuntime/StreamingAvatar.swift): 16 kHz audio in, lip crops out, one per
// 40 ms frame, each with the host frame of the head path, the silence mix and the blink it is composed with. The
// encoder and renderer are injected (`LipModels`), so the scheduling here is the app's own, testable without a GPU.
import { HostPath } from "./host-path";
import { IdleBlinkSchedule, SPEECH_BLINK_CELL_SECONDS, SpeechBlinkGate } from "./blink";
import { type CalmHostWindow, LipWindows } from "./pack";

export interface LipModels {
  /** Features of audio frames (16 kHz samples, frameCount x 640 + 80): frameCount x 2 x 1024 floats. */
  encode(samples: Float32Array, frameCount: number): Promise<Float32Array>;
  /** Several windows of one length at once (the same features as one `encode` each); optional. */
  encodeBatch?(windows: Float32Array[], frameCount: number): Promise<Float32Array[]>;
  /** The lip crop (BGR bytes, output x output) for `window` (40 x 1024) over host `host`. */
  render(window: Float32Array, host: number): Promise<Uint8Array>;
}

export type StandIn = "silence" | "mirror";

export interface EarlyDrawing { lookaheadFrames: number; batchFrames: number; standIn: StandIn }

export interface SpeechBlinkSet { sequence: number[]; schedule: IdleBlinkSchedule }

/** Everything the compose of one frame needs. */
export interface FrameJob {
  /** Segment-local frame. */
  frame: number;
  /** The model's crop (BGR); empty when the face square is the host's own picture (`raw` 1). */
  crop: Uint8Array;
  host: number;
  prefetch: number[];
  blink: number | undefined;
  /** How much of the face square is the host frame's own picture. */
  raw: number;
  /** Whether the call screen should keep showing speech (false: hand over to the still idle face). */
  holdsSpeech: boolean;
  seal: number;
}

export interface StreamingStats {
  encodeMs: number; encodes: number; standInEncodes: number; renderMs: number; renders: number; samplesIn: number;
}

const FEATURE = 2048;
const WINDOW = 40 * 1024;

export class StreamingAvatar {
  static readonly sealFrames = 4;
  static readonly releaseFrames = 2;
  static readonly blinkSpacingFrames = 50;
  static readonly sourceBlinkSpacingFrames = 50;
  static readonly resumeHoldFrames = SpeechBlinkGate.holdFrames;
  static readonly maxBufferedCrops = 150;
  static readonly minBufferedCrops = 125;
  /** Whether the seal closes over `sealFrames` from the frame before (iOS `rampsSeal`). */
  rampsSeal = true;

  readonly stats: StreamingStats = { encodeMs: 0, encodes: 0, standInEncodes: 0, renderMs: 0, renders: 0, samplesIn: 0 };
  private epoch = 0;
  private samples = new Float32Array(0);
  private sampleBase = 0;
  private rmsCursor = 0;
  private silenceStarts: number[] = [];
  private nextFeature = 0;
  private nextFrame = 0;
  private features = new Map<number, Float32Array>();
  private crops = new Map<number, Uint8Array>();
  private presentedFrame = -1;
  segment = 0;
  private frameOffset = 0;
  private walker?: HostPath;
  private restartHost?: number;
  private hosts = new Map<number, number>();
  private weights = new Map<number, number>();
  private seals = new Map<number, number>();
  private previousSeal?: number;
  private blinks = new Map<number, number>();
  private blinkStart?: number;
  private blinkExtra = 0;
  private blinkPending = false;
  private lastBlink?: number;
  private heldRun = 0;
  private lastWindow?: Float32Array;
  private lastWeight = 0;
  private stallSteps = 0;
  private handoverHost?: number;
  private resumeHold = 0;
  private lastSourceBlink?: number;
  /** Each rendered frame's head path, window and seal, so a stall can start from any frame still held (`rewindTo`). */
  private snapshots = new Map<number, { walker: HostPath; window: Float32Array; weight: number }>();
  private readonly cropLimit: number;
  /** The call's lip shaping: articulation gain (1 = none). */
  articulationGain = 1;
  /** How many frames after a frame's own audio its seal is judged (the face's lip lead in frames). */
  silenceGateShiftFrames = 0;
  early: EarlyDrawing;
  /** Diagnostics: each frame's model crop as rendered. */
  onCrop?: (frame: number, crop: Uint8Array) => void;

  constructor(
    private readonly models: LipModels,
    readonly windows: LipWindows,
    private readonly calm: CalmHostWindow,
    private readonly closedAudio: Float32Array,
    private readonly blink: SpeechBlinkSet | undefined,
    outputBytes: number,
    early: EarlyDrawing,
  ) {
    const h08Bytes = 288 * 288 * 3;
    this.cropLimit = Math.max(StreamingAvatar.minBufferedCrops,
      Math.min(StreamingAvatar.maxBufferedCrops, Math.floor(StreamingAvatar.maxBufferedCrops * h08Bytes / Math.max(1, outputBytes))));
    this.early = { lookaheadFrames: Math.max(0, early.lookaheadFrames), batchFrames: Math.max(1, early.batchFrames), standIn: early.standIn };
    if (closedAudio.length !== WINDOW) throw new Error("closed audio window");
  }

  reset(): void {
    this.epoch += 1; this.samples = new Float32Array(0); this.sampleBase = 0; this.rmsCursor = 0;
    this.silenceStarts = []; this.nextFeature = 0; this.nextFrame = 0; this.features.clear(); this.crops.clear(); this.presentedFrame = -1;
    this.hosts.clear(); this.weights.clear(); this.seals.clear(); this.previousSeal = undefined; this.walker = undefined; this.restartHost = undefined;
    this.blinks.clear(); this.blinkStart = undefined; this.blinkExtra = 0; this.blinkPending = false; this.lastBlink = undefined;
    this.lastSourceBlink = undefined; this.heldRun = 0;
    this.lastWindow = undefined; this.lastWeight = 0; this.stallSteps = 0; this.handoverHost = undefined; this.resumeHold = 0;
    this.snapshots.clear();
  }

  /**
   * Stops rendering and makes `frame` the last rendered and presented frame (an interrupted reply's frame on screen), so
   * a stall walk (`stallImage`) carries on from it. Work in flight is cancelled.
   */
  rewindTo(frame: number): void {
    this.epoch += 1;
    const snapshot = this.snapshots.get(frame);
    if (snapshot && this.nextFrame > frame + 1) {
      this.walker = snapshot.walker.clone(); this.lastWindow = snapshot.window; this.lastWeight = snapshot.weight;
      this.previousSeal = snapshot.weight; this.nextFrame = frame + 1; this.blinkStart = undefined; this.blinkExtra = 0;
    }
    for (const map of [this.crops, this.weights, this.seals, this.hosts, this.blinks, this.snapshots] as Map<number, unknown>[]) {
      for (const key of [...map.keys()]) if (key > frame) map.delete(key);
    }
    this.presentedFrame = frame;
  }

  /** A new segment whose frame 0 is absolute call frame `frameOffset`; the head path carries on from `startHost`. */
  restart(segment: number, frameOffset: number, startHost?: number): void {
    this.reset(); this.segment = segment; this.frameOffset = Math.max(0, frameOffset); this.restartHost = startHost;
  }

  get producedThrough(): number { return this.nextFrame; }
  get received(): number { return this.sampleBase + this.samples.length; }
  oldestAvailableFrame(): number | undefined {
    let oldest: number | undefined;
    for (const key of this.crops.keys()) if (oldest === undefined || key < oldest) oldest = key;
    return oldest;
  }

  /** Appends 16 kHz samples and renders every frame they complete. Returns the last rendered frame. */
  async append(incoming: Float32Array): Promise<number> {
    this.stats.samplesIn += incoming.length;
    if (incoming.length > 32000 || !incoming.every(Number.isFinite)
        || this.sampleBase + this.samples.length + incoming.length > 1200 * 16000 + 16000
        || this.samples.length + incoming.length > 64000) throw new Error("invalid audio");
    const ticket = this.epoch;
    const joined = new Float32Array(this.samples.length + incoming.length);
    joined.set(this.samples); joined.set(incoming, this.samples.length);
    this.samples = joined;
    const available = this.sampleBase + this.samples.length;
    while ((this.rmsCursor + 1) * 640 <= available) {
      const start = this.rmsCursor * 640 - this.sampleBase;
      let power = 0;
      for (let i = start; i < start + 640; i += 1) power += this.samples[i] * this.samples[i];
      const db = 20 * Math.log10(Math.sqrt(power / 640 + 1e-12) + 1e-9);
      const previous = this.silenceStarts.length ? this.silenceStarts[this.silenceStarts.length - 1] : -1;
      this.silenceStarts.push(db < -40 ? (previous >= 0 ? previous : this.rmsCursor) : -1);
      this.rmsCursor += 1;
    }
    for (;;) {
      const { low, high, first, last } = this.windows.encode(this.nextFeature);
      if (available < high * 640 + 80) break;
      const segment = LipWindows.window(this.samples, this.sampleBase, low, high);
      // iOS encodes this window while the renderer draws the next ready frame; ONNX Runtime Web runs one model at a
      // time, so here the frame is drawn first (the results do not depend on the order).
      if (this.nextFrame + this.windows.lookahead < this.nextFeature) await this.renderNext(ticket);
      const started = performance.now();
      const encoded = await this.models.encode(segment, high - low);
      this.stats.encodeMs += performance.now() - started; this.stats.encodes += 1;
      if (this.epoch !== ticket) throw new CancelledError();
      for (let frame = first; frame < last; frame += 1) {
        const start = (frame - low) * FEATURE;
        this.features.set(frame, encoded.slice(start, start + FEATURE));
      }
      this.nextFeature = last;
      await this.renderReady(ticket);
    }
    const drawable = Math.floor(available / 640) - 1 - this.early.lookaheadFrames;
    if (this.early.lookaheadFrames < this.windows.fullLookaheadFrames && drawable - this.nextFrame + 1 >= this.early.batchFrames
        && drawable < this.silenceStarts.length) {
      await this.renderWithStandIns(drawable, ticket);
    }
    const retainFrom = Math.max(0, this.nextFeature - this.windows.left) * 640;
    if (retainFrom > this.sampleBase) {
      this.samples = this.samples.slice(retainFrom - this.sampleBase);
      this.sampleBase = retainFrom;
    }
    return this.nextFrame - 1;
  }

  /** Renders every frame whose own audio has arrived, the rest of each window stood in (a reply's end). */
  async flushTail(): Promise<number> {
    const available = this.sampleBase + this.samples.length, lastFrame = Math.floor(available / 640) - 1;
    if (lastFrame < this.nextFrame || lastFrame >= this.silenceStarts.length) return this.nextFrame - 1;
    await this.renderWithStandIns(lastFrame, this.epoch);
    return this.nextFrame - 1;
  }

  static padded(samples: Float32Array, count: number, standIn: StandIn): Float32Array {
    if (count <= 0) return samples;
    const out = new Float32Array(samples.length + count);
    out.set(samples);
    if (standIn === "mirror") {
      for (let i = 0; i < count; i += 1) {
        const source = samples.length - 1 - i;
        out[samples.length + i] = source >= 0 ? samples[source] : 0;
      }
    }
    return out;
  }

  private async renderWithStandIns(lastFrame: number, ticket: number): Promise<void> {
    const available = this.sampleBase + this.samples.length;
    const through = lastFrame + this.windows.lookahead;
    const padded = StreamingAvatar.padded(this.samples,
      Math.max(0, (through + 1 + this.windows.right) * 640 + 80 - available), this.early.standIn);
    // The stand-in features' windows, grouped by length: each group is one encoder call when the encoder takes a batch
    // (the same features as one call per window).
    const jobs: { low: number; high: number; first: number; last: number; window: Float32Array }[] = [];
    for (let feature = this.nextFeature; feature <= through;) {
      const range = this.windows.encode(feature);
      jobs.push({ ...range, window: LipWindows.window(padded, this.sampleBase, range.low, range.high) });
      feature = range.last;
    }
    for (let start = 0; start < jobs.length;) {
      const frames = jobs[start].high - jobs[start].low;
      let end = start + 1;
      while (end < jobs.length && jobs[end].high - jobs[end].low === frames) end += 1;
      const group = jobs.slice(start, end);
      const started = performance.now();
      const encoded = this.models.encodeBatch && group.length > 1
        ? await this.models.encodeBatch(group.map((job) => job.window), frames)
        : await this.encodeEach(group.map((job) => job.window), frames);
      this.stats.encodeMs += performance.now() - started; this.stats.encodes += 1; this.stats.standInEncodes += group.length;
      if (this.epoch !== ticket) throw new CancelledError();
      group.forEach((job, index) => {
        for (let frame = job.first; frame < job.last; frame += 1) {
          const at = (frame - job.low) * FEATURE;
          this.features.set(frame, encoded[index].slice(at, at + FEATURE));
        }
      });
      start = end;
    }
    while (this.nextFrame <= lastFrame) await this.renderNext(ticket);
  }

  private async encodeEach(windows: Float32Array[], frames: number): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const window of windows) out.push(await this.models.encode(window, frames));
    return out;
  }

  private async renderReady(ticket: number): Promise<void> {
    while (this.nextFrame + this.windows.lookahead < this.nextFeature) await this.renderNext(ticket);
  }

  private async renderNext(ticket: number): Promise<void> {
    if (this.crops.size >= this.cropLimit) {
      const keepFrom = this.nextFrame - Math.floor(this.cropLimit * 4 / 5);
      for (const map of [this.crops, this.weights, this.seals, this.hosts, this.blinks] as Map<number, unknown>[]) {
        for (const key of [...map.keys()]) if (key < keepFrom) map.delete(key);
      }
    }
    const window = new Float32Array(WINDOW);
    const past = this.windows.past;
    const present: boolean[] = new Array(past + this.windows.lookahead + 1).fill(false);
    for (let relative = -past; relative <= this.windows.lookahead; relative += 1) {
      const feature = this.features.get(this.nextFrame + relative);
      if (feature) { window.set(feature, (relative + past) * FEATURE); present[relative + past] = true; }
    }
    const weight = this.rampedSeal(this.gatedSilenceWeight(this.nextFrame), this.previousSeal);
    this.previousSeal = weight;
    if (weight > 0) {
      const closed = this.closedAudio;
      for (let i = 0; i < WINDOW; i += 1) window[i] = Math.fround(Math.fround((1 - weight) * window[i]) + Math.fround(weight * closed[i]));
    }
    this.shape(window, present);
    const frame = this.nextFrame;
    const calm = this.calm;
    const walk = this.walker ?? new HostPath(calm, this.restartHost ?? calm.pathStart, this.restartHost !== undefined);
    this.stallSteps = 0;
    let next: number;
    if (this.resumeHold > 0 && this.handoverHost !== undefined) {
      next = this.handoverHost; this.resumeHold -= 1;
      if (this.resumeHold === 0) this.handoverHost = undefined;
    } else {
      next = walk.next(weight < 1);
    }
    this.walker = walk; this.hosts.set(frame, next);
    const raw = calm.isClosedLips(next) ? weight : 0;
    this.heldRun += 1;
    const picture = this.blinkPicture(frame, next, walk);
    if (picture !== undefined) this.blinks.set(frame, picture);
    const started = performance.now();
    const crop = raw >= 1 ? new Uint8Array(0) : await this.models.render(window, next);
    if (raw < 1) { this.stats.renderMs += performance.now() - started; this.stats.renders += 1; }
    if (this.epoch !== ticket) throw new CancelledError();
    if (crop.length) this.onCrop?.(frame, crop);
    this.crops.set(frame, crop); this.weights.set(frame, raw); this.seals.set(frame, weight); this.nextFrame += 1;
    this.lastWindow = window; this.lastWeight = weight;
    this.snapshots.set(frame, { walker: walk.clone(), window, weight });
    for (const key of [...this.snapshots.keys()]) if (key < Math.max(this.presentedFrame - 16, frame - this.cropLimit)) this.snapshots.delete(key);
    for (const key of [...this.features.keys()]) if (key < this.nextFrame - past) this.features.delete(key);
  }

  /** LipShaping: closed + gain x (window - closed) on the slots that hold a feature. */
  private shape(window: Float32Array, present: boolean[]): void {
    const gain = Math.fround(Math.max(0.5, Math.min(2, this.articulationGain)));
    if (gain === 1) return;
    const closed = this.closedAudio, slot = window.length / present.length;
    for (let number = 0; number < present.length; number += 1) {
      if (!present[number]) continue;
      for (let i = number * slot; i < (number + 1) * slot; i += 1) {
        window[i] = Math.fround(closed[i] + Math.fround(gain * Math.fround(window[i] - closed[i])));
      }
    }
  }

  /** Takes `frame` for presenting: everything its compose needs; older frames are dropped. */
  take(frame: number): FrameJob | undefined {
    const crop = this.crops.get(frame);
    if (frame < 0 || frame < this.presentedFrame || !crop) return undefined;
    const host = this.hosts.get(frame)!;
    const prefetch = [1, 2].map((d) => this.hosts.get(frame + d)).filter((h): h is number => h !== undefined);
    const job: FrameJob = {
      frame, crop, host, prefetch, blink: this.blinks.get(frame), raw: this.weights.get(frame) ?? 0, holdsSpeech: true,
      seal: this.seals.get(frame) ?? 0,
    };
    this.presentedFrame = frame;
    for (const map of [this.crops, this.hosts, this.weights, this.seals, this.blinks] as Map<number, unknown>[]) {
      for (const key of [...map.keys()]) if (key < frame) map.delete(key);
    }
    return job;
  }

  /** The newest rendered frame at or before `frame` still held, for presenting when `frame` is not ready. */
  newestReadyAtOrBefore(frame: number): number | undefined {
    let best: number | undefined;
    for (const key of this.crops.keys()) if (key <= frame && key >= this.presentedFrame && (best === undefined || key > best)) best = key;
    return best;
  }

  private blinkPicture(frame: number, host: number, walker: HostPath): number | undefined {
    const blink = this.blink, calm = this.calm;
    if (!blink) return undefined;
    if (this.blinkStart !== undefined) {
      const step = frame - this.blinkStart + this.blinkExtra;
      if (step < blink.sequence.length) return blink.sequence[step];
      this.blinkStart = undefined; this.blinkExtra = 0;
    }
    const step = blink.schedule.stepSeconds;
    if (blink.schedule.blinkStarts((frame + this.frameOffset) * step, step)
        && (this.lastSourceBlink === undefined || frame - this.lastSourceBlink >= StreamingAvatar.sourceBlinkSpacingFrames)) {
      this.blinkPending = true;
    }
    if (calm.closedEyes(host) !== undefined) { this.blinkPending = false; this.lastSourceBlink = frame; }
    if (!this.blinkPending) return undefined;
    if (this.lastBlink !== undefined && frame - this.lastBlink < StreamingAvatar.blinkSpacingFrames) { this.blinkPending = false; return undefined; }
    const flags = Array.from({ length: blink.sequence.length - 1 }, (_, i) => this.gatedSilenceWeight(frame + i + 1) < 1);
    const through = [host, ...walker.ahead(blink.sequence.length - 1, flags)];
    if (!SpeechBlinkGate.allows(this.heldRun, through, calm, blink.sequence.length)) return undefined;
    this.blinkPending = false; this.blinkStart = frame; this.lastBlink = frame;
    return blink.sequence[0];
  }

  private frozenBlinkPicture(frame: number, host: number): number | undefined {
    const blink = this.blink;
    if (!blink || this.blinkStart === undefined) return undefined;
    const step = frame - this.blinkStart + this.blinkExtra + 1;
    if (!(step < blink.sequence.length && this.calm.isBlinkable(host))) { this.blinkStart = undefined; this.blinkExtra = 0; return undefined; }
    this.blinkExtra += 1;
    return blink.sequence[step];
  }

  /**
   * The next picture of a stall walk after `frame` (the last rendered and presented): the head walks on as in silence
   * while the lips close, until it reaches a home pose with the lips closed (`holdsSpeech` false: hand over to the idle
   * face). Undefined when the stall cannot go on.
   */
  async stallImage(frame: number): Promise<FrameJob | undefined> {
    const walk = this.walker, window = this.lastWindow;
    if (!(frame === this.presentedFrame && this.nextFrame === frame + 1 && walk && window && this.stallSteps < HostPath.stallFramesLimit)) return undefined;
    const ticket = this.epoch, calm = this.calm;
    const host = walk.next(false, true), closed = HostPath.stallLipsClosed(this.stallSteps, this.lastWeight);
    const holding = HostPath.holdsStalledSpeech(host, closed, calm);
    const toward = this.lastWeight < 1 ? (closed - this.lastWeight) / (1 - this.lastWeight) : 1;
    const shaped = window.slice();
    if (toward > 0) {
      for (let i = 0; i < WINDOW; i += 1) shaped[i] = Math.fround(Math.fround((1 - toward) * shaped[i]) + Math.fround(toward * this.closedAudio[i]));
    }
    this.stallSteps += 1;
    if (!holding) { this.heldRun = 0; this.handoverHost = host; this.resumeHold = StreamingAvatar.resumeHoldFrames; }
    const ahead = walk.clone(); const prefetch = [ahead.next(false, true), ahead.next(false, true)];
    const raw = calm.isClosedLips(host) ? closed : 0;
    const crop = raw >= 1 ? new Uint8Array(0) : await this.models.render(shaped, host);
    if (this.epoch !== ticket) throw new CancelledError();
    const blink = this.frozenBlinkPicture(frame, host);
    return { frame, crop, host, prefetch, blink, raw, holdsSpeech: holding, seal: closed };
  }

  /** The renderer's audio window of a frame still held (diagnostics and parity dumps). */
  windowOf(frame: number): Float32Array | undefined { return this.snapshots.get(frame)?.window; }

  /** The host the head is on (the last frame drawn), for a restart. */
  get currentHost(): number | undefined { return this.walker?.host; }

  rampedSeal(target: number, previous: number | undefined): number {
    if (!this.rampsSeal || previous === undefined || !(target > previous)) return target;
    return Math.min(target, Math.fround(previous + 1 / StreamingAvatar.sealFrames));
  }

  private gatedSilenceWeight(frame: number): number {
    const shift = this.silenceGateShiftFrames;
    if (!(shift > 0) || this.silenceStarts.length === 0) return this.silenceWeight(frame);
    return this.silenceWeight(Math.min(frame + shift, this.silenceStarts.length - 1));
  }

  private silenceWeight(frame: number): number {
    const starts = this.silenceStarts;
    if (!(frame >= 0 && frame < starts.length && starts[frame] >= 0)) return 0;
    const start = starts[frame];
    if (!(start + 4 < starts.length && starts[start + 4] === start)) return 0;
    let weight = start === 0 ? 1 : Math.min(1, Math.fround((frame - start + 1) / StreamingAvatar.sealFrames));
    for (let distance = 1; distance <= StreamingAvatar.releaseFrames && frame + distance < starts.length; distance += 1) {
      if (starts[frame + distance] < 0) { weight = Math.min(weight, Math.fround(distance / StreamingAvatar.releaseFrames)); break; }
    }
    return weight;
  }
}

export class CancelledError extends Error {
  constructor() { super("cancelled"); this.name = "CancelledError"; }
}

export function speechBlinkSet(sequence: number[]): SpeechBlinkSet {
  const schedule = new IdleBlinkSchedule(sequence);
  schedule.cellSeconds = SPEECH_BLINK_CELL_SECONDS;
  return { sequence, schedule };
}
