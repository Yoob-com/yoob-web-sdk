// Opening sealed chunks, against the same vector the CDN is checked with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contentKeys, isSealed, openChunk } from "../src/envelope";
import { YoobError } from "../src/cdn";

const vector = JSON.parse(
  readFileSync(new URL("./vectors/chunk-envelope.json", import.meta.url), "utf8"),
) as { keyId: string; keyBase64: string; sha256: string; plaintextBase64: string; envelopeBase64: string };

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const PLAIN = bytes(vector.plaintextBase64);
const SEALED = bytes(vector.envelopeBase64);
const keys = () => contentKeys({ [vector.keyId]: vector.keyBase64 });

const buffer = (data: Uint8Array): ArrayBuffer => data.slice().buffer;

test("opens the chunk the CDN sealed", async () => {
  // The one test that proves the two implementations agree: this envelope was produced by yoob-cdn's node:crypto and
  // is opened here by WebCrypto.
  const opened = await openChunk(buffer(SEALED), vector.sha256, PLAIN.length, keys());
  assert.deepEqual(new Uint8Array(opened), PLAIN);
});

test("tells sealed from plain by length, not by guesswork", () => {
  assert.equal(isSealed(buffer(SEALED), PLAIN.length), true);
  assert.equal(isSealed(buffer(PLAIN), PLAIN.length), false);
  // A plaintext chunk that happens to start with the magic is still plaintext, because its length says so.
  const impostor = new Uint8Array(PLAIN.length);
  impostor.set([0x59, 0x4f, 0x42, 0x58]);
  assert.equal(isSealed(buffer(impostor), PLAIN.length), false);
});

test("passes unsealed chunks straight through, so a CDN that does not seal still works", async () => {
  const opened = await openChunk(buffer(PLAIN), vector.sha256, PLAIN.length, undefined);
  assert.deepEqual(new Uint8Array(opened), PLAIN);
  // And with keys in hand, which is the mixed case: a session that has a key talking to a CDN that does not seal.
  assert.deepEqual(new Uint8Array(await openChunk(buffer(PLAIN), vector.sha256, PLAIN.length, keys())), PLAIN);
});

test("a chunk served at the wrong address fails the seal, not the checksum", async () => {
  await assert.rejects(
    openChunk(buffer(SEALED), "f".repeat(64), PLAIN.length, keys()),
    (error: YoobError) => error.code === "invalid-assets" && /authentication/.test(error.message),
  );
});

test("a session without the right key says so, rather than reporting corruption", async () => {
  await assert.rejects(
    openChunk(buffer(SEALED), vector.sha256, PLAIN.length, undefined),
    (error: YoobError) => error.code === "unauthorized" && /carried no content key/.test(error.message),
  );
  await assert.rejects(
    openChunk(buffer(SEALED), vector.sha256, PLAIN.length, contentKeys({ "some-other-key": vector.keyBase64 })),
    (error: YoobError) => error.code === "unauthorized" && error.message.includes(vector.keyId),
  );
});

test("the wrong key fails authentication", async () => {
  const wrong = btoa(String.fromCharCode(...new Uint8Array(32)));
  await assert.rejects(
    openChunk(buffer(SEALED), vector.sha256, PLAIN.length, contentKeys({ [vector.keyId]: wrong })),
    (error: YoobError) => error.code === "invalid-assets",
  );
});

test("a newer envelope asks for a newer SDK instead of failing obscurely", async () => {
  for (const offset of [4, 5, 6]) {
    const future = SEALED.slice();
    future[offset] = 9;
    await assert.rejects(
      openChunk(buffer(future), vector.sha256, PLAIN.length, keys()),
      (error: YoobError) => error.code === "unsupported" && /newer @yoob\/avatar/.test(error.message),
    );
  }
});

test("a truncated download is named as one", async () => {
  await assert.rejects(
    openChunk(buffer(SEALED.subarray(0, SEALED.length - 8)), vector.sha256, PLAIN.length, keys()),
    (error: YoobError) => error.code === "invalid-assets" && /truncated/.test(error.message),
  );
});

test("the vector matches the CDN's copy", () => {
  // Sibling checkouts, not a monorepo: if both are present they must not have drifted.
  const sibling = new URL("../../../../yoob-cdn/test/vectors/chunk-envelope.json", import.meta.url);
  let theirs: string;
  try {
    theirs = readFileSync(sibling, "utf8");
  } catch {
    return; // Only this repo is checked out; the CDN's own test covers its side.
  }
  assert.deepEqual(JSON.parse(theirs), vector, "the sealed-chunk vector differs between the SDK and the CDN");
});
