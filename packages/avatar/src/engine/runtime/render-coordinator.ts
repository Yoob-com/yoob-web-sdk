import { ConversationAudio, type PlaybackTick } from "../audio/conversation-audio";
import type { RuntimeAssetConfig } from "../assets/runtime-store";
import { canonicalBlendRgba } from "../compositor/serve320-compositor";
import { LatencyTrace, type LatencyReport } from "./latency-trace";
import type {
  RendererInputType, RendererPreferredLayout, RendererSpatialContract,
} from "./generated/runtime-tier-contract";
import type { MainToWorker, RuntimePressureTrace, WorkerToMain } from "./protocol";
import type { NeuralMouthRenderStride } from "./render-cadence";
import type { RendererTemporalContract } from "./renderer-temporal";
import { StreamingRenderCreditQueue } from "./live-render-pressure";
import {
  hostFramesAdjacent,
  lipFramesAdjacent,
  resolveLipCadence,
  type LipCadence,
  type LipFadeCounts,
  type LipFadeKind,
  type Rect,
} from "./lip-fade";
import { LipFadeLayer } from "./lip-fade-layer";
import {
  StreamingPcmChunker,
  streamingBootstrapFrameCount,
} from "./stream-chunker";
import {
  STREAMING_PCM_START_RESERVE_MS,
  nextStreamingPcmStartReserveSamples,
  pcmSamplesForMs,
  streamingAudioStartReady,
  streamingPcmReserveEnabled,
} from "./stream-start-scheduler";

const FPS = 25;
const SAMPLES_PER_FRAME = 24_000 / FPS;
const NEUTRAL_HOST_TIME = 0.5 / FPS;
const MAX_HOST_AUDIO_SKEW_FRAMES = 2;
// 2 frames = 80 ms at 25 fps, under the ~100 ms audio/visual offset threshold.
const MAX_MOUTH_SUBSTITUTION_FRAMES = 2;
const HAVE_CURRENT_DATA = 2;
const MIN_RENDER_TIMING_SAMPLES = 16;
const MIN_RENDER_BUDGET_MS = 50;
const RENDER_BUDGET_HEADROOM = 1.15;
/**
 * Fast-path start when render is real-time capable (≤~frame duration).
 * On current WebGPU/WASM devices we often measure ~55 ms/frame, so streaming
 * uses adaptive prebuffer instead of this alone.
 */
export const STREAMING_START_FRAMES = 8;
/** Prior mean render cost (ms) until measured samples exist — matches device logs. */
const STREAMING_RENDER_PRIOR_MS = 56;
const PAUSE_LEAD_FRAMES = 2;
const RESUME_LEAD_FRAMES = 8;
const HOST_SYNC_RECOVERY_MISSES = 4;
const HOST_SYNC_RATE_GAIN = 0.125;
const MIN_HOST_PLAYBACK_RATE = 0.5;
const MAX_HOST_PLAYBACK_RATE = 1.5;

export function hostAudioFrameSkew(
  audioFrameIndex: number,
  presentedHostFrame: number,
  nIdle: number,
): number | undefined {
  if (audioFrameIndex < 0 || presentedHostFrame < 0 || nIdle <= 0) return undefined;
  const cycle = Math.round((audioFrameIndex - presentedHostFrame) / nIdle);
  return presentedHostFrame + cycle * nIdle - audioFrameIndex;
}

export function hostPlaybackRateForSkew(skewFrames: number): number {
  return Math.max(
    MIN_HOST_PLAYBACK_RATE,
    Math.min(MAX_HOST_PLAYBACK_RATE, 1 - skewFrames * HOST_SYNC_RATE_GAIN),
  );
}

export function synchronizedFrameIndex(
  audioFrameIndex: number,
  presentedHostFrame: number,
  nIdle: number,
  maxSkewFrames = MAX_HOST_AUDIO_SKEW_FRAMES,
): number | undefined {
  const skew = hostAudioFrameSkew(audioFrameIndex, presentedHostFrame, nIdle);
  if (skew === undefined || Math.abs(skew) > maxSkewFrames) return undefined;
  const candidate = audioFrameIndex + skew;
  return candidate >= 0 ? candidate : undefined;
}

export function contiguousFramePrefix(
  frames: ReadonlyMap<number, unknown>,
  frameCount: number,
): number {
  let prefix = 0;
  while (prefix < frameCount && frames.has(prefix)) prefix += 1;
  return prefix;
}

export function renderAheadFrameCount(
  frameCount: number,
  renderTimesMs: readonly number[],
): number {
  if (frameCount <= 0) return 0;
  if (frameCount < MIN_RENDER_TIMING_SAMPLES
      || renderTimesMs.length < MIN_RENDER_TIMING_SAMPLES) return frameCount;
  const sampleCount = MIN_RENDER_TIMING_SAMPLES;
  const measured = renderTimesMs.reduce((total, value) => total + value, 0)
    / renderTimesMs.length;
  const budgetMs = Math.max(
    MIN_RENDER_BUDGET_MS,
    measured * RENDER_BUDGET_HEADROOM,
  );
  const frameDurationMs = 1000 / FPS;
  const safetyFrames = Math.min(8, Math.max(3, Math.ceil(frameCount * 0.05)));
  const required = Math.ceil(frameCount * (1 - frameDurationMs / budgetMs))
    + safetyFrames;
  return Math.max(sampleCount, Math.min(frameCount, required));
}

/**
 * How many contiguous rendered frames must exist before streaming audio starts.
 *
 * At ~55 ms/frame (common on this stack) vs 40 ms/frame audio, starting after
 * only 8 frames underruns within ~0.5 s and pauses mid-word. When the renderer
 * is slower than real-time we:
 * - wait until enough buckets have been *enqueued* (frameCount large enough)
 * - require a larger rendered prefix sized from measured cost
 * - if still incomplete and short, return frameCount+1 to block start
 */
export function streamingStartFrameCount(
  frameCount: number,
  renderTimesMs: readonly number[] = [],
  renderComplete = false,
): number {
  if (frameCount <= 0) return 0;
  const frameDurationMs = 1000 / FPS;
  const measured = renderTimesMs.length >= 4
    ? renderTimesMs.reduce((total, value) => total + value, 0) / renderTimesMs.length
    : STREAMING_RENDER_PRIOR_MS;
  // Real-time capable: keep the short bootstrap start.
  if (measured <= frameDurationMs * 1.08) {
    return Math.min(frameCount, STREAMING_START_FRAMES);
  }
  // B >= F * (m - d) / m so remaining frames can finish before audio catches up.
  const ratio = Math.max(0, (measured - frameDurationMs) / measured);
  const forKnown = Math.ceil(frameCount * ratio)
    + Math.min(10, Math.max(4, Math.ceil(frameCount * 0.06)));
  // Rolling prebuffer ~0.9 s of play under measured deficit (avoids choppy pause).
  const rolling = Math.ceil(
    (900 / frameDurationMs) * (measured / frameDurationMs),
  );
  const floor = Math.max(16, Math.min(36, rolling));
  if (!renderComplete && frameCount < floor) {
    // Not enough of the utterance is known/enqueued yet — keep preparing.
    return frameCount + 1;
  }
  return Math.min(frameCount, Math.max(floor, forKnown));
}

export function sameDecodedVideoFrame(left: number, right: number): boolean {
  return Math.floor(left * FPS + 1e-4) === Math.floor(right * FPS + 1e-4);
}

/** Per-attempt seek budget. A backgrounded tab can defer decode well past this. */
const IDLE_SEEK_ATTEMPT_TIMEOUT_MS = 2_000;
/** Retry budget, counted only while the document is visible. */
const IDLE_SEEK_VISIBLE_DEADLINE_MS = 30_000;

/** Structural subset of `document` used for background-tab detection. */
export interface VisibilityDocument {
  readonly visibilityState: "visible" | "hidden";
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

const browserVisibilityDocument = (): VisibilityDocument | undefined => (
  typeof document !== "undefined" ? document : undefined
);

export function documentIsHidden(doc: VisibilityDocument | undefined): boolean {
  return doc?.visibilityState === "hidden";
}

/** Resolves immediately when visible, otherwise on the next visibilitychange. */
export function whenDocumentVisible(
  doc: VisibilityDocument | undefined,
): Promise<void> {
  if (!documentIsHidden(doc)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onVisibilityChange = () => {
      if (documentIsHidden(doc)) return;
      doc?.removeEventListener("visibilitychange", onVisibilityChange);
      resolve();
    };
    doc?.addEventListener("visibilitychange", onVisibilityChange);
  });
}

type DecodedFrameProbe = (video: HTMLVideoElement, time: number) => Promise<boolean>;

const browserDecodedFrameProbe: DecodedFrameProbe = async (video, time) => {
  if (!sameDecodedVideoFrame(video.currentTime, time)
      || video.readyState < HAVE_CURRENT_DATA
      || typeof createImageBitmap !== "function") return false;
  const bitmap = await createImageBitmap(video);
  bitmap.close();
  return sameDecodedVideoFrame(video.currentTime, time);
};

export async function seekDecodedVideoFrame(
  video: HTMLVideoElement,
  time: number,
  timeoutMs = 2_000,
  decodedFrameProbe: DecodedFrameProbe = browserDecodedFrameProbe,
  doc: VisibilityDocument | undefined = browserVisibilityDocument(),
): Promise<number> {
  video.pause();
  if (!video.seeking
      && video.readyState >= HAVE_CURRENT_DATA
      && sameDecodedVideoFrame(video.currentTime, time)) {
    return video.currentTime;
  }
  return new Promise<number>((resolve, reject) => {
    let seekComplete = false;
    let lastMediaTime: number | undefined;
    let frameRequest = 0;
    let nudgeTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let nudgePauseTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let nudgedPlayback = false;
    let returningToTarget = false;
    let returnSeeked: (() => void) | undefined;
    // A hidden document still decodes and still fires `seeked`, but Chromium
    // suspends requestVideoFrameCallback and leaves the play() nudge pending.
    // Feature detection alone would pick a callback that never arrives, so
    // background tabs take the `seeked` + createImageBitmap probe path.
    const requestPresentedFrame = typeof video.requestVideoFrameCallback === "function"
        && !documentIsHidden(doc)
      ? () => {
        frameRequest = video.requestVideoFrameCallback((_now, metadata) => {
          lastMediaTime = metadata.mediaTime;
          if (seekComplete && sameDecodedVideoFrame(metadata.mediaTime, time)) {
            cleanup();
            resolve(metadata.mediaTime);
          } else {
            requestPresentedFrame?.();
          }
        });
      }
      : undefined;
    const timeout = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error(`Idle host seek timed out at ${time.toFixed(3)}s`));
    }, timeoutMs);
    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      if (nudgeTimer !== undefined) globalThis.clearTimeout(nudgeTimer);
      if (nudgePauseTimer !== undefined) globalThis.clearTimeout(nudgePauseTimer);
      if (frameRequest && typeof video.cancelVideoFrameCallback === "function") {
        video.cancelVideoFrameCallback(frameRequest);
      }
      if (nudgedPlayback) video.pause();
      video.removeEventListener("seeked", seeked);
      if (returnSeeked) video.removeEventListener("seeked", returnSeeked);
      video.removeEventListener("error", failed);
    };
    const seeked = () => {
      if (returningToTarget) return;
      seekComplete = true;
      if (!requestPresentedFrame) {
        void decodedFrameProbe(video, time).then((decoded) => {
          if (!decoded) return;
          cleanup();
          resolve(video.currentTime);
        }).catch(() => undefined);
      } else if (lastMediaTime !== undefined && sameDecodedVideoFrame(lastMediaTime, time)) {
        cleanup();
        resolve(lastMediaTime);
      } else if (typeof video.play === "function") {
        // Chromium may not issue requestVideoFrameCallback for a paused seek,
        // despite readyState already containing decoded data. Give the normal
        // paused path a moment, then briefly run the muted host until the exact
        // decoded frame is presented. The callback above pauses it immediately.
        nudgeTimer = globalThis.setTimeout(() => {
          nudgedPlayback = true;
          void video.play().then(() => {
            nudgePauseTimer = globalThis.setTimeout(() => {
              video.pause();
              nudgedPlayback = false;
              returningToTarget = true;
              returnSeeked = () => {
                returningToTarget = false;
                void decodedFrameProbe(video, time).then((decoded) => {
                  if (!decoded) return;
                  cleanup();
                  resolve(video.currentTime);
                }).catch(() => undefined);
              };
              video.addEventListener("seeked", returnSeeked, { once: true });
              video.currentTime = time;
            }, 80);
          }).catch(() => {
            void decodedFrameProbe(video, time).then((decoded) => {
              if (!decoded) return;
              cleanup();
              resolve(video.currentTime);
            }).catch(() => undefined);
          });
        }, 100);
      }
    };
    const failed = () => {
      cleanup();
      reject(new Error(`Idle host seek failed (media error ${video.error?.code || "unknown"})`));
    };
    video.addEventListener("seeked", seeked, { once: true });
    video.addEventListener("error", failed, { once: true });
    requestPresentedFrame?.();
    video.currentTime = time;
  });
}

/**
 * Seek that survives a backgrounded tab.
 *
 * Chromium defers media decode for hidden documents, so the idle `<video>` can
 * still be at `readyState === HAVE_NOTHING` long after `load()`. A single
 * 2 s seek therefore times out for any visitor who switches tabs during the
 * cold runtime download — previously a terminal "Runtime unavailable".
 *
 * A timeout is retryable; a media error is not. Time spent hidden is free, so
 * the deadline only advances while the document is visible.
 */
export async function seekDecodedVideoFrameWhenVisible(
  video: HTMLVideoElement,
  time: number,
  options: {
    attemptTimeoutMs?: number;
    visibleDeadlineMs?: number;
    decodedFrameProbe?: DecodedFrameProbe;
    doc?: VisibilityDocument;
    now?: () => number;
    onRetry?: (attempt: number, hidden: boolean) => void;
  } = {},
): Promise<number> {
  const {
    attemptTimeoutMs = IDLE_SEEK_ATTEMPT_TIMEOUT_MS,
    visibleDeadlineMs = IDLE_SEEK_VISIBLE_DEADLINE_MS,
    decodedFrameProbe = browserDecodedFrameProbe,
    doc = browserVisibilityDocument(),
    now = () => Date.now(),
    onRetry,
  } = options;
  let visibleElapsedMs = 0;
  let attempt = 0;
  for (;;) {
    const startedAt = now();
    try {
      return await seekDecodedVideoFrame(
        video, time, attemptTimeoutMs, decodedFrameProbe, doc,
      );
    } catch (error) {
      // A decode/media failure is terminal — retrying cannot recover it.
      if (video.error) throw error;
      attempt += 1;
      const hidden = documentIsHidden(doc);
      onRetry?.(attempt, hidden);
      if (hidden) {
        // Backgrounded: retry is free, and the next attempt should wait for
        // the document rather than spin against a suspended compositor.
        await whenDocumentVisible(doc);
        continue;
      }
      visibleElapsedMs += now() - startedAt;
      if (visibleElapsedMs >= visibleDeadlineMs) throw error;
    }
  }
}

/**
 * GPU composite path switch. `?gpublend=0` forces the canonical CPU blend so
 * the two can be A/B'd in one session (thermal state drifts enough between
 * runs that cross-session comparisons are not trustworthy), and so QA can
 * verify bit-exact output against the reference implementation.
 */
const GPU_BLEND_ENABLED = (() => {
  try {
    return new URLSearchParams(location.search).get("gpublend") !== "0";
  } catch {
    return true;
  }
})();

/**
 * Paint the idle host as soon as the 2.7 MB idle loop decodes, instead of
 * holding the canvas blank until the whole ~45 MB runtime has landed.
 *
 * `?earlypaint=0` restores the old behaviour so bytes-to-first-frame can be
 * A/B'd in one session, the same way `?gpublend=0` restores the CPU blend.
 */
const EARLY_HOST_PAINT = (() => {
  try {
    return new URLSearchParams(location.search).get("earlypaint") !== "0";
  } catch {
    return true;
  }
})();

/**
 * Field-only PCM reserve. The mechanism is banked in production source, but
 * the incumbent scheduler remains the default until authenticated A/B evidence
 * supports promotion. `?pcmreserve=1` enables the candidate in one session.
 */
const STREAMING_PCM_RESERVE_ENABLED = (() => {
  try {
    return streamingPcmReserveEnabled(location.search);
  } catch {
    return false;
  }
})();

interface RenderedFrame {
  index: number;
  box: [number, number, number, number];
  width: number;
  height: number;
  predBgr: Uint8Array;
  support: Float32Array;
  jawProtected: Uint8Array;
  /** GPU composite path; see protocol.ts. Undefined -> canonical CPU blend. */
  bitmap?: ImageBitmap;
}

export interface RenderCoordinatorCallbacks {
  onStatus?: (message: string) => void;
  onRuntimeEvent?: (event: Extract<WorkerToMain, { type: "status" }>) => void;
  /**
   * The idle host is on the canvas — the visitor can see the avatar. Fires long
   * before `onReady`, which additionally needs the models and banks.
   */
  onFirstHostFrame?: (msSincePageStart: number) => void;
  onReady?: () => void;
  onMetrics?: (message: string) => void;
  onPlaybackStarted?: (epoch: number) => void;
  onPlaybackEnded?: (epoch: number) => void;
  onError?: (message: string) => void;
  onLatency?: (summary: string) => void;
  /** Final, structured per-turn measurements for diagnostics and field capture. */
  onTurnTelemetry?: (report: LatencyReport) => void;
  onRuntimePressure?: (trace: LiveCallPressureTrace) => void;
}

export interface RenderPresentationOptions {
  /** How lip frames reach the screen; see lip-fade.ts. Default `blend`. */
  lipCadence?: LipCadence;
}

export interface LiveCallPressureTrace extends RuntimePressureTrace {
  pendingRenderWindows: number;
  inFlightRenderWindows: number;
  renderWindowLimit: number;
  renderedPrefix: number;
  audioFrame: number;
  renderLeadFrames: number;
}

interface PendingStreamingRender {
  chunkIndex: number;
  frameOffset: number;
  discardFrames: number;
  outputFrames: number;
  final: boolean;
  geometryFinal: boolean;
  bootstrap: boolean;
  modelPcm: Int16Array<ArrayBufferLike>;
}

export class RenderCoordinator {
  readonly audio = new ConversationAudio();
  readonly latency = new LatencyTrace();
  private readonly worker = new Worker(new URL("./pipeline-worker.ts", import.meta.url), {
    type: "module", name: "serve320-pipeline",
  });
  private readonly context: CanvasRenderingContext2D;
  private frames = new Map<number, RenderedFrame>();
  private pendingPcm?: Int16Array;
  private epoch = 0;
  private activeEpoch = 0;
  private playedSamples = 0;
  private audioStarted = false;
  private audioStarting = false;
  private audioPausedForRender = false;
  private audioResuming = false;
  private renderComplete = false;
  /** One "frames ran out" report per turn; see handlePlaybackTick. */
  private frameExhaustionLogged = false;
  private frameSubstitutionLogged = false;
  private renderedPrefix = 0;
  private renderTimesMs: number[] = [];
  private stream?: {
    responseId: string;
    chunker: StreamingPcmChunker;
    nextChunkIndex: number;
    queuedSamples: number;
    startReserveSamples: number;
    finalReceived: boolean;
    renderQueue: StreamingRenderCreditQueue<PendingStreamingRender>;
  };
  private streamingPcmStartReserveSamples = STREAMING_PCM_RESERVE_ENABLED
    ? pcmSamplesForMs(STREAMING_PCM_START_RESERVE_MS)
    : 0;
  private hasDrawnHostFrame = false;
  private animationRunning = false;
  /** performance.now() of the first host frame on the canvas; see draw(). */
  private firstHostFrameMs?: number;
  private frameCount = 0;
  private nIdle = 270;
  private animation = 0;
  private videoFrameRequest = 0;
  private presentedHostFrame = -1;
  private hostFrameDirty = true;
  private lastRenderedFrame = -1;
  /** Last audio-clock frame that was fully composited (skip duplicate rAFs). */
  private lastCompositedAudioFrame = -1;
  private lastRenderStatusMs = 0;
  /** When the current prebuffer window began (0 = not prebuffering). */
  private prebufferStartMs = 0;
  private meanRenderMs = 0;
  private initializationResolve?: () => void;
  private initializationReject?: (error: Error) => void;
  private initializationTimer = 0;
  private initializationTerminal = false;
  private hostSyncMisses = 0;
  /** Reused ImageData for the mouth ROI so getImageData can hit a stable path. */
  private mouthImageData?: ImageData;
  private mouthImageWidth = 0;
  private mouthImageHeight = 0;
  readonly lipCadence: LipCadence;
  /** The cross-fade between lip frames (`blend`); undefined draws exactly as 0.2 did (`step`). */
  private readonly lipFade?: LipFadeLayer;
  /** The lip frame on screen (blend bookkeeping), its mouth box and its host frame; -1 when the idle face shows. */
  private shownMouthFrame = -1;
  private shownMouthBox?: Rect;
  private shownHostFrame = -1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly idleVideo: HTMLVideoElement,
    private readonly callbacks: RenderCoordinatorCallbacks = {},
    presentation: RenderPresentationOptions = {},
  ) {
    const context = canvas.getContext("2d", {
      alpha: false, desynchronized: true, willReadFrequently: true,
    });
    if (!context) throw new Error("Canvas2D is unavailable");
    this.context = context;
    this.lipCadence = resolveLipCadence(presentation.lipCadence);
    if (this.lipCadence === "blend") this.lipFade = new LipFadeLayer(context);
    this.worker.onmessage = (event: MessageEvent<WorkerToMain>) => void this.handleWorker(event.data);
    this.worker.onerror = (event) => {
      const error = new Error(`pipeline worker: ${event.message}`);
      this.initializationReject?.(error);
      this.clearInitializationWaiter();
      this.callbacks.onError?.(error.message);
    };
    this.worker.onmessageerror = () => {
      const error = new Error("pipeline worker returned an unreadable message");
      this.initializationReject?.(error);
      this.clearInitializationWaiter();
      this.callbacks.onError?.(error.message);
    };
    this.audio.onPlaybackTick = (tick) => this.handlePlaybackTick(tick);
    this.audio.onPlaybackUnderrun = (underrun) => {
      if (underrun.epoch !== this.activeEpoch) return;
      this.latency.notePlaybackUnderrun(underrun.durationSamples);
    };
    this.audio.onPlaybackDrained = (tick) => {
      if (tick.epoch !== this.activeEpoch) return;
      this.handlePlaybackTick(tick);
      this.latency.mark("playback_end");
      const report = this.latency.report();
      if (this.stream && STREAMING_PCM_RESERVE_ENABLED) {
        this.streamingPcmStartReserveSamples = nextStreamingPcmStartReserveSamples(
          this.streamingPcmStartReserveSamples,
          report.playbackUnderrunCount,
        );
      }
      // Draw the terminal frame once, then release the mouth overlay and let
      // the neutral host resume. This also prevents post-turn seek thrash.
      this.draw();
      this.settleMouth();
      this.audioStarted = false;
      this.audioStarting = false;
      this.audioPausedForRender = false;
      this.audioResuming = false;
      this.pendingPcm = undefined;
      this.stream?.renderQueue.clear();
      this.stream = undefined;
      this.clearFrames();
      this.hostSyncMisses = 0;
      this.idleVideo.playbackRate = 1;
      this.callbacks.onTurnTelemetry?.(report);
      void this.resetNeutralHost(tick.epoch);
      this.callbacks.onPlaybackEnded?.(tick.epoch);
    };
  }

  async initialize(
    assets: RuntimeAssetConfig,
    neuralMouthStride: NeuralMouthRenderStride = 1,
    rendererInputType: RendererInputType = "float32",
    rendererPreferredLayout: RendererPreferredLayout = "NCHW",
    rendererSpatialContract?: RendererSpatialContract,
    rendererTemporalContract?: RendererTemporalContract,
  ): Promise<void> {
    this.initializationTerminal = false;
    const initialized = new Promise<void>((resolve, reject) => {
      this.initializationResolve = resolve;
      this.initializationReject = reject;
      this.initializationTimer = window.setTimeout(() => {
        const error = new Error(
          "Avatar initialization timed out after 180 seconds. Open diagnostics and retry.",
        );
        this.initializationTerminal = true;
        this.initializationReject?.(error);
        this.clearInitializationWaiter();
      }, 180_000);
    });
    try {
      this.post({
        type: "initialize",
        assets,
        neuralMouthStride,
        rendererInputType,
        rendererPreferredLayout,
        rendererSpatialContract,
        rendererTemporalContract,
      });
      this.idleVideo.muted = true;
      this.idleVideo.loop = true;
      this.idleVideo.playsInline = true;
      this.startPresentedFrameTracking();
      const mediaTime = await seekDecodedVideoFrameWhenVisible(
        this.idleVideo,
        NEUTRAL_HOST_TIME,
        {
          onRetry: (_attempt, hidden) => {
            this.callbacks.onStatus?.(hidden
              ? "Paused while the tab is in the background — reopen to continue"
              : "Waiting for the idle host video to decode…");
          },
        },
      );
      this.recordPresentedFrame(mediaTime);
      // First paint no longer waits for the runtime. `draw()` composites a mouth
      // only once `audioStarted` is true, so running the loop here paints the
      // neutral idle host and nothing else — the models and the 55 MB of banks
      // are still downloading behind it. Before this, the canvas stayed at the
      // #14121c placeholder until every byte of the runtime had landed.
      if (EARLY_HOST_PAINT) this.startAnimationLoop();
      await initialized;
      if (this.initializationTerminal) {
        throw new Error("Avatar initialization was already terminated");
      }
      this.startAnimationLoop();
      this.callbacks.onReady?.();
    } catch (error) {
      this.initializationTerminal = true;
      this.clearInitializationWaiter();
      throw error;
    }
  }

  prepare(pcm: Int16Array): number {
    this.cancel(false);
    const epoch = ++this.epoch;
    this.activeEpoch = epoch;
    this.pendingPcm = pcm.slice();
    this.playedSamples = 0;
    this.audioStarted = false;
    this.audioStarting = false;
    this.audioPausedForRender = false;
    this.audioResuming = false;
    this.renderComplete = false;
      this.frameExhaustionLogged = false;
      this.frameSubstitutionLogged = false;
    this.renderedPrefix = 0;
    this.renderTimesMs = [];
    this.stream?.renderQueue.clear();
    this.stream = undefined;
    this.frameCount = 0;
    this.lastRenderedFrame = -1;
    this.lastCompositedAudioFrame = -1;
    this.lastRenderStatusMs = 0;
    this.prebufferStartMs = 0;
    this.latency.beginTurn();
    this.latency.mark("first_assistant_pcm");
    this.latency.mark("first_render_bucket");
    const workerCopy = pcm.slice();
    this.post({ type: "prepare", epoch, pcm16le24k: workerCopy.buffer }, [workerCopy.buffer]);
    return epoch;
  }

  appendStreamingAudio(responseId: string, pcm: Int16Array, final = false): number {
    if (!this.stream || this.stream.responseId !== responseId) {
      this.cancel(false);
      const epoch = ++this.epoch;
      this.activeEpoch = epoch;
      this.pendingPcm = undefined;
      this.playedSamples = 0;
      this.audioStarted = false;
      this.audioStarting = false;
      this.audioPausedForRender = false;
      this.audioResuming = false;
      this.renderComplete = false;
      this.frameExhaustionLogged = false;
      this.frameSubstitutionLogged = false;
      this.renderedPrefix = 0;
      this.renderTimesMs = [];
      this.frameCount = 0;
      this.lastRenderedFrame = -1;
      this.lastCompositedAudioFrame = -1;
      this.lastRenderStatusMs = 0;
      this.prebufferStartMs = 0;
      // Preserve the user/VAD/ASR marks started by the microphone turn. A
      // greeting or text-injected turn has no such anchor, so it still gets a
      // clean trace here.
      if (!this.latency.has("user_speech_started")) this.latency.beginTurn();
      const bootstrapFrames = streamingBootstrapFrameCount(this.meanRenderMs);
      const startReserveSamples = this.streamingPcmStartReserveSamples;
      this.stream = {
        responseId,
        // PCM playback is queued independently, so a short silence-tailed lip
        // bootstrap cannot create the old one-word audio teaser. It only lets
        // the avatar begin moving after 120-160 ms instead of waiting for the
        // full 0.6 s payload + 1.0 s future-context window.
        chunker: new StreamingPcmChunker({
          bootstrapFrames,
        }),
        nextChunkIndex: 0,
        queuedSamples: 0,
        startReserveSamples,
        finalReceived: false,
        renderQueue: new StreamingRenderCreditQueue(2),
      };
      this.latency.noteStreamingStartTargetSamples(startReserveSamples);
      this.audio.beginStream(epoch);
    }
    const epoch = this.activeEpoch;
    if (pcm.length > 0) {
      this.latency.mark("first_assistant_pcm");
      // Audio ownership is independent of render-bucket readiness. The old
      // path appended only chunk.playbackPcm, so a 160 ms bootstrap played and
      // then starved until a complete 2.2 s model window existed.
      this.audio.appendStream(pcm, epoch);
      this.stream.queuedSamples += pcm.length;
    }
    const chunks = this.stream.chunker.push(pcm, final);
    for (const chunk of chunks) {
      const chunkIndex = this.stream.nextChunkIndex++;
      this.frameCount = Math.max(
        this.frameCount,
        chunk.frameOffset + chunk.outputFrames,
      );
      if (chunkIndex === 0) {
        this.latency.mark("first_render_bucket");
        if (chunk.bootstrap) {
          this.callbacks.onStatus?.(
            `Bootstrap lip-sync · ${chunk.outputFrames} frames (silence future)…`,
          );
        }
      }
      this.stream.renderQueue.enqueue({
        chunkIndex,
        frameOffset: chunk.frameOffset,
        discardFrames: chunk.discardFrames,
        outputFrames: chunk.outputFrames,
        final: chunk.final,
        geometryFinal: chunk.geometryFinal,
        bootstrap: chunk.bootstrap,
        modelPcm: chunk.modelPcm,
      });
    }
    this.drainStreamingRenderQueue(epoch);
    if (final) {
      this.stream.finalReceived = true;
      this.latency.mark("audio_final");
      this.audio.finalizeStream(epoch);
    }
    this.maybeStartStreamingAudio(epoch);
    return epoch;
  }

  private maybeStartStreamingAudio(epoch: number): void {
    if (epoch !== this.activeEpoch || !this.stream || this.audioStarted || this.audioStarting) {
      return;
    }
    const renderStartTarget = streamingStartFrameCount(
      this.frameCount,
      this.renderTimesMs,
      this.renderComplete || this.stream.finalReceived,
    );
    if (!streamingAudioStartReady(
      this.stream.queuedSamples,
      this.stream.startReserveSamples,
      this.renderedPrefix,
      renderStartTarget,
      this.stream.finalReceived,
    )) return;
    void this.startStreamingAudio(epoch);
  }

  private async startStreamingAudio(epoch: number): Promise<void> {
    if (epoch !== this.activeEpoch || !this.stream || this.audioStarted || this.audioStarting) {
      return;
    }
    const bufferedSamples = Math.min(this.stream.queuedSamples, this.stream.startReserveSamples);
    this.audioStarting = true;
    try {
      const mediaTime = await seekDecodedVideoFrame(this.idleVideo, NEUTRAL_HOST_TIME);
      if (epoch !== this.activeEpoch) return;
      this.recordPresentedFrame(mediaTime);
      await this.idleVideo.play();
      if (epoch !== this.activeEpoch) {
        if (!this.audioStarted) this.idleVideo.pause();
        return;
      }
      await this.audio.start(epoch);
      if (epoch !== this.activeEpoch) {
        if (!this.audioStarted) this.idleVideo.pause();
        return;
      }
      this.audioStarted = true;
      this.latency.mark("audio_start");
      this.callbacks.onStatus?.(
        `Samantha is speaking · ${Math.round(bufferedSamples * 1_000 / 24_000)}ms PCM buffered`,
      );
      this.callbacks.onPlaybackStarted?.(epoch);
    } catch (error) {
      if (epoch === this.activeEpoch) {
        this.callbacks.onError?.(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (epoch === this.activeEpoch) this.audioStarting = false;
    }
  }

  /**
   * Keep the idle loop RUNNING when she is not speaking.
   *
   * Every `play()` in this file is guarded by
   * `if (!this.audioStarted) this.idleVideo.pause()`, and `cancel()` pauses
   * outright — so between turns the avatar has been a frozen photograph.
   * `bundle/idle320_loop_web.mp4` carries two blinks, at frames 31-33 and
   * 106-108, and until now they were only ever visible mid-sentence.
   *
   * Safe by construction rather than by argument: `draw()` composites a mouth
   * only once `audioStarted` is true (see the EARLY_HOST_PAINT note above), so
   * while idle this paints the neutral host and nothing else. No host/mouth
   * frame-identity contract is in play, which is exactly why the early-paint
   * path was already allowed to run the loop before the runtime finished
   * downloading.
   *
   * The reseek to NEUTRAL_HOST_TIME at speech onset stays: measured global
   * body translation across the loop is 0-2 px at 540x960 (<=4 px native), so
   * landing anywhere in it and jumping back is not a visible cut.
   */
  private playIdleLoopWhileIdle(): void {
    if (this.audioStarted || this.idleVideo.ended) return;
    void this.idleVideo.play().catch(() => undefined);
  }

  cancel(resetHost = true): number {
    const epoch = ++this.epoch;
    this.activeEpoch = epoch;
    this.settleMouth();
    this.post({ type: "cancel", epoch });
    this.audio.clear(epoch);
    // Pause to drop the in-flight frame, then let the loop run again — a
    // cancelled turn returns to idle, and idle should breathe and blink.
    this.idleVideo.pause();
    this.playIdleLoopWhileIdle();
    this.pendingPcm = undefined;
    this.playedSamples = 0;
    this.audioStarted = false;
    this.audioStarting = false;
    this.audioPausedForRender = false;
    this.audioResuming = false;
    this.renderComplete = false;
      this.frameExhaustionLogged = false;
      this.frameSubstitutionLogged = false;
    this.renderedPrefix = 0;
    this.renderTimesMs = [];
    this.stream?.renderQueue.clear();
    this.stream = undefined;
    this.frameCount = 0;
    this.lastCompositedAudioFrame = -1;
    this.lastRenderStatusMs = 0;
    this.prebufferStartMs = 0;
    this.hostSyncMisses = 0;
    this.idleVideo.playbackRate = 1;
    this.clearFrames();
    if (resetHost) void this.resetNeutralHost(epoch);
    return epoch;
  }

  get playedAudioMs(): number {
    return Math.floor(this.playedSamples * 1000 / 24_000);
  }

  /** Hands the render worker a renewed download grant. */
  updateDownloadToken(downloadToken: string): void {
    this.post({ type: "grant", downloadToken });
  }

  destroy(): void {
    cancelAnimationFrame(this.animation);
    this.animationRunning = false;
    if (this.videoFrameRequest
        && typeof this.idleVideo.cancelVideoFrameCallback === "function") {
      this.idleVideo.cancelVideoFrameCallback(this.videoFrameRequest);
    }
    this.clearFrames();
    this.worker.terminate();
    this.audio.close();
  }

  private post(message: MainToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private drainStreamingRenderQueue(epoch: number): void {
    const stream = this.stream;
    if (!stream || epoch !== this.activeEpoch) return;
    stream.renderQueue.drain((pending) => {
      const workerCopy = pending.modelPcm.slice();
      this.post({
        type: "prepare-chunk",
        epoch,
        chunkIndex: pending.chunkIndex,
        frameOffset: pending.frameOffset,
        discardFrames: pending.discardFrames,
        outputFrames: pending.outputFrames,
        final: pending.final,
        geometryFinal: pending.geometryFinal,
        bootstrap: pending.bootstrap,
        pcm16le24k: workerCopy.buffer,
      }, [workerCopy.buffer]);
    });
  }

  private async handleWorker(message: WorkerToMain): Promise<void> {
    if (message.type === "status") {
      this.callbacks.onRuntimeEvent?.(message);
      this.callbacks.onStatus?.(message.progress === undefined
        ? message.message : `${message.message} · ${Math.round(message.progress * 100)}%`);
      return;
    }
    if (message.type === "initialized") {
      if (this.initializationTerminal) return;
      this.nIdle = message.nIdle;
      this.initializationResolve?.();
      this.clearInitializationWaiter();
      return;
    }
    if (message.type === "error") {
      if (message.epoch === undefined || message.epoch === this.activeEpoch) {
        if (message.epoch === undefined) {
          this.initializationReject?.(new Error(message.message));
          this.clearInitializationWaiter();
        }
        this.callbacks.onError?.(message.message);
      }
      return;
    }
    if (message.epoch !== this.activeEpoch) return;
    if (message.type === "runtime-pressure") {
      const renderQueue = this.stream?.renderQueue.snapshot()
        ?? { pending: 0, inFlight: 0, limit: 0 };
      const audioFrame = Math.floor(this.playedSamples / SAMPLES_PER_FRAME);
      this.callbacks.onRuntimePressure?.({
        ...message,
        pendingRenderWindows: renderQueue.pending,
        inFlightRenderWindows: renderQueue.inFlight,
        renderWindowLimit: renderQueue.limit,
        renderedPrefix: this.renderedPrefix,
        audioFrame,
        renderLeadFrames: this.renderedPrefix - audioFrame,
      });
      return;
    }
    if (message.type === "geometry-ready") {
      this.frameCount = message.frameCount;
      if (!this.pendingPcm) return;
      // The worker may cap very long replies to the model's 750-step limit.
      const samples = this.pendingPcm.subarray(0, Math.min(this.pendingPcm.length, message.audioSamples));
      this.audio.load(samples, message.epoch);
      this.pendingPcm = undefined;
      this.callbacks.onStatus?.(`Rendering ${message.frameCount} lip-sync frames…`);
      return;
    }
    if (message.type === "chunk-geometry-ready") {
      this.frameCount = Math.max(
        this.frameCount,
        message.frameOffset + message.frameCount,
      );
      this.callbacks.onStatus?.(
        `Rendering streaming lip bucket ${message.chunkIndex + 1}…`,
      );
      return;
    }
    if (message.type === "frame") {
      if (message.epoch !== this.activeEpoch) return;
      this.frames.set(message.index, {
        index: message.index,
        box: message.box,
        width: message.width,
        height: message.height,
        predBgr: new Uint8Array(message.predBgr),
        support: new Float32Array(message.support),
        jawProtected: new Uint8Array(message.jawProtected),
        bitmap: message.bitmap,
      });
      this.renderTimesMs.push(message.renderMs);
      if (message.index === this.renderedPrefix) {
        this.renderedPrefix += 1;
        while (this.renderedPrefix < this.frameCount && this.frames.has(this.renderedPrefix)) {
          this.renderedPrefix += 1;
        }
      }
      if (this.stream) this.maybeStartStreamingAudio(message.epoch);
      if (this.audioPausedForRender) {
        await this.resumeAfterRenderBuffer(message.epoch);
      }
      if (!this.audioStarted && !this.audioStarting && this.frameCount > 0) {
        const now = performance.now();
        if (this.prebufferStartMs === 0) this.prebufferStartMs = now;
        // Only surface render progress when the prebuffer is genuinely slow
        // (>600ms): a real-time-capable renderer starts playback before the
        // first update would fire, so showing it mid-turn is pure noise.
        if (now - this.prebufferStartMs > 600 && now - this.lastRenderStatusMs > 400) {
          this.lastRenderStatusMs = now;
          this.callbacks.onStatus?.(
            `Rendering lip sync · ${this.renderedPrefix}/${this.frameCount} frames`,
          );
        }
      }
      // Preserve the exact full-utterance Feather + bidirectional geometry
      // result, but begin playback once enough serial renderer output exists to
      // finish the remaining frames behind the audio clock.
      if (!this.stream && !this.audioStarted && !this.audioStarting
          && this.frameCount > 0
          && this.renderedPrefix >= renderAheadFrameCount(
            this.frameCount, this.renderTimesMs,
          )) {
        this.audioStarting = true;
        const epoch = message.epoch;
        const buffered = this.renderedPrefix;
        try {
          const mediaTime = await seekDecodedVideoFrame(this.idleVideo, NEUTRAL_HOST_TIME);
          if (epoch !== this.activeEpoch) return;
          this.recordPresentedFrame(mediaTime);
          await this.idleVideo.play();
          if (epoch !== this.activeEpoch) {
            if (!this.audioStarted) this.idleVideo.pause();
            return;
          }
          await this.audio.start(epoch);
          if (epoch !== this.activeEpoch) {
            if (!this.audioStarted) this.idleVideo.pause();
            return;
          }
          this.audioStarted = true;
          this.latency.mark("audio_start");
          this.callbacks.onStatus?.(
            `Samantha is speaking · ${buffered}/${this.frameCount} frames buffered`,
          );
          this.callbacks.onPlaybackStarted?.(epoch);
        } catch (error) {
          if (epoch === this.activeEpoch) {
            this.callbacks.onError?.(
              error instanceof Error ? error.message : String(error),
            );
          }
        } finally {
          if (epoch === this.activeEpoch) this.audioStarting = false;
        }
      }
      return;
    }
    if (message.type === "render-complete") {
      this.renderComplete = true;
      this.meanRenderMs = message.meanRenderMs;
      if (this.audioPausedForRender) {
        await this.resumeAfterRenderBuffer(message.epoch);
      }
      this.callbacks.onMetrics?.(
        `${message.frameCount}f · ${message.neuralFrames ?? message.frameCount} neural · `
          + `mean ${message.meanRenderMs.toFixed(1)} ms/frame · ${this.nIdle} idle frames`,
      );
      return;
    }
    if (message.type === "chunk-render-complete") {
      if (this.stream) {
        this.stream.renderQueue.complete();
        this.drainStreamingRenderQueue(message.epoch);
      }
      if (message.final) this.renderComplete = true;
      this.meanRenderMs = this.renderTimesMs.length > 0
        ? this.renderTimesMs.reduce((total, value) => total + value, 0)
          / this.renderTimesMs.length
        : message.meanRenderMs;
      if (this.audioPausedForRender) {
        await this.resumeAfterRenderBuffer(message.epoch);
      }
      this.callbacks.onMetrics?.(
        `${this.renderedPrefix}f streamed · mean ${this.meanRenderMs.toFixed(1)} ms/frame · `
          + `${this.nIdle} idle frames`,
      );
    }
  }

  private handlePlaybackTick(tick: PlaybackTick): void {
    if (tick.epoch !== this.activeEpoch) return;
    this.playedSamples = tick.playedSamples;
    this.latency.notePlaybackBuffer(tick.bufferedSamples, tick.started, tick.final);
    // Rendering finished but audio has not: the frame supply ran out early and
    // draw() is holding the last composited frame, which reads as the avatar
    // freezing while she is still talking. Reported from the second turn on,
    // "2-3 seconds before the end".
    //
    // This is a DIAGNOSTIC, not a fix: it distinguishes "frames ran out" from
    // "renderer fell behind", which look identical on screen and have opposite
    // causes. Logged once per turn so a long reply cannot flood the log.
    if (this.renderComplete && this.audioStarted && !this.frameExhaustionLogged) {
      const audioFrame = Math.floor(this.playedSamples / SAMPLES_PER_FRAME);
      if (audioFrame > this.renderedPrefix) {
        this.frameExhaustionLogged = true;
        this.callbacks.onStatus?.(
          `Frame supply exhausted · rendered ${this.renderedPrefix} frames, `
          + `audio is at frame ${audioFrame} `
          + `(${(((audioFrame - this.renderedPrefix) * 1000) / FPS).toFixed(0)} ms short)`,
        );
      }
    }
    if (!this.audioStarted || this.audioPausedForRender || this.renderComplete) return;
    const audioFrame = Math.floor(this.playedSamples / SAMPLES_PER_FRAME);
    if (this.renderedPrefix - audioFrame > PAUSE_LEAD_FRAMES) return;
    // Do not pause assistant audio mid-word — that is worse UX than a briefly
    // held lip pose. draw() already falls back to the last composited frame.
    this.latency.noteUnderrun();
    if (performance.now() - this.lastRenderStatusMs > 700) {
      this.lastRenderStatusMs = performance.now();
      this.callbacks.onStatus?.(
        `Lips catching up · ${this.renderedPrefix} rendered / audio frame ${audioFrame}`,
      );
    }
  }

  private async resumeAfterRenderBuffer(epoch: number): Promise<void> {
    if (!this.audioPausedForRender || this.audioResuming || epoch !== this.activeEpoch) return;
    const audioFrame = Math.floor(this.playedSamples / SAMPLES_PER_FRAME);
    if (!this.renderComplete && this.renderedPrefix - audioFrame < RESUME_LEAD_FRAMES) return;
    this.audioResuming = true;
    try {
      await this.idleVideo.play();
      if (epoch !== this.activeEpoch) {
        if (!this.audioStarted) this.idleVideo.pause();
        return;
      }
      await this.audio.start(epoch);
      if (epoch !== this.activeEpoch) return;
      this.audioPausedForRender = false;
      this.callbacks.onStatus?.("Samantha is speaking");
    } catch (error) {
      if (epoch === this.activeEpoch) {
        this.callbacks.onError?.(
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      if (epoch === this.activeEpoch) this.audioResuming = false;
    }
  }

  private startAnimationLoop(): void {
    if (this.animationRunning) return;
    this.animationRunning = true;
    const draw = () => {
      this.draw();
      this.animation = requestAnimationFrame(draw);
    };
    this.animation = requestAnimationFrame(draw);
  }

  /** One-shot: the visitor can now see the avatar. */
  private noteFirstHostFrame(): void {
    if (this.firstHostFrameMs !== undefined) return;
    this.firstHostFrameMs = performance.now();
    try {
      performance.mark("serve320:first_host_frame");
    } catch {
      // performance.mark is optional in non-browser hosts.
    }
    this.callbacks.onFirstHostFrame?.(this.firstHostFrameMs);
  }

  private startPresentedFrameTracking(): void {
    if (typeof this.idleVideo.requestVideoFrameCallback !== "function") return;
    const track = (_now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => {
      this.recordPresentedFrame(metadata.mediaTime);
      this.videoFrameRequest = this.idleVideo.requestVideoFrameCallback(track);
    };
    this.videoFrameRequest = this.idleVideo.requestVideoFrameCallback(track);
  }

  private recordPresentedFrame(mediaTime: number): void {
    const frame = Math.floor(mediaTime * FPS + 1e-4) % this.nIdle;
    if (frame !== this.presentedHostFrame) this.hostFrameDirty = true;
    this.presentedHostFrame = frame;
  }

  private draw(): void {
    const now = performance.now();
    const { width, height } = this.canvas;
    const audioFrameIndex = this.audioStarted
      ? Math.min(this.frameCount - 1, Math.floor(this.playedSamples / SAMPLES_PER_FRAME))
      : -1;
    let frameIndex = -1;
    if (this.audioStarted) {
      const presented = this.presentedHostFrame >= 0
        ? this.presentedHostFrame
        : Math.floor(this.idleVideo.currentTime * FPS + 1e-4) % this.nIdle;
      const synchronized = synchronizedFrameIndex(
        audioFrameIndex, presented, this.nIdle,
      );
      // Never repaint the host or mouth using different frame identities.
      // Holding the previous complete canvas for at most two 25-fps ticks is
      // preferable to exposing the broad QA9 support as a pale slab.
      if (synchronized === undefined) {
        this.hostSyncMisses += 1;
        this.evictFramesBefore(audioFrameIndex - 1);
        const skew = hostAudioFrameSkew(audioFrameIndex, presented, this.nIdle);
        if (skew !== undefined) {
          this.idleVideo.playbackRate = hostPlaybackRateForSkew(skew);
          if (this.hostSyncMisses === HOST_SYNC_RECOVERY_MISSES) {
            this.callbacks.onStatus?.(
              `Correcting avatar clock by ${Math.abs(skew)} frame(s) without pausing audio`,
            );
          }
        }
        this.lipFade?.refresh(now, false);
        return;
      }
      this.hostSyncMisses = 0;
      if (this.idleVideo.playbackRate !== 1) this.idleVideo.playbackRate = 1;
      // This `return` was the freeze. When the frame the audio clock asks for
      // is not held — never rendered, or evicted before the prefix caught up —
      // draw() bailed and the canvas kept whatever was last composited, for as
      // long as the gap lasted. Reported as the avatar freezing 2-3 s before the
      // end of a reply from the second turn on.
      //
      // The three candidate causes look identical here and are still unresolved
      // (the `Frame supply exhausted` status line separates them), but the
      // FAILURE MODE does not have to be a freeze either way: a mouth one or two
      // frames stale is far better than a mouth that stops. Prefer the newest
      // held frame at or before the requested one — behind, never ahead, so the
      // mouth is never shaped for audio that has not played yet.
      if (!this.frames.has(synchronized)) {
        const substitute = this.nearestHeldFrameAtOrBefore(synchronized);
        if (substitute === undefined) {
          this.lipFade?.refresh(now, false);
          return;
        }
        if (!this.frameSubstitutionLogged) {
          this.frameSubstitutionLogged = true;
          this.callbacks.onStatus?.(
            `Mouth held back ${synchronized - substitute} frame(s) · `
            + `wanted ${synchronized}, newest held ${substitute}`,
          );
        }
        frameIndex = substitute;
      } else {
        frameIndex = synchronized;
      }
      if (frameIndex === this.lastCompositedAudioFrame) {
        this.lipFade?.refresh(now, false);
        return;
      }
    }
    // Blend: choose how the new lip frame replaces the picture on screen, and keep that picture before painting.
    let fadeKind: LipFadeKind | undefined;
    const presentedHost = !this.lipFade ? -1 : this.presentedHostFrame >= 0
      ? this.presentedHostFrame
      : Math.floor(this.idleVideo.currentTime * FPS + 1e-4) % this.nIdle;
    if (this.lipFade && frameIndex >= 0) {
      const incoming = this.frames.get(frameIndex);
      if (incoming) {
        if (this.shownMouthFrame < 0) {
          fadeKind = "enter";
        } else if (lipFramesAdjacent(this.shownMouthFrame, frameIndex)
            && hostFramesAdjacent(this.shownHostFrame, presentedHost, this.nIdle)) {
          fadeKind = "neighbour";
        }
        if (fadeKind) this.lipFade.capture(this.shownMouthBox, incoming.box);
        else this.lipFade.step();
      }
    }
    // No mouth is composited before audio starts. The old preview path painted
    // `renderedPrefix - 1`, walking the mouth through every frame produced
    // while the prebuffer filled, so the avatar lip-synced an utterance that
    // had not begun playing. Holding frame 0 instead was still wrong: frame 0
    // is already shaped for the first phoneme, so the mouth visibly snapped
    // off neutral ~0.3 s early. The idle host now shows through untouched
    // until `audioStarted`, and the pcm→first-mouth timing is recorded by
    // LatencyTrace rather than by painting.

    let paintedHost = false;
    if (this.idleVideo.readyState >= HAVE_CURRENT_DATA
        && (this.audioStarted || this.renderedPrefix > 0
          || !this.hasDrawnHostFrame || this.hostFrameDirty)) {
      this.context.drawImage(this.idleVideo, 0, 0, width, height);
      this.hasDrawnHostFrame = true;
      this.hostFrameDirty = false;
      paintedHost = true;
      this.noteFirstHostFrame();
    } else if (!this.hasDrawnHostFrame) {
      this.context.fillStyle = "#14121c";
      this.context.fillRect(0, 0, width, height);
    }
    if (frameIndex < 0) {
      this.lipFade?.refresh(now, paintedHost);
      return;
    }
    const frame = this.frames.get(frameIndex);
    if (frame) {
      const [x0, y0, x1, y1] = frame.box;
      const regionWidth = x1 - x0, regionHeight = y1 - y0;
      if (regionWidth === frame.width && regionHeight === frame.height) {
        if (frame.bitmap && GPU_BLEND_ENABLED) {
          // source-over computes dst*(1-a) + src*a, the same arithmetic as
          // canonicalBlendRgba, on the GPU. Measured at a 260x340 box this
          // replaces 5.31 ms of main-thread work (getImageData 0.88 + blend
          // 4.41 + putImageData 0.02) with 0.007 ms. Rounding differs from the
          // CPU path's roundToEven by at most 1 LSB per channel.
          this.context.drawImage(frame.bitmap, x0, y0);
          this.noteMouthShown(frame, presentedHost, fadeKind, now);
          this.lastRenderedFrame = frame.index;
          this.lastCompositedAudioFrame = frame.index;
          if (!this.latency.has("first_presented_frame")) {
            this.latency.mark("first_composited_frame");
            this.latency.mark("first_presented_frame");
            const summary = this.latency.summary();
            this.callbacks.onLatency?.(summary);
            this.callbacks.onMetrics?.(summary);
          }
          this.evictFramesBefore(frame.index - 1);
          return;
        }
        const region = this.context.getImageData(x0, y0, regionWidth, regionHeight);
        // Keep a same-size ImageData around for engines that optimize stable sizes.
        if (regionWidth !== this.mouthImageWidth || regionHeight !== this.mouthImageHeight) {
          this.mouthImageData = region;
          this.mouthImageWidth = regionWidth;
          this.mouthImageHeight = regionHeight;
        }
        canonicalBlendRgba(
          region.data,
          frame.predBgr,
          frame.support,
          frame.jawProtected,
        );
        this.context.putImageData(region, x0, y0);
        this.noteMouthShown(frame, presentedHost, fadeKind, now);
      }
      this.lastRenderedFrame = frame.index;
      this.lastCompositedAudioFrame = frame.index;
      if (!this.latency.has("first_presented_frame")) {
        this.latency.mark("first_composited_frame");
        this.latency.mark("first_presented_frame");
        const summary = this.latency.summary();
        this.callbacks.onLatency?.(summary);
        this.callbacks.onMetrics?.(summary);
      }
      this.evictFramesBefore(frame.index - 1);
    }
  }

  /** Blend bookkeeping after a lip frame is painted: start its fade over the picture captured before painting. */
  private noteMouthShown(
    frame: RenderedFrame,
    presentedHost: number,
    fadeKind: LipFadeKind | undefined,
    now: number,
  ): void {
    if (!this.lipFade) return;
    if (fadeKind) this.lipFade.begin(fadeKind, now);
    this.shownMouthFrame = frame.index;
    this.shownMouthBox = [frame.box[0], frame.box[1], frame.box[2], frame.box[3]];
    this.shownHostFrame = presentedHost;
  }

  /**
   * Blend: the mouth overlay leaves (a reply ended or was interrupted). Its last picture fades out over the idle face
   * from the next host repaint on, instead of vanishing in one picture.
   */
  private settleMouth(): void {
    if (!this.lipFade || this.shownMouthFrame < 0 || !this.shownMouthBox) return;
    this.lipFade.capture(this.shownMouthBox, this.shownMouthBox);
    this.lipFade.begin("settle", performance.now(), false);
    this.shownMouthFrame = -1;
    this.shownMouthBox = undefined;
    this.shownHostFrame = -1;
    this.hostFrameDirty = true;
  }

  /** Fades drawn so far (blend), for diagnostics. */
  get lipFadeCounts(): LipFadeCounts | undefined {
    return this.lipFade ? { ...this.lipFade.state.counts } : undefined;
  }

  /**
   * Newest held frame at or before `index`, within a bounded reach.
   *
   * Bounded because substituting an arbitrarily old mouth would be worse than
   * holding: past a few frames the shape belongs to different phonemes. Two
   * frames is 80 ms at 25 fps — below the ~100 ms where audio/visual offset
   * becomes reportable — so this trades an invisible amount of lipsync accuracy
   * for the difference between a stutter and a multi-second freeze.
   */
  private nearestHeldFrameAtOrBefore(index: number): number | undefined {
    for (let candidate = index; candidate >= index - MAX_MOUTH_SUBSTITUTION_FRAMES; candidate -= 1) {
      if (candidate < 0) break;
      if (this.frames.has(candidate)) return candidate;
    }
    return undefined;
  }

  private evictFramesBefore(minimumIndex: number): void {
    for (const [index, frame] of this.frames) {
      if (index < minimumIndex) {
        // An ImageBitmap holds GPU-side storage until closed. At 25 fps and
        // ~353 KB per 260x340 mouth box, dropping the reference without
        // closing leaks roughly 9 MB/second.
        frame.bitmap?.close();
        this.frames.delete(index);
      }
    }
  }

  private clearFrames(): void {
    for (const [, frame] of this.frames) frame.bitmap?.close();
    this.frames.clear();
  }

  private async resetNeutralHost(epoch: number): Promise<void> {
    try {
      if (epoch !== this.activeEpoch || this.audioStarted) return;
      // Only reset when the idle loop is NOT already running.
      //
      // This used to seek unconditionally at the end of every reply, and a seek
      // stalls decode and jumps the loop to a fixed point — which is what the
      // team saw as "a quick freeze" when Samantha stops speaking and the head
      // returns to idle. It bought nothing: the START of a reply already seeks
      // to NEUTRAL_HOST_TIME before playing, so the neutral pose is guaranteed
      // where it actually matters. Ending a reply mid-loop and simply letting
      // the loop continue is seamless, which is the whole point of a loop.
      //
      // A paused video still needs the reset: there is no loop to continue and
      // the canvas would otherwise hold whatever frame speech ended on.
      if (!this.idleVideo.paused && !this.idleVideo.ended) return;
      // A hidden tab must not fail the conversation here, so retry until the
      // document comes back.
      const mediaTime = await seekDecodedVideoFrameWhenVisible(
        this.idleVideo, NEUTRAL_HOST_TIME,
      );
      if (epoch !== this.activeEpoch || this.audioStarted) return;
      this.recordPresentedFrame(mediaTime);
      // Back to idle: run the loop so she blinks and breathes while listening.
      this.playIdleLoopWhileIdle();
    } catch (error) {
      if (epoch === this.activeEpoch) {
        this.callbacks.onError?.(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private clearInitializationWaiter(): void {
    window.clearTimeout(this.initializationTimer);
    this.initializationTimer = 0;
    this.initializationResolve = undefined;
    this.initializationReject = undefined;
  }
}
