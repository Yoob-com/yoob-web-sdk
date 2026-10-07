// The page side of the FeatherTalk engine: plays the voice and tells the worker where the audio is. A direct-WebRTC
// style "instant lips" playout, as the Luna app does for these faces (LipTiming.InstantLips): the voice is heard
// `voiceDelayMs` after its first packet arrives and never waits for the face; each lip frame is shown at its audio's
// time on the audible clock (minus the face's lip lead), cross-faded at the display's rate.
import type { ConversationAudio, PlaybackTick } from "../audio/conversation-audio";
import type { FTMainToWorker, FTStats, FTWorkerToMain, FeatherTalkOptions, PackSource } from "./protocol";

export interface FeatherTalkCallbacks {
  onReady?: (info: Extract<FTWorkerToMain, { type: "ready" }>) => void;
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
  onPlaybackStarted?: (utterance: number) => void;
  onPlaybackEnded?: (utterance: number) => void;
  onIdle?: () => void;
  onError?: (message: string) => void;
  onCapture?: (capture: Extract<FTWorkerToMain, { type: "capture" }>) => void;
}

export class FeatherTalkCoordinator {
  private readonly worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "feathertalk" });
  private utterance = 0;
  private responseId?: string;
  private final = false;
  private started = false;
  private startTimer = 0;
  private playedSamples = 0;
  private voiceDelayMs = 110;
  private ready?: Promise<void>;
  private statsWaiters: ((stats: FTStats) => void)[] = [];
  private offlineDone?: (result: { frames: number; stats: FTStats }) => void;
  /** Bytes of the pack downloaded so far, as the worker loads it. */
  onProgress?: (loadedBytes: number, totalBytes: number) => void;

  constructor(
    private readonly canvas: HTMLCanvasElement | undefined,
    readonly audio: ConversationAudio,
    private readonly callbacks: FeatherTalkCallbacks = {},
  ) {
    this.worker.onerror = (event) => this.callbacks.onError?.(`feathertalk worker: ${event.message}`);
    this.worker.onmessage = (event: MessageEvent<FTWorkerToMain>) => this.handle(event.data);
  }

  initialize(source: PackSource, options: FeatherTalkOptions): Promise<void> {
    this.ready ??= new Promise<void>((resolve, reject) => {
      const offscreen = this.canvas?.transferControlToOffscreen();
      const previous = this.callbacks.onReady, previousError = this.callbacks.onError;
      this.callbacks.onReady = (info) => {
        this.voiceDelayMs = info.voiceDelayMs; this.callbacks.onReady = previous; this.callbacks.onError = previousError;
        previous?.(info); resolve();
      };
      this.callbacks.onError = (message) => { this.callbacks.onError = previousError; previousError?.(message); reject(new Error(message)); };
      this.post({ type: "init", source, canvas: offscreen, options, timeOrigin: performance.timeOrigin }, offscreen ? [offscreen] : []);
    });
    return this.ready;
  }

  /** Same contract as the anime engine's coordinator: a new `responseId` starts an utterance; `final` ends it. */
  appendStreamingAudio(responseId: string, pcm: Int16Array, final = false): number {
    if (this.responseId !== responseId) this.begin(responseId);
    const utterance = this.utterance;
    if (pcm.length > 0 && !this.final) {
      this.audio.appendStream(pcm, utterance);
      const samples = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i += 1) samples[i] = pcm[i] / 32768;
      this.post({ type: "audio", utterance, samples }, [samples.buffer]);
      // Instant lips: the voice starts a fixed delay after its first packet arrived.
      if (!this.started && !this.startTimer) {
        this.startTimer = window.setTimeout(() => { this.startTimer = 0; void this.startPlayback(utterance); }, this.voiceDelayMs);
      }
    }
    if (final && !this.final) {
      this.final = true;
      this.audio.finalizeStream(utterance);
      this.post({ type: "end", utterance });
      if (!this.started && !this.startTimer) void this.startPlayback(utterance);
    }
    return utterance;
  }

  private begin(responseId: string): void {
    this.clearTimer();
    this.utterance += 1;
    this.responseId = responseId; this.final = false; this.started = false; this.playedSamples = 0;
    this.attachAudio();
    this.audio.beginStream(this.utterance);
    this.post({ type: "begin", utterance: this.utterance });
  }

  private async startPlayback(utterance: number): Promise<void> {
    if (utterance !== this.utterance || this.started) return;
    this.started = true;
    try {
      await this.audio.start(utterance);
      if (utterance === this.utterance) this.callbacks.onPlaybackStarted?.(utterance);
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error.message : String(error));
    }
  }

  /** The audible clock: the worklet's played samples, less the audio output path's latency. */
  private attachAudio(): void {
    this.audio.onPlaybackTick = (tick) => this.tick(tick);
    this.audio.onPlaybackDrained = (tick) => {
      this.tick(tick);
      if (tick.epoch !== this.utterance) return;
      this.post({ type: "drained", utterance: tick.epoch });
      this.responseId = undefined;
      this.callbacks.onPlaybackEnded?.(tick.epoch);
    };
    this.audio.onPlaybackUnderrun = undefined;
  }

  private tick(tick: PlaybackTick): void {
    if (tick.epoch !== this.utterance) return;
    this.playedSamples = tick.playedSamples;
    const latency = Math.round(this.audio.outputLatencySeconds * 24_000);
    this.post({ type: "clock", utterance: tick.epoch, samples: tick.playedSamples - latency,
      at: performance.timeOrigin + performance.now(), started: tick.started });
  }

  cancel(): number {
    this.clearTimer();
    this.utterance += 1;
    this.responseId = undefined; this.final = false; this.started = false; this.playedSamples = 0;
    this.audio.clear(this.utterance);
    this.post({ type: "cancel" });
    return this.utterance;
  }

  /** How long the voice waits after its first packet before it plays (the pack's, raised when frames came late). */
  get voiceDelay(): number { return this.voiceDelayMs; }

  get playedAudioMs(): number { return Math.floor(this.playedSamples * 1000 / 24_000); }

  updateDownloadToken(downloadToken: string): void { this.post({ type: "grant", downloadToken }); }

  stats(): Promise<FTStats> {
    return new Promise((resolve) => { this.statsWaiters.push(resolve); this.post({ type: "stats" }); });
  }

  /** Offline (parity): `samples` (24 kHz) in packets of `packetSamples`, every frame composed and captured. */
  runOffline(samples: Int16Array, packetSamples: number): Promise<{ frames: number; stats: FTStats }> {
    return new Promise((resolve) => {
      this.offlineDone = resolve;
      this.utterance += 1;
      this.post({ type: "begin", utterance: this.utterance });
      for (let start = 0; start < samples.length; start += packetSamples) {
        const slice = samples.subarray(start, Math.min(samples.length, start + packetSamples));
        const floats = Float32Array.from(slice, (v) => v / 32768);
        this.post({ type: "audio", utterance: this.utterance, samples: floats }, [floats.buffer]);
      }
      this.post({ type: "end", utterance: this.utterance });
    });
  }

  destroy(): void {
    this.clearTimer();
    this.worker.terminate();
  }

  private clearTimer(): void { if (this.startTimer) { clearTimeout(this.startTimer); this.startTimer = 0; } }

  private post(message: FTMainToWorker, transfer: Transferable[] = []): void { this.worker.postMessage(message, transfer); }

  private handle(message: FTWorkerToMain): void {
    switch (message.type) {
      case "progress":
        this.callbacks.onProgress?.(message.loadedBytes, message.totalBytes); this.onProgress?.(message.loadedBytes, message.totalBytes);
        break;
      case "ready": this.callbacks.onReady?.(message); break;
      case "idle": this.callbacks.onIdle?.(); break;
      case "utterance":
        // As the app's VoiceDelayControl: when lip frames came late, later replies give the face more time (the voice
        // starts a step later), up to 300 ms.
        if (message.shown > 0 && message.late / message.shown > 0.02) this.voiceDelayMs = Math.min(300, this.voiceDelayMs + 40);
        break;
      case "capture": this.callbacks.onCapture?.(message); break;
      case "offline-done": this.offlineDone?.({ frames: message.frames, stats: message.stats }); break;
      case "stats": for (const waiter of this.statsWaiters.splice(0)) waiter(message.stats); break;
      case "error": this.callbacks.onError?.(message.message); break;
    }
  }
}
