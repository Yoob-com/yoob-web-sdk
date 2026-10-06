// Opening sealed chunks. The CDN seals them so the weights are never plaintext at rest — not on its disk, not on the
// wire, and not in this browser's cache — and this is the only place they come back.
//
// The plaintext exists as an ArrayBuffer and goes straight to the renderer. Nothing here ever writes it anywhere.
import { YoobError } from "./cdn";

const MAGIC = [0x59, 0x4f, 0x42, 0x58]; // "YOBX"
const VERSION = 1;
const ALG_AES_256_GCM = 1;
const FLAG_NONE = 0;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Header length for a key id of `kidLength` bytes: magic, version, alg, flags, kidLen, kid, iv. */
const headerLength = (kidLength: number) => 8 + kidLength + IV_BYTES;

/** Content keys from the session, by key id. A rotation hands out the retired one too, so a cached chunk still opens. */
export interface ContentKeys {
  /** Imported once and non-extractable, so the raw bytes exist only in the session response. */
  keys: Map<string, Promise<CryptoKey>>;
}

/** Imports the base64 keys a session carried. Call once per `CdnAccess`; importing is not free. */
export function contentKeys(raw: Record<string, string> | undefined): ContentKeys | undefined {
  if (!raw) return undefined;
  const keys = new Map<string, Promise<CryptoKey>>();
  for (const [kid, value] of Object.entries(raw)) {
    keys.set(kid, crypto.subtle.importKey("raw", base64(value), "AES-GCM", false, ["decrypt"]));
  }
  return keys.size ? { keys } : undefined;
}

function base64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Whether these bytes are a sealed chunk rather than the chunk itself.
 *
 * The manifest names every chunk's plaintext size, so this is a decision, not a guess: a plaintext chunk is exactly
 * `size` bytes and a sealed one is exactly `header + size + tag`. The magic then confirms it. That is what lets one
 * SDK talk to a CDN that seals and one that does not.
 */
export function isSealed(data: ArrayBuffer, size: number): boolean {
  if (data.byteLength === size) return false;
  const bytes = new Uint8Array(data);
  if (bytes.length < 8 || !MAGIC.every((b, i) => bytes[i] === b)) return false;
  return bytes.length === headerLength(bytes[7]) + size + TAG_BYTES;
}

/**
 * Opens one sealed chunk. `shaHex` is its content address, which the seal is bound to — a chunk served at the wrong
 * address fails here rather than later, at its checksum.
 *
 * Returns plaintext for bytes that were never sealed, so a CDN that does not seal keeps working.
 */
export async function openChunk(
  data: ArrayBuffer, shaHex: string, size: number, content: ContentKeys | undefined,
): Promise<ArrayBuffer> {
  if (!isSealed(data, size)) {
    if (data.byteLength === size) return data;
    const bytes = new Uint8Array(data);
    if (bytes.length >= 8 && MAGIC.every((b, i) => bytes[i] === b)) {
      throw new YoobError("invalid-assets", "A sealed chunk arrived with the wrong length; the download was truncated.");
    }
    throw new YoobError("invalid-assets", `A chunk arrived with the wrong length (${data.byteLength}, expected ${size}).`);
  }

  const bytes = new Uint8Array(data);
  if (bytes[4] !== VERSION || bytes[5] !== ALG_AES_256_GCM || bytes[6] !== FLAG_NONE) {
    throw new YoobError("unsupported", "These character files need a newer @yoob/avatar.");
  }

  const kidLength = bytes[7];
  const start = headerLength(kidLength);
  const kid = new TextDecoder().decode(bytes.subarray(8, 8 + kidLength));

  if (!content) {
    throw new YoobError("unauthorized",
      "This Yoob session carried no content key, so these character files cannot be opened. Fetch a new session from your backend.");
  }
  const key = content.keys.get(kid);
  if (!key) {
    throw new YoobError("unauthorized",
      `This session's content keys cannot open these character files (${kid}). Fetch a new session from your backend.`);
  }

  // The seal covers the header and the chunk's address, so neither can be swapped without failing here.
  const additionalData = new Uint8Array(start + 32);
  additionalData.set(bytes.subarray(0, start));
  additionalData.set(hex(shaHex), start);

  try {
    return await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(start - IV_BYTES, start), additionalData, tagLength: TAG_BYTES * 8 },
      await key,
      bytes.subarray(start),
    );
  } catch {
    throw new YoobError("invalid-assets", "A character file failed authentication; it was altered in transit or stored wrong.");
  }
}

function hex(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}
