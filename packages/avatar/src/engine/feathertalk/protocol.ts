import type { CharacterManifest } from "../../cdn";

/** Where a pack's files come from: the Yoob CDN (signed manifest, verified chunks) or a plain URL (development). */
export type PackSource =
  | { kind: "cdn"; cdnBase: string; downloadToken: string; manifest: CharacterManifest; pack: string }
  | { kind: "url"; base: string };

export interface FeatherTalkOptions {
  /** Display cross-fades between lip frames (`blend`) or whole frames (`step`). */
  cadence: "blend" | "step";
  /**
   * Offline (parity runs): every rendered frame is composed in order, without the audio clock, and handed to
   * `onCapture` (its face window); nothing waits for display.
   */
  offline?: { faceWindow: number; dump?: number[] };
  /** ONNX Runtime WebAssembly path (the CDN copy in production). */
  ortWasmUrl?: string;
  /** Use the H.264 host video even where HEVC decodes (tests). */
  preferH264?: boolean;
}

export type FTMainToWorker =
  | { type: "init"; source: PackSource; canvas?: OffscreenCanvas; options: FeatherTalkOptions; timeOrigin: number }
  | { type: "begin"; utterance: number }
  /** 24 kHz mono samples of the utterance. */
  | { type: "audio"; utterance: number; samples: Float32Array }
  | { type: "end"; utterance: number }
  /** The audible position of the utterance: `samples` (24 kHz) heard at absolute time `at` (ms since the Unix epoch). */
  | { type: "clock"; utterance: number; samples: number; at: number; started: boolean }
  | { type: "drained"; utterance: number }
  | { type: "cancel" }
  | { type: "grant"; downloadToken: string }
  | { type: "stats" };

export interface FTStats {
  frames: number; renders: number; encodes: number; standInEncodes: number;
  encodeMs: number; renderMs: number; composeMs: number; composed: number;
  shown: number; skipped: number; late: number; hostDecodeMs: number; hostGroups: number;
  syncSamples: number[];
  video: string;
  adapter?: string;
  loadTimings?: Record<string, number>;
}

export type FTWorkerToMain =
  | { type: "progress"; loadedBytes: number; totalBytes: number }
  | { type: "ready"; name: string; width: number; height: number; voiceDelayMs: number; leadMs: number; video: string; adapter: string }
  | { type: "first-frame" }
  | { type: "frame-ready"; utterance: number; frame: number }
  | { type: "idle" }
  /** One utterance's frames: shown, and shown later than half a frame past their audio. */
  | { type: "utterance"; utterance: number; shown: number; late: number }
  /** The lip models cost more GPU time than a frame lasts here: frames are now drawn in pairs (`batchFrames` 2). */
  | { type: "slow"; msPerFrame: number }
  | { type: "capture"; frame: number; host: number; x: number; y: number; side: number; pixels: Uint8Array; raw: number; blink: number | null;
      seal: number; crop?: Uint8Array; window?: Float32Array }
  | { type: "offline-done"; frames: number; stats: FTStats }
  | { type: "stats"; stats: FTStats }
  | { type: "error"; message: string };
