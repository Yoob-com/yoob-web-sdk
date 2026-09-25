import {
  ChunkStore, SDK_VERSION, YoobError, clearChunkCache, fetchManifest, pruneChunkCache,
  type CharacterManifest,
} from "./cdn";
import type { RemoteAudioTrack } from "./engine/audio/conversation-audio";
import { RenderCoordinator } from "./engine/runtime/render-coordinator";
import type { RendererSpatialContract } from "./engine/runtime/generated/runtime-tier-contract";
import type { RendererTemporalContract } from "./engine/runtime/renderer-temporal";

import { YoobMicrophone } from "./microphone";
import { SessionMonitor, endSession } from "./session";

export { YoobError, type CharacterManifest };
export { YoobMicrophone, type MicrophoneOption, type MicrophoneState, type MicrophoneEvents } from "./microphone";
export {
  YoobConversation, voiceCloseError, isAllowedVoiceUrl, DEFAULT_VOICE_HOSTS, type YoobConversationOptions,
  type YoobVoiceSession, type ConversationState, type TurnDetection,
} from "./conversation";
export {
  YoobGeminiConversation, GEMINI_LIVE_URL, type YoobGeminiConversationOptions, type GeminiActivityDetection,
} from "./gemini-conversation";
export { PcmResampler } from "./resampler";
export const version = SDK_VERSION;

/**
 * The methods of a LiveKit `RemoteAudioTrack` that `attachAudioTrack()` uses. Any livekit-client 2.x remote audio track
 * fits; the core package does not depend on livekit-client.
 */
export type YoobAudioTrack = RemoteAudioTrack;

/** What your backend returns from `POST /api/v1/avatar/sessions`. Never put your Yoob API key in a web page. */
export interface YoobCredentials {
  session_token: string;
  /** Short-lived grant for this session's characters. Heartbeats may renew it. */
  download_token: string;
  heartbeat_seconds?: number;
  api_base?: string;
  cdn_base?: string;
}

export type YoobPhase =
  | "not-prepared" | "downloading" | "warming" | "ready" | "speaking" | "failed" | "stopped";

export interface YoobProgress {
  completedBytes: number;
  totalBytes: number;
  fraction: number;
}

export interface YoobAvatarOptions {
  /** Element the character is drawn into. It fills the element, cropping to keep its aspect ratio. */
  container: HTMLElement;
  /** Character id, for example `"luna-anime"`. */
  character: string;
  /** Pin a character version. The newest compatible version is used by default. */
  version?: string;
  /** Asks your backend for a Yoob session. Called again when a session expires. */
  getCredentials: () => Promise<YoobCredentials>;
  /** `"cover"` (default) fills the container; `"contain"` letterboxes. */
  fit?: "cover" | "contain";
  /**
   * How the lips move between the character's 25 lip frames a second. `"blend"` (default) cross-fades each new lip
   * frame in over 40 ms at the display's own rate, fades the mouth in over 120 ms when a reply starts and back to the
   * idle face over 160 ms when it ends or is interrupted. `"step"` shows each lip frame whole and removes the mouth in
   * one picture, as 0.2 did.
   */
  lipCadence?: "blend" | "step";
  onPhase?: (phase: YoobPhase) => void;
  onProgress?: (progress: YoobProgress) => void;
  onError?: (error: YoobError) => void;
  /**
   * The session stopped and the character stopped rendering: the workspace ran out of credit (`out-of-credit`), Yoob
   * refused the session (`unauthorized`), or Yoob couldn't be reached for the whole outage grace window
   * (`session-ended` with `details.reason` `unreachable`). `onError` receives the same error. Call `prepare()` to
   * start a new session.
   */
  onSessionEnded?: (error: YoobError) => void;
  /**
   * How long the character keeps rendering while heartbeats get no answer (network errors, timeouts, 408, 429, 5xx),
   * counted from the last successful heartbeat. 0 stops at the first failure; the most is 1800. Default 600 (10 min).
   * Refusals (401, 402, 403) stop the character at once regardless.
   */
  heartbeatOutageGraceSeconds?: number;
  /** Heartbeats started failing without an answer. Not fatal: the character keeps rendering while they are retried. */
  onHeartbeatDegraded?: (detail: string) => void;
  /** A heartbeat succeeded again after `onHeartbeatDegraded`. */
  onHeartbeatRecovered?: () => void;
}

export interface YoobSupport {
  supported: boolean;
  reason?: string;
}

const ORT_WASM_PATH = "v1/runtime/onnxruntime-web-1.27.0/ort-wasm-simd-threaded.asyncify.wasm";
const SAMPLE_RATE = 24_000;

/**
 * A talking character in the page. Create it, call `prepare()`, then pass speech to `speak()`.
 * The avatar plays the audio itself so the lips stay in sync.
 */
export class YoobAvatar {
  private phaseValue: YoobPhase = "not-prepared";
  private readonly root: HTMLDivElement;
  private readonly poster: HTMLImageElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private coordinator?: RenderCoordinator;
  private credentials?: YoobCredentials;
  private manifestValue?: CharacterManifest;
  private preparing?: Promise<void>;
  private monitor?: SessionMonitor;
  private access?: { cdnBase: string; downloadToken: string };
  private objectUrls: string[] = [];
  private utterance = 0;
  private speaking = false;
  private ended = false;
  private destroyed = false;
  private stoppedError?: YoobError;
  private stopListeners: Array<(error: YoobError) => void> = [];
  private runtimeEvent?: (event: { loadedBytes?: number }) => void;
  /** The user's microphone: device choice, mute, level and audio packets. */
  readonly microphone = new YoobMicrophone(() => this.engine().audio);

  constructor(private readonly options: YoobAvatarOptions) {
    const fit = options.fit ?? "cover";
    this.root = document.createElement("div");
    this.root.className = "yoob-avatar";
    this.root.setAttribute("role", "img");
    this.root.setAttribute("aria-label", "Character");
    Object.assign(this.root.style, { position: "relative", width: "100%", height: "100%", overflow: "hidden" });
    const layer = { position: "absolute", inset: "0", width: "100%", height: "100%", objectFit: fit };
    this.poster = document.createElement("img");
    this.poster.alt = "";
    this.poster.decoding = "async";
    Object.assign(this.poster.style, layer);
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1080;
    this.canvas.height = 1920;
    Object.assign(this.canvas.style, layer, { opacity: "0", transition: "opacity 200ms ease" });
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.preload = "auto";
    this.video.setAttribute("aria-hidden", "true");
    // The engine draws the video into the canvas; it stays in the document so browsers keep decoding it.
    Object.assign(this.video.style, { position: "absolute", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" });
    this.root.append(this.poster, this.canvas, this.video);
    options.container.append(this.root);
  }

  /** Whether this browser can render characters: WebGPU plus the Web Crypto and Audio APIs the SDK uses. */
  static async isSupported(): Promise<YoobSupport> {
    if (typeof navigator === "undefined" || !("gpu" in navigator)) {
      return { supported: false, reason: "This browser has no WebGPU. Use a current Chrome or Edge on a desktop." };
    }
    try {
      const adapter = await (navigator as Navigator & { gpu: GPU }).gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) return { supported: false, reason: "WebGPU is turned off or has no usable graphics adapter." };
    } catch {
      return { supported: false, reason: "WebGPU is unavailable." };
    }
    if (typeof AudioWorkletNode === "undefined") return { supported: false, reason: "This browser has no AudioWorklet." };
    return { supported: true };
  }

  static clearCache(): Promise<void> {
    return clearChunkCache();
  }

  get phase(): YoobPhase { return this.phaseValue; }
  get manifest(): CharacterManifest | undefined { return this.manifestValue; }
  /** Milliseconds of the current utterance the listener has heard. */
  get playedMs(): number { return this.coordinator?.playedAudioMs ?? 0; }

  /**
   * Downloads what is missing and starts the renderer. The poster shows within the first request or two and the idle
   * loop soon after; the models finish behind it. Safe to call again after a failure.
   */
  prepare(): Promise<void> {
    if (this.phaseValue === "ready" || this.phaseValue === "speaking") return Promise.resolve();
    this.preparing ??= this.load().catch((error: unknown) => {
      if (this.phaseValue === "stopped" && this.stoppedError) throw this.stoppedError; // already reported
      const failure = toYoobError(error);
      // Don't leave a metered session running behind a failed start.
      this.stopHeartbeat();
      this.endCurrentSession();
      this.setPhase("failed");
      this.options.onError?.(failure);
      throw failure;
    }).finally(() => { this.preparing = undefined; });
    return this.preparing;
  }

  /**
   * Call from a click or key press before the first `speak()`, so the browser allows sound. `speak()` also tries.
   */
  async unlockAudio(): Promise<void> {
    await this.engine().audio.activatePlayback();
  }

  /**
   * Plays 24 kHz mono 16-bit PCM and moves the face with it. Call for each chunk as it streams in, then `endSpeech()`.
   */
  speak(pcm: Int16Array | ArrayBuffer, sampleRate = SAMPLE_RATE): void {
    if (this.phaseValue === "stopped") throw this.stoppedError ?? new YoobError("session-ended", "The Yoob session has stopped.");
    if (sampleRate !== SAMPLE_RATE) {
      throw new YoobError("invalid-audio", "@yoob/avatar 0.1 accepts 24 kHz audio. Request 24 kHz PCM from your voice provider.");
    }
    const samples = pcm instanceof Int16Array ? pcm : new Int16Array(pcm);
    if (samples.length === 0) return;
    const coordinator = this.engine();
    if (!this.speaking || this.ended) this.beginUtterance();
    coordinator.appendStreamingAudio(this.responseId, samples, false);
  }

  /** Marks the end of the current utterance. The face returns to idle when the audio finishes. */
  endSpeech(): void {
    if (!this.speaking || this.ended) return;
    this.ended = true;
    this.engine().appendStreamingAudio(this.responseId, new Int16Array(), true);
  }

  /** Stops speaking at once. Returns the milliseconds that were heard, for truncating a realtime reply. */
  interrupt(): number {
    if (!this.coordinator || !this.speaking) return 0;
    const heard = this.coordinator.playedAudioMs;
    this.coordinator.cancel();
    this.finishUtterance();
    return heard;
  }

  /**
   * Listens to a LiveKit remote audio track instead of playing it: `onAudio` receives its sound as 24 kHz mono PCM16 in
   * 20 ms packets (silence included), and the track's own output is muted. Pass the packets you want heard to
   * `speak()`. Only one track is attached at a time. Resolves to a function that detaches the track.
   * `YoobLiveKitSession` from `@yoob/avatar/livekit` does all of this for a LiveKit agent.
   */
  async attachAudioTrack(track: YoobAudioTrack, onAudio: (pcm: Int16Array) => void): Promise<() => void> {
    const audio = this.engine().audio;
    const cleanup = await audio.tapRemoteTrack(track, onAudio);
    return () => audio.stopRemoteTap(cleanup);
  }

  /** Ends the metered session and removes the character from the page. Downloaded files stay cached. */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const credentials = this.credentials;
    this.stopHeartbeat();
    this.microphone.stop();
    this.coordinator?.destroy();
    this.coordinator = undefined;
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.root.remove();
    this.credentials = undefined;
    if (credentials) await endSession(this.apiBaseOf(credentials), credentials.session_token).catch(() => undefined);
    this.setPhase("not-prepared");
  }

  private get responseId(): string {
    return `yoob-${this.utterance}`;
  }

  private beginUtterance(): void {
    this.utterance += 1;
    this.speaking = true;
    this.ended = false;
    void this.engine().audio.activatePlayback().catch(() => undefined);
    this.setPhase("speaking");
  }

  private finishUtterance(): void {
    this.speaking = false;
    this.ended = false;
    if (this.phaseValue === "speaking") this.setPhase(this.coordinator ? "ready" : "not-prepared");
  }

  private engine(): RenderCoordinator {
    if (this.destroyed) throw new YoobError("renderer", "This avatar was destroyed.");
    if (this.phaseValue === "stopped") {
      throw this.stoppedError ?? new YoobError("session-ended", "The Yoob session has stopped. Call prepare() to start a new one.");
    }
    this.coordinator ??= new RenderCoordinator(this.canvas, this.video, {
      onFirstHostFrame: () => { this.canvas.style.opacity = "1"; },
      onPlaybackEnded: () => this.finishUtterance(),
      onError: (message) => this.options.onError?.(new YoobError("renderer", message)),
      onRuntimeEvent: (event) => this.runtimeEvent?.(event),
    }, { lipCadence: this.options.lipCadence });
    return this.coordinator;
  }

  private async load(): Promise<void> {
    const support = await YoobAvatar.isSupported();
    if (!support.supported) throw new YoobError("unsupported", support.reason ?? "WebGPU is required.");
    this.stoppedError = undefined;
    this.setPhase("downloading");
    this.stopHeartbeat();
    this.endCurrentSession();
    this.credentials = checkCredentials(await this.options.getCredentials());
    const access = { cdnBase: this.cdnBase, downloadToken: this.credentials.download_token };
    this.access = access;
    // Metering starts with the session, so heartbeats run during the download too.
    this.startHeartbeat();
    const manifest = await fetchManifest(access, this.options.character, this.options.version, "web");
    this.manifestValue = manifest;
    this.root.setAttribute("aria-label", manifest.displayName);
    const runtime = manifest.runtime;
    if (!runtime || manifest.engine !== "anime-web") {
      throw new YoobError("unsupported", `${manifest.character} has no web renderer in this SDK version.`);
    }

    const store = new ChunkStore(access, manifest);
    const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
    let completed = 0;
    const count = (bytes: number) => {
      completed += bytes;
      this.options.onProgress?.({ completedBytes: completed, totalBytes: total, fraction: total ? completed / total : 0 });
    };

    // Tier 0 and 1 on the page: the poster, then the idle loop the engine draws.
    const poster = await store.bytes(manifest.poster, count);
    this.poster.src = this.objectUrl(poster, "image/jpeg");
    const videoFile = manifest.files.find((file) => file.tier === 1 && file.path.endsWith(".mp4"));
    if (!videoFile) throw new YoobError("invalid-assets", "The character has no idle video.");
    const video = await store.bytes(videoFile.path, count);
    this.video.src = this.objectUrl(video, "video/mp4");
    this.video.load();
    // The worker downloads the rest; count everything else as it lands.
    const workerBytes = total - completed;
    const coordinator = this.engine();
    const workerStart = completed;

    this.setPhase("warming");
    const statusSink = (event: { loadedBytes?: number }) => {
      if (event.loadedBytes === undefined) return;
      const done = workerStart + Math.min(workerBytes, event.loadedBytes);
      this.options.onProgress?.({ completedBytes: done, totalBytes: total, fraction: total ? done / total : 0 });
    };
    this.runtimeEvent = statusSink;
    await this.unlessStopped(coordinator.initialize(
      { ...access, manifest, ortWasmUrl: `${this.cdnBase}/${ORT_WASM_PATH}` },
      runtime.neuralMouthStride ?? 1,
      runtime.rendererInputType ?? "float32",
      runtime.rendererPreferredLayout ?? "NCHW",
      runtime.rendererSpatialContract as RendererSpatialContract | undefined,
      runtime.rendererTemporalContract as RendererTemporalContract | undefined,
    ));
    this.options.onProgress?.({ completedBytes: total, totalBytes: total, fraction: 1 });
    this.canvas.style.opacity = "1";
    void pruneChunkCache([manifest]).catch(() => undefined);
    if (!this.monitor?.active) throw this.stoppedError ?? new YoobError("session-ended", "The Yoob session has stopped.");
    this.setPhase("ready");
  }

  private get cdnBase(): string {
    return (this.credentials?.cdn_base ?? "https://cdn.yoob.com").replace(/\/+$/, "");
  }

  private objectUrl(data: ArrayBuffer, type: string): string {
    const url = URL.createObjectURL(new Blob([data], { type }));
    this.objectUrls.push(url);
    return url;
  }

  private setPhase(phase: YoobPhase): void {
    if (this.phaseValue === phase) return;
    this.phaseValue = phase;
    this.options.onPhase?.(phase);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const monitor = new SessionMonitor({
      apiBase: () => this.apiBase,
      sessionToken: () => this.credentials?.session_token,
      intervalSeconds: this.credentials?.heartbeat_seconds ?? 15,
      renew: () => this.renewSession(),
      onGrant: (grant) => this.useGrant(grant),
      onEnded: (error) => this.sessionEnded(error),
      outageGraceSeconds: this.options.heartbeatOutageGraceSeconds,
      onDegraded: (detail) => {
        if (this.options.onHeartbeatDegraded) this.options.onHeartbeatDegraded(detail);
        else console.warn(`Yoob heartbeat failed (${detail}); retrying while the character keeps rendering.`);
      },
      onRecovered: () => this.options.onHeartbeatRecovered?.(),
    });
    this.monitor = monitor;
    monitor.start();
    document.addEventListener("visibilitychange", this.onVisibility);
    addEventListener("pagehide", this.onPageHide);
  }

  private stopHeartbeat(): void {
    this.monitor?.stop();
    this.monitor = undefined;
    document.removeEventListener("visibilitychange", this.onVisibility);
    removeEventListener("pagehide", this.onPageHide);
  }

  private readonly onVisibility = () => {
    if (document.visibilityState === "visible") void this.monitor?.beatNow();
  };

  private readonly onPageHide = () => {
    if (!this.credentials) return;
    // Best effort: keepalive lets the final beat outlive the page.
    void endSession(this.apiBase, this.credentials.session_token, true).catch(() => undefined);
  };

  private get apiBase(): string {
    return this.apiBaseOf(this.credentials);
  }

  private apiBaseOf(credentials?: YoobCredentials): string {
    return (credentials?.api_base ?? "https://api2.yoob.com").replace(/\/+$/, "");
  }

  /** The API ended the session (it was idle too long): open a new one through the app's backend. */
  private async renewSession(): Promise<void> {
    const next = checkCredentials(await this.options.getCredentials());
    if (this.destroyed) return;
    this.credentials = next;
    this.useGrant(next.download_token);
  }

  private useGrant(grant: string): void {
    if (this.credentials) this.credentials = { ...this.credentials, download_token: grant };
    if (this.access) this.access.downloadToken = grant;
    this.coordinator?.updateDownloadToken(grant);
  }

  /** Rejects as soon as the session ends, so a start in progress doesn't wait on a renderer that was shut down. */
  private unlessStopped<T>(work: Promise<T>): Promise<T> {
    let listener!: (error: YoobError) => void;
    const stopped = new Promise<never>((_, reject) => { listener = reject; });
    this.stopListeners.push(listener);
    return Promise.race([work, stopped]).finally(() => {
      this.stopListeners = this.stopListeners.filter((entry) => entry !== listener);
    });
  }

  /** Ends the current session on the API, best effort, and forgets it. */
  private endCurrentSession(): void {
    const credentials = this.credentials;
    this.credentials = undefined;
    if (credentials) void endSession(this.apiBaseOf(credentials), credentials.session_token).catch(() => undefined);
  }

  /** Heartbeats say the session is over: stop rendering and tell the app. */
  private sessionEnded(error: YoobError): void {
    if (this.destroyed) return;
    this.stoppedError = error;
    this.interrupt();
    this.microphone.stop();
    this.stopHeartbeat();
    this.endCurrentSession();
    this.coordinator?.destroy();
    this.coordinator = undefined;
    this.canvas.style.opacity = "0";
    this.video.removeAttribute("src");
    this.video.load();
    this.setPhase("stopped");
    for (const listener of this.stopListeners.splice(0)) listener(error);
    this.options.onSessionEnded?.(error);
    this.options.onError?.(error);
  }
}

function checkCredentials(value: YoobCredentials): YoobCredentials {
  if (!value || typeof value.session_token !== "string" || !value.session_token
      || typeof value.download_token !== "string" || !value.download_token) {
    throw new YoobError("unauthorized", "getCredentials() didn't return a Yoob session. Check your backend's /yoob-session response.");
  }
  return value;
}

function toYoobError(error: unknown): YoobError {
  if (error instanceof YoobError) return error;
  return new YoobError("renderer", error instanceof Error ? error.message : String(error));
}
