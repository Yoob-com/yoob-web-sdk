/**
 * What the renderer is actually doing, once a second.
 *
 * Every rendering judgement on this project has been made by eye — the character "jumps", the big packs "jitter", a
 * shorter lookahead "felt worse". Two of those turned out to be about the pack rather than the engine, which took a
 * day and a revert to establish. These are the numbers that would have said so in a minute.
 *
 * The collector is only constructed when stats are asked for, and nothing on the hot path allocates: counters are
 * added to and read back once per window.
 */

/** One second of the renderer's life. Rates are per second; durations are means over the window. */
export interface YoobStats {
  /** Canvas draws per second — the animation frame loop, so near the display's refresh rate when all is well. */
  drawFps: number;
  /** Frames the renderer produced per second. 25 is real time. */
  frameFps: number;
  /**
   * How often the mouth itself is redrawn, per second.
   *
   * Not the same as `frameFps`: on a 576px pack the renderer runs every other frame and the previous mouth is reused
   * in between, so the head keeps moving at 25 while the lips move at 12.5. That is deliberate, and it is the first
   * thing to check when the mouth looks steppy.
   */
  lipFps: number;
  /** Frames rendered but not yet drawn. Falling to zero mid-sentence is the renderer failing to keep up. */
  queued: number;
  /**
   * Draws where the frame for the current audio position had not been rendered yet, so the last one stayed on screen.
   *
   * This is the stutter, counted. Nothing reported it before: the draw is simply skipped and the canvas holds its
   * previous picture, which looks like the character freezing mid-word and is indistinguishable by eye from the
   * renderer being slow.
   */
  heldFrames: number;
  /** Frames rendered and then discarded unplayed, because the audio clock passed them before they were drawn. */
  droppedFrames: number;
  /**
   * How far ahead of the voice the rendered frames run, in frames.
   *
   * Two frames is 80 ms, which the engine already treats as the edge of acceptable audio/visual offset. Negative
   * means the mouth is behind the voice.
   */
  renderLead: number;
  /** Batches that produced nothing because not enough audio had arrived yet: starved rather than slow. */
  waitingBatches: number;
  /** Audio buffered ahead of the playhead. This is the cushion that stops the voice breaking up. */
  audioBufferedMs: number;
  /** Times playback ran dry in this window, and for how long in total. Any at all is audible. */
  underruns: number;
  underrunMs: number;
  /** Mean time per frame inside the two models. */
  encoderMs: number;
  rendererMs: number;
  /** Mean time to get one host picture: a JPEG decode, or a frame out of the host video. */
  hostMs: number;
  /** Audio appended → the frame for it drawn. How far behind the voice the mouth is running. */
  lipLatencyMs?: number;
  /** The first audio of a reply → the first sound heard. How long the character takes to answer. */
  replyLatencyMs?: number;
  /**
   * Which of the two start gates was last to clear, the last time playback began.
   *
   * `audio` means it waited for the PCM cushion — the network was the slow part. `frames` means it waited for the
   * renderer. They look identical to a listener and have opposite fixes.
   */
  startGate?: "audio" | "frames";
  /** Which backend the renderer actually got. It asks for WebGPU and silently falls back to wasm. */
  backend?: string;
  character?: string;
  version?: string;
  /** The canvas the pack renders at, e.g. "1080x1920". */
  size?: string;
}

/** A mean that costs two numbers rather than an array. */
class Mean {
  private total = 0;
  private count = 0;
  add(value: number): void {
    this.total += value;
    this.count += 1;
  }
  take(): number {
    const mean = this.count ? this.total / this.count : 0;
    this.total = 0;
    this.count = 0;
    return mean;
  }
}

/**
 * Accumulates what the pipeline reports and hands back a snapshot per window.
 *
 * Counters reset on `sample()`, so a rate is "since you last asked" rather than since the session began — which is
 * what makes a stall visible instead of averaging it away.
 */
export class StatsCollector {
  private draws = 0;
  private frames = 0;
  private lipFrames = 0;
  private readonly encoder = new Mean();
  private readonly renderer = new Mean();
  private readonly host = new Mean();
  private readonly lip = new Mean();
  private underruns = 0;
  private underrunMs = 0;
  private held = 0;
  private dropped = 0;
  private waiting = 0;
  private renderLead = 0;
  private startGate?: "audio" | "frames";
  private queued = 0;
  private audioBufferedMs = 0;
  private replyLatencyMs?: number;
  private backend?: string;
  private character?: string;
  private version?: string;
  private size?: string;
  private windowStart = performance.now();

  /** When the current reply's audio first arrived, so the first sound can be measured against it. */
  private replyAudioAt?: number;

  noteDraw(): void { this.draws += 1; }
  noteFrame(): void { this.frames += 1; }
  /** How many of a batch's frames actually ran the renderer rather than reusing the last mouth. */
  noteLipFrames(count: number): void { this.lipFrames += count; }
  noteQueue(depth: number): void { this.queued = depth; }
  /** A draw found no frame for the current audio position. */
  noteHeld(): void { this.held += 1; }
  /** A rendered frame was released without ever being drawn. */
  noteDropped(count = 1): void { this.dropped += count; }
  /** A batch came back empty because the audio for it had not arrived. */
  noteWaiting(): void { this.waiting += 1; }
  noteRenderLead(frames: number): void { this.renderLead = frames; }
  noteStartGate(gate: "audio" | "frames"): void { this.startGate = gate; }
  noteAudioBuffered(ms: number): void { this.audioBufferedMs = ms; }
  noteUnderrun(ms: number): void {
    this.underruns += 1;
    this.underrunMs += ms;
  }
  noteLipLatency(ms: number): void { this.lip.add(ms); }
  noteInference(encoderMs: number, rendererMs: number, hostMs: number): void {
    if (encoderMs > 0) this.encoder.add(encoderMs);
    if (rendererMs > 0) this.renderer.add(rendererMs);
    if (hostMs > 0) this.host.add(hostMs);
  }
  noteBackend(backend: string): void { this.backend = backend; }
  describe(character: string, version: string, width: number, height: number): void {
    this.character = character;
    this.version = version;
    this.size = `${width}x${height}`;
  }

  /** A reply's audio started arriving. The next sound heard measures the answer's latency. */
  noteReplyAudio(at = performance.now()): void {
    this.replyAudioAt ??= at;
  }
  /** The first sound of that reply reached the speakers. */
  noteReplyHeard(at = performance.now()): void {
    if (this.replyAudioAt === undefined) return;
    this.replyLatencyMs = at - this.replyAudioAt;
    this.replyAudioAt = undefined;
  }
  /** The reply ended, so the next one is measured afresh. */
  noteReplyEnded(): void { this.replyAudioAt = undefined; }

  /** The window's numbers, and the start of a new window. */
  sample(now = performance.now()): YoobStats {
    const seconds = Math.max(0.001, (now - this.windowStart) / 1000);
    this.windowStart = now;
    const lip = this.lip.take();
    const stats: YoobStats = {
      drawFps: this.draws / seconds,
      frameFps: this.frames / seconds,
      lipFps: this.lipFrames / seconds,
      queued: this.queued,
      heldFrames: this.held,
      droppedFrames: this.dropped,
      renderLead: this.renderLead,
      waitingBatches: this.waiting,
      audioBufferedMs: this.audioBufferedMs,
      underruns: this.underruns,
      underrunMs: this.underrunMs,
      encoderMs: this.encoder.take(),
      rendererMs: this.renderer.take(),
      hostMs: this.host.take(),
      ...(lip > 0 ? { lipLatencyMs: lip } : {}),
      ...(this.startGate ? { startGate: this.startGate } : {}),
      ...(this.replyLatencyMs !== undefined ? { replyLatencyMs: this.replyLatencyMs } : {}),
      ...(this.backend ? { backend: this.backend } : {}),
      ...(this.character ? { character: this.character } : {}),
      ...(this.version ? { version: this.version } : {}),
      ...(this.size ? { size: this.size } : {}),
    };
    this.draws = 0;
    this.frames = 0;
    this.lipFrames = 0;
    this.underruns = 0;
    this.underrunMs = 0;
    this.held = 0;
    this.dropped = 0;
    this.waiting = 0;
    return stats;
  }
}
