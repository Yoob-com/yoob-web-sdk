// A real `YoobAvatar`, with fakes only where the browser and the network begin.
//
// Billing lives in the wiring between a conversation, the avatar, its heartbeat monitor and the console API, so a
// test of billing has to run that wiring rather than a stand-in for it. What is faked here is what Node does not
// have: the DOM the avatar draws into, WebGPU and Web Audio (the renderer and its audio graph, behind
// `createCoordinator`), the CDN with its signed manifests (behind `loadCharacter`), the microphone, and `fetch` —
// which is where the console API is, so every request the SDK makes to it is recorded and can be asserted on.
import { YoobAvatar, type YoobAvatarOptions, type YoobCredentials } from "../../src/index";
import type { AvatarCoordinator } from "../../src/engine/runtime/avatar-coordinator";
import type { RenderCoordinatorCallbacks } from "../../src/engine/runtime/render-coordinator";

type AnyFn = (...args: any[]) => any;

// --- The browser -------------------------------------------------------------------------------------------------

class FakeElement {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  className = "";
  hidden = false;
  muted = false;
  srcObject: unknown = null;
  setAttribute() {}
  removeAttribute() {}
  append() {}
  remove() {}
  load() {}
  pause() {}
  play() { return Promise.resolve(); }
  getContext() { return { drawImage() {} }; }
}

export class FakeTrack {
  readyState = "live";
  stopped = false;
  readonly kind = "audio";
  stop() { this.stopped = true; this.readyState = "ended"; }
}

export class FakeMediaStream {
  constructor(readonly tracks: FakeTrack[] = [new FakeTrack()]) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}

/** Every microphone stream any code opened through `getUserMedia`, so a test can check each was given back. */
export const openedMicrophones: FakeMediaStream[] = [];

let installed = false;
function installBrowser(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as any;
  const listeners = new Map<string, Set<AnyFn>>();
  const target = {
    addEventListener: (type: string, fn: AnyFn) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn); },
    removeEventListener: (type: string, fn: AnyFn) => { listeners.get(type)?.delete(fn); },
  };
  g.document = {
    visibilityState: "visible",
    body: new FakeElement(),
    createElement: () => new FakeElement(),
    ...target,
  };
  g.addEventListener ??= target.addEventListener;
  g.removeEventListener ??= target.removeEventListener;
  g.AudioWorkletNode ??= class {};
  g.MediaStream ??= FakeMediaStream;
  Object.defineProperty(navigator, "gpu", { configurable: true, value: { requestAdapter: async () => ({}) } });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        const stream = new FakeMediaStream();
        openedMicrophones.push(stream);
        return stream;
      },
      enumerateDevices: async () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  });
}

// --- The renderer and its audio graph ----------------------------------------------------------------------------

export class FakeAudio {
  microphoneOpen = false;
  taps = 0;
  onMicPcm?: (pcm: ArrayBuffer) => void;
  onMicrophoneFailure?: (message: string) => void;
  onMicrophoneRecovered?: () => void;
  #tap?: (pcm: Int16Array) => void;
  async activatePlayback() {}
  async enableMicrophone() { this.microphoneOpen = true; }
  disableMicrophone() {}
  releaseMicrophone() { this.microphoneOpen = false; }
  startMicrophoneWatchdog() {}
  async tapMediaStream(_stream: unknown, onPcm: (pcm: Int16Array) => void) { return this.#attach(onPcm); }
  async tapRemoteTrack(_track: unknown, onPcm: (pcm: Int16Array) => void) { return this.#attach(onPcm); }
  stopRemoteTap(cleanup?: () => void) { cleanup?.(); }
  close() {}
  /** The far side's voice arriving on whatever stream or track is tapped. */
  remote(pcm: Int16Array) { this.#tap?.(pcm); }
  /** The user's microphone producing a packet. */
  mic(pcm: Int16Array) { this.onMicPcm?.(pcm.buffer as ArrayBuffer); }
  #attach(onPcm: (pcm: Int16Array) => void) {
    this.taps += 1;
    this.#tap = onPcm;
    return () => { if (this.#tap === onPcm) { this.#tap = undefined; this.taps -= 1; } };
  }
}

export class FakeCoordinator {
  readonly audio = new FakeAudio();
  /** Every chunk of audio the renderer was given, by utterance. */
  readonly rendered: Array<{ response: string; samples: number; final: boolean }> = [];
  stats?: unknown;
  destroyed = false;
  constructor(readonly callbacks: RenderCoordinatorCallbacks) {}
  async initialize() {}
  appendStreamingAudio(response: string, pcm: Int16Array, final = false) {
    this.rendered.push({ response, samples: pcm.length, final });
    // The utterance plays out and the face rests, as the real renderer reports once playback drains.
    if (final) queueMicrotask(() => this.callbacks.onPlaybackEnded?.(0));
    return 0;
  }
  cancel() { return 0; }
  setIdle() {}
  get playedAudioMs() { return 0; }
  updateDownloadToken() {}
  destroy() { this.destroyed = true; }
}

// --- The console API ---------------------------------------------------------------------------------------------

export interface ApiRequest { path: string; token: string }
type Reply = { status: number; body?: unknown };

/**
 * The console API behind `fetch`: `/api/v1/sessions/{start,heartbeat,end}`. Records every request with the session
 * token it carried. `start` and `heartbeat` answer from a queue when one is set, and succeed otherwise; `start` can
 * also be held open to test what happens while it is in flight.
 */
export class FakeApi {
  readonly requests: ApiRequest[] = [];
  readonly startReplies: Reply[] = [];
  readonly heartbeatReplies: Reply[] = [];
  #held?: { release: () => void; promise: Promise<void> };

  constructor() {
    (globalThis as any).fetch = async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const token = ((init.headers as Record<string, string>).authorization ?? "").replace(/^Bearer /, "");
      this.requests.push({ path, token });
      if (path === "/api/v1/sessions/start") {
        if (this.#held) await this.#held.promise;
        return reply(this.startReplies.shift() ?? { status: 200, body: { metered_from: 1 } });
      }
      if (path === "/api/v1/sessions/heartbeat") return reply(this.heartbeatReplies.shift() ?? { status: 200, body: { stop: false } });
      if (path === "/api/v1/sessions/end") return reply({ status: 200, body: {} });
      return reply({ status: 404, body: { error: "not here" } });
    };
  }

  /** Requests to one endpoint (`"start"`, `"heartbeat"` or `"end"`), optionally for one session token. */
  calls(endpoint: "start" | "heartbeat" | "end", token?: string): ApiRequest[] {
    return this.requests.filter((r) => r.path === `/api/v1/sessions/${endpoint}` && (!token || r.token === token));
  }

  /** Holds every `/sessions/start` until the returned function is called. */
  holdStart(): () => void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    this.#held = { release, promise };
    return () => { this.#held = undefined; release(); };
  }
}

function reply({ status, body }: Reply): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

// --- The avatar --------------------------------------------------------------------------------------------------

/** `YoobAvatar` with the GPU renderer and the CDN download replaced; everything else is the shipped class. */
export class TestAvatar extends YoobAvatar {
  coordinatorValue?: FakeCoordinator;
  protected override createCoordinator(callbacks: RenderCoordinatorCallbacks): AvatarCoordinator {
    this.coordinatorValue = new FakeCoordinator(callbacks);
    return this.coordinatorValue as unknown as AvatarCoordinator;
  }
  protected override async loadCharacter(): Promise<void> {
    // The character is "downloaded and warm": the renderer exists, as it does after a real load.
    await this.unlockAudio();
  }
  /** The renderer the avatar is drawing with, or last drew with. */
  get renderer(): FakeCoordinator {
    return this.coordinatorValue!;
  }
}

export interface Harness {
  avatar: TestAvatar;
  api: FakeApi;
  /** How many sessions `getCredentials()` has opened. Session n has token `st_n`. */
  readonly opened: number;
  errors: Array<{ code: string; message: string }>;
  ended: Array<{ code: string; message: string }>;
  phases: string[];
}

/** A real avatar against a fake console API. `prepare()` is not called; tests do that, or the conversation does. */
export function realAvatar(options: Partial<YoobAvatarOptions> = {}, credentials: Partial<YoobCredentials> = {}): Harness {
  installBrowser();
  const api = new FakeApi();
  let opened = 0;
  const errors: Harness["errors"] = [];
  const ended: Harness["ended"] = [];
  const phases: string[] = [];
  const avatar = new TestAvatar({
    container: new FakeElement() as unknown as HTMLElement,
    character: "test-character",
    getCredentials: async () => {
      opened += 1;
      return {
        session_token: `st_${opened}`, download_token: `dl_${opened}`, api_base: "https://console.test",
        heartbeat_seconds: 15, ...credentials,
      };
    },
    onError: (error) => errors.push({ code: error.code, message: error.message }),
    onSessionEnded: (error) => ended.push({ code: error.code, message: error.message }),
    onPhase: (phase) => phases.push(phase),
    ...options,
  });
  return { avatar, api, get opened() { return opened; }, errors, ended, phases };
}

/** Lets promise chains and immediate callbacks settle. Timers do not move: tests mock them and tick explicitly. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 20 ms of audible 24 kHz speech. */
export const speech = (level = 4000): Int16Array => new Int16Array(480).fill(level);
