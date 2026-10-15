// Encrypted packs: sealed chunks are cached as ciphertext and opened in memory with the session's content key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { ChunkStore, releaseContentKey, validateManifest, YoobError, type CharacterManifest, type ManifestChunk } from "../src/cdn";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const KEY_ID = "ck1:astrid:2026.10.15.1:0123456789abcdef0123456789abcdef";

/** The packer's seal (yoob-cdn packer/pack.mjs, shared/content-key.mjs). */
function seal(key: Buffer, piece: Buffer): { sealed: Buffer; chunk: ManifestChunk } {
  const plain = sha(piece);
  const iv = createHash("sha256").update(`yoob-chunk-v1:iv:${plain}`).digest().subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(plain));
  const sealed = Buffer.concat([cipher.update(piece), cipher.final(), cipher.getAuthTag()]);
  return { sealed, chunk: { sha256: sha(sealed), size: sealed.length, plain } };
}

function fixture() {
  const key = randomBytes(32);
  const model = randomBytes(300_000), poster = Buffer.from("plain poster");
  const a = seal(key, model.subarray(0, 200_000)), b = seal(key, model.subarray(200_000));
  const manifest: CharacterManifest = {
    schema: 1, character: "astrid", version: "2026.10.15.1", engine: "realistic-web", displayName: "Astrid", width: 1080,
    height: 1920, poster: "poster.jpg", idle: { frames: [], fps: 25 }, minSDK: "0.6.0",
    encryption: { scheme: "yoob-chunk-v1", alg: "A256GCM", keyId: KEY_ID },
    files: [
      { path: "poster.jpg", size: poster.length, sha256: sha(poster), tier: 0, chunks: [{ sha256: sha(poster), size: poster.length }] },
      { path: "renderer.onnx", size: model.length, sha256: sha(model), tier: 2, chunks: [a.chunk, b.chunk] },
    ],
  };
  const served = new Map<string, Buffer>([[sha(poster), poster], [a.chunk.sha256, a.sealed], [b.chunk.sha256, b.sealed]]);
  return { key, model, poster, manifest, served };
}

/** A Cache Storage stand-in that records what is stored. */
function fakeCaches() {
  const stored = new Map<string, Uint8Array>();
  const cache = {
    match: async (url: string) => (stored.has(url) ? new Response(stored.get(url)!.slice()) : undefined),
    put: async (url: string, response: Response) => { stored.set(url, new Uint8Array(await response.arrayBuffer())); },
    delete: async (url: string) => stored.delete(url),
    keys: async () => [...stored.keys()].map((url) => new Request(url)),
  };
  return { stored, caches: { open: async () => cache, delete: async () => { stored.clear(); return true; } } };
}

function withGlobals<T>(fetchImpl: typeof fetch, cachesImpl: unknown, run: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as { fetch: typeof fetch; caches?: unknown };
  const saved = { fetch: g.fetch, caches: g.caches };
  g.fetch = fetchImpl;
  g.caches = cachesImpl;
  return run().finally(() => { g.fetch = saved.fetch; g.caches = saved.caches; });
}

async function contentKey(raw: Buffer): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, ["decrypt"]);
}

test("an encrypted manifest validates; sealed chunks need the encryption block and their tag bytes", () => {
  const { manifest } = fixture();
  assert.doesNotThrow(() => validateManifest(manifest));
  const noBlock = structuredClone(manifest); delete noBlock.encryption;
  assert.throws(() => validateManifest(noBlock), YoobError);
  const badId = structuredClone(manifest); badId.encryption!.keyId = "ck1:astrid:latest:00";
  assert.throws(() => validateManifest(badId), /not supported/);
  const badSum = structuredClone(manifest); badSum.files[1].size += 16;
  assert.throws(() => validateManifest(badSum), YoobError);
});

test("sealed chunks open in memory with the content key; Cache Storage only ever holds ciphertext", async () => {
  const f = fixture();
  const { stored, caches } = fakeCaches();
  const fetches: string[] = [];
  const fetchImpl = (async (url: string) => {
    fetches.push(url);
    const body = f.served.get(String(url).split("/").pop()!);
    return body ? new Response(body.slice()) : new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  await withGlobals(fetchImpl, caches, async () => {
    const access = { cdnBase: "https://cdn.test", downloadToken: "g", contentKey: await contentKey(f.key) };
    const store = new ChunkStore(access, f.manifest);
    const bytes = new Uint8Array(await store.bytes("renderer.onnx"));
    assert.equal(sha(bytes), sha(f.model));
    assert.equal(sha(new Uint8Array(await store.bytes("poster.jpg"))), sha(f.poster));
    const model = Buffer.from(f.model);
    for (const [url, data] of stored) {
      assert.ok(f.served.has(url.split("/").pop()!), "cached under the served address");
      assert.equal(sha(data), url.split("/").pop(), "cached bytes are what the CDN served");
      if (url.endsWith(f.manifest.files[1].chunks[0].sha256)) assert.equal(Buffer.from(data).indexOf(model.subarray(0, 64)), -1, "no plaintext");
    }
    // A reload opens from the cache without the network.
    fetches.length = 0;
    const again = new ChunkStore(access, f.manifest);
    assert.equal(sha(new Uint8Array(await again.bytes("renderer.onnx"))), sha(f.model));
    assert.deepEqual(fetches, []);
  });
});

test("without the right content key a sealed chunk does not open", async () => {
  const f = fixture();
  const { caches } = fakeCaches();
  const fetchImpl = (async (url: string) => new Response(f.served.get(String(url).split("/").pop()!)!.slice())) as unknown as typeof fetch;
  await withGlobals(fetchImpl, caches, async () => {
    const wrong = new ChunkStore({ cdnBase: "https://cdn.test", downloadToken: "g", contentKey: await contentKey(randomBytes(32)) }, f.manifest);
    await assert.rejects(wrong.bytes("renderer.onnx"), /did not open/);
    const none = new ChunkStore({ cdnBase: "https://cdn.test", downloadToken: "g" }, f.manifest);
    await assert.rejects(none.bytes("renderer.onnx"), /no content key/);
  });
});

test("releaseContentKey: a non-extractable key from the API, refusals end the load", async () => {
  const raw = randomBytes(32);
  const calls: { url: string; init: RequestInit }[] = [];
  let status = 200;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return status === 200
      ? new Response(JSON.stringify({ keys: [{ key_id: KEY_ID, key: raw.toString("base64") }] }), { status })
      : new Response(JSON.stringify({ code: "session_not_live" }), { status });
  }) as unknown as typeof fetch;
  await withGlobals(fetchImpl, undefined, async () => {
    const key = await releaseContentKey("https://api.test/", "tok", KEY_ID);
    assert.equal(calls[0].url, "https://api.test/api/v1/sessions/keys");
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer tok");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { key_ids: [KEY_ID] });
    assert.equal(key.extractable, false);
    await assert.rejects(crypto.subtle.exportKey("raw", key));
    status = 403;
    await assert.rejects(releaseContentKey("https://api.test", "tok", KEY_ID), (e: unknown) => e instanceof YoobError && e.code === "unauthorized");
  });
});
