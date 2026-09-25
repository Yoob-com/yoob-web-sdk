// Character packs on cdn.yoob.com: signed manifests and content-addressed, verified chunks.
// Used by the page (manifest, poster, idle video) and by the render worker (models and banks).

export interface ManifestChunk { sha256: string; size: number }
export interface ManifestFile { path: string; size: number; sha256: string; tier: number; chunks: ManifestChunk[] }

export interface CharacterManifest {
  schema: 1;
  character: string;
  version: string;
  engine: string;
  displayName: string;
  width: number;
  height: number;
  poster: string;
  idle: { frames: string[]; fps: number };
  minSDK: string;
  runtime?: WebRuntimeSettings;
  files: ManifestFile[];
}

export interface WebRuntimeSettings {
  assetVersion: string;
  neuralMouthStride?: 1 | 2;
  rendererInputType?: "float32" | "float16";
  rendererPreferredLayout?: "NCHW" | "NHWC";
  rendererSpatialContract?: unknown;
  rendererTemporalContract?: unknown;
}

export interface CdnAccess {
  cdnBase: string;
  /** Read before every request, so a grant renewed by a heartbeat is used from the next request on. */
  downloadToken: string;
}

export class YoobError extends Error {
  constructor(
    readonly code:
      | "unauthorized" | "out-of-credit" | "network" | "invalid-assets" | "unsupported" | "invalid-audio" | "renderer"
      | "voice-session" | "session-ended",
    message: string,
    /**
     * For `voice-session`: the Yoob voice relay's WebSocket close code and reason, for example 4009
     * `session_time_limit`. For `session-ended`: `reason` is `unreachable` when heartbeats failed for the whole outage
     * grace window.
     */
    readonly details: { closeCode?: number; closeReason?: string; reason?: string } = {},
  ) {
    super(message);
    this.name = "YoobError";
  }
}

export const SDK_VERSION = "0.3.0";

/** Public keys whose manifest signatures the SDK accepts, by key id. */
const SIGNING_KEYS: Record<string, string> = {
  "yoob-2026-09": "QEpH/whI1TpREBfxZzdZG9JNZ9EY9UpQmWu0vqfpi/s=",
};

const CACHE_NAME = "yoob-chunks-v1";
const PARALLEL_CHUNKS = 6;

export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(data: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function versionParts(value: string): number[] | undefined {
  const parts = value.split(".").map(Number);
  return parts.length === 3 && parts.every(Number.isInteger) ? parts : undefined;
}

export function compareVersions(a: string, b: string): number {
  const x = versionParts(a) ?? [0, 0, 0], y = versionParts(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && /^[A-Za-z0-9._/-]+$/.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
const SHA = /^[0-9a-f]{64}$/;

export function validateManifest(manifest: CharacterManifest): void {
  const fail = (why: string) => { throw new YoobError("invalid-assets", `Character manifest rejected: ${why}.`); };
  if (manifest.schema !== 1) throw new YoobError("unsupported", `Manifest schema ${manifest.schema} is not supported.`);
  if (!versionParts(manifest.minSDK) || compareVersions(manifest.minSDK, SDK_VERSION) > 0) {
    throw new YoobError("unsupported", `${manifest.character} ${manifest.version} needs @yoob/avatar ${manifest.minSDK} or newer.`);
  }
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!safePath(file.path) || seen.has(file.path)) fail(`path ${file.path}`);
    seen.add(file.path);
    if (!SHA.test(file.sha256) || file.chunks.reduce((n, c) => n + c.size, 0) !== file.size) fail(`entry ${file.path}`);
    if (!file.chunks.every((c) => SHA.test(c.sha256) && c.size > 0 && c.size <= 16 << 20)) fail(`chunks of ${file.path}`);
  }
  if (!seen.has(manifest.poster)) fail("missing poster");
}

async function request(url: string, access: CdnAccess, signal?: AbortSignal): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400 << attempt));
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${access.downloadToken}`, "x-yoob-sdk": `yoob-web/${SDK_VERSION}` },
        cache: "no-store",
        credentials: "omit",
        mode: "cors",
        signal,
      });
      if (response.ok) return response;
      if (response.status === 401 || response.status === 403) {
        throw new YoobError("unauthorized", "Yoob refused the download grant. Fetch a new session from your backend.");
      }
      if (response.status === 404) throw new YoobError("unsupported", "That character or version is not on the Yoob CDN.");
      lastError = new YoobError("network", `Download failed (HTTP ${response.status}).`);
    } catch (error) {
      if (error instanceof YoobError) throw error;
      if (signal?.aborted) throw error;
      lastError = new YoobError("network", `Download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw lastError;
}

/** Fetches the signed manifest for a character (the newest one unless `version` is set) and verifies it. */
export async function fetchManifest(
  access: CdnAccess, character: string, version?: string, platform = "web",
): Promise<CharacterManifest> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(character)) throw new YoobError("unsupported", `Invalid character id "${character}".`);
  const name = `${version ?? "latest"}${platform === "web" ? ".web" : ""}.json`;
  const response = await request(`${trim(access.cdnBase)}/v1/characters/${character}/${name}`, access);
  const envelope = await response.json() as { keyId: string; payload: string; signature: string };
  const raw = SIGNING_KEYS[envelope.keyId];
  if (!raw) throw new YoobError("invalid-assets", `Unknown manifest signing key ${envelope.keyId}.`);
  const payload = base64ToBytes(envelope.payload);
  const key = await crypto.subtle.importKey("raw", base64ToBytes(raw), { name: "Ed25519" }, false, ["verify"]);
  const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, base64ToBytes(envelope.signature), payload);
  if (!valid) throw new YoobError("invalid-assets", "Character manifest signature did not verify.");
  const manifest = JSON.parse(new TextDecoder().decode(payload)) as CharacterManifest;
  validateManifest(manifest);
  if (manifest.character !== character || (version && manifest.version !== version)) {
    throw new YoobError("invalid-assets", "Character manifest does not match the request.");
  }
  return manifest;
}

function trim(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Downloads files chunk by chunk. Verified chunks are kept in the Cache API under their content address, so a
 * reload or a new character version only fetches chunks it does not have.
 */
export class ChunkStore {
  private cache?: Promise<Cache | undefined>;
  private readonly files = new Map<string, Promise<ArrayBuffer>>();

  constructor(private readonly access: CdnAccess, private readonly manifest: CharacterManifest) {}

  file(path: string): ManifestFile {
    const file = this.manifest.files.find((entry) => entry.path === path);
    if (!file) throw new YoobError("invalid-assets", `${path} is not part of ${this.manifest.character}.`);
    return file;
  }

  /** The verified bytes of one file. `onBytes` reports newly available bytes (cached or downloaded). */
  bytes(path: string, onBytes: (bytes: number, cached: boolean) => void = () => undefined): Promise<ArrayBuffer> {
    let pending = this.files.get(path);
    if (!pending) {
      pending = this.load(this.file(path), onBytes);
      this.files.set(path, pending);
      pending.catch(() => this.files.delete(path));
    }
    return pending;
  }

  private openCache(): Promise<Cache | undefined> {
    this.cache ??= (typeof caches === "undefined" ? Promise.resolve(undefined) : caches.open(CACHE_NAME).catch(() => undefined));
    return this.cache;
  }

  private async load(file: ManifestFile, onBytes: (bytes: number, cached: boolean) => void): Promise<ArrayBuffer> {
    const output = new Uint8Array(file.size);
    const offsets: number[] = [];
    let offset = 0;
    for (const chunk of file.chunks) { offsets.push(offset); offset += chunk.size; }
    let next = 0;
    const worker = async () => {
      while (next < file.chunks.length) {
        const index = next++;
        const data = await this.chunk(file.chunks[index], onBytes);
        output.set(new Uint8Array(data), offsets[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL_CHUNKS, file.chunks.length) }, worker));
    if (await sha256Hex(output) !== file.sha256) {
      throw new YoobError("invalid-assets", `${file.path} failed verification.`);
    }
    return output.buffer;
  }

  private async chunk(chunk: ManifestChunk, onBytes: (bytes: number, cached: boolean) => void): Promise<ArrayBuffer> {
    const url = `${trim(this.access.cdnBase)}/v1/chunks/${chunk.sha256}`;
    const cache = await this.openCache();
    const cached = await cache?.match(url).catch(() => undefined);
    if (cached) {
      const data = await cached.arrayBuffer();
      if (data.byteLength === chunk.size && await sha256Hex(data) === chunk.sha256) {
        onBytes(chunk.size, true);
        return data;
      }
      await cache?.delete(url).catch(() => undefined);
    }
    const response = await request(url, this.access);
    const data = await response.arrayBuffer();
    if (data.byteLength !== chunk.size || await sha256Hex(data) !== chunk.sha256) {
      throw new YoobError("invalid-assets", `Chunk ${chunk.sha256.slice(0, 12)} failed verification.`);
    }
    await cache?.put(url, new Response(data, { headers: { "content-type": "application/octet-stream" } })).catch(() => undefined);
    onBytes(chunk.size, false);
    return data;
  }
}

/** Deletes cached chunks that no manifest in `keep` references. */
export async function pruneChunkCache(keep: CharacterManifest[]): Promise<void> {
  if (typeof caches === "undefined") return;
  const cache = await caches.open(CACHE_NAME).catch(() => undefined);
  if (!cache) return;
  const wanted = new Set(keep.flatMap((m) => m.files.flatMap((f) => f.chunks.map((c) => c.sha256))));
  for (const request of await cache.keys()) {
    const sha = request.url.split("/").pop() ?? "";
    if (!wanted.has(sha)) await cache.delete(request);
  }
}

export async function clearChunkCache(): Promise<void> {
  if (typeof caches !== "undefined") await caches.delete(CACHE_NAME);
}
