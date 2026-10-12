// The FeatherTalk engine's pure parts (the Luna app's StreamingAvatar, HostPath, LipWindows, LipCrossfade) without a GPU.
import test from "node:test";
import assert from "node:assert/strict";
import { resample24kTo16k } from "../src/engine/audio/resample-24k-16k";
import { StreamingResampler24To16 } from "../src/engine/feathertalk/resample";
import { CalmHostWindow, LipWindows, PackError, checkPack } from "../src/engine/feathertalk/pack";
import { HostPath } from "../src/engine/feathertalk/host-path";
import { type LipModels, StreamingAvatar, speechBlinkSet } from "../src/engine/feathertalk/streaming";
import { LipCrossfade, LipFade } from "../src/engine/feathertalk/fade";
import { areaResize, lanczosTaps, roundHalfEven } from "../src/engine/feathertalk/image-ops";

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

test("the streaming 24-to-16 kHz resampler equals the one-shot one however the audio is cut", () => {
  const next = random(7);
  const input = Float32Array.from({ length: 24_000 }, () => next() * 2 - 1);
  const whole = resample24kTo16k(input);
  const streaming = new StreamingResampler24To16();
  const parts: Float32Array[] = [];
  for (let at = 0; at < input.length;) {
    const size = 1 + Math.floor(next() * 900);
    parts.push(streaming.push(input.subarray(at, at + size)));
    at += size;
  }
  parts.push(streaming.flush());
  const joined = Float32Array.from(parts.flatMap((p) => Array.from(p)));
  assert.equal(joined.length, whole.length);
  for (let i = 0; i < whole.length; i += 1) assert.ok(Math.abs(joined[i] - whole[i]) < 1e-6, `sample ${i}`);
});

test("lip windows: H08's bootstrap encode, then one 13-21 frame window per feature", () => {
  const w = LipWindows.h08;
  assert.deepEqual(w.encode(0), { low: 0, high: 8, first: 0, last: 8 });
  assert.deepEqual(w.encode(8), { low: 0, high: 13, first: 8, last: 9 });
  assert.deepEqual(w.encode(20), { low: 4, high: 25, first: 20, last: 21 });
  assert.equal(w.past, 10);
  assert.equal(w.fullLookaheadFrames, 13);
  assert.equal(LipWindows.from({ lookahead: 9, left: 16, right: 4, bootstrap: 8 })?.lookahead, 9);
  assert.equal(LipWindows.from({ lookahead: 8, left: 16, right: 4, bootstrap: 8 }), undefined);
  assert.equal(LipWindows.from({ lookahead: 2, left: 20, right: 0, bootstrap: 0 })?.padsBeforeStart, true);
});

const calmJSON = {
  first: 10, count: 1, framesPerHost: 3, twins: [[1, 12]], blinkHosts: [[0, 30]], closedEyes: [[35, 37]],
  lanes: [[0, 12], [13, 20]], closedLipLanes: [[0, 12], [13, 20]], itinerary: [[12, 13], [20, 0]], stays: [10, 8],
  speechLanes: [[30, 40]], speechItinerary: [[40, 30]], speechStays: [12], entries: { 5: 30, 15: 35 }, exits: { 32: 4, 38: 14 },
  pathStart: 10, pathStartRising: true,
};

test("the head path walks the silence lanes in silence and crosses into speech at an entry", () => {
  const window = new CalmHostWindow(calmJSON);
  assert.ok(window.fits(41) && window.hasPath);
  const path = new HostPath(window, window.pathStart);
  assert.equal(path.next(false), 10, "the first frame is the start host");
  const ahead = path.ahead(5, [false, false, false, false, false]);
  assert.equal(path.host, 10, "ahead() does not move the path");
  const hosts = [path.next(false), path.next(false), path.next(false)];
  assert.deepEqual(hosts, ahead.slice(0, 3));
  // Speaking from a host with an entry lands in the speech lane.
  let host = path.host;
  for (let i = 0; i < 60 && !window.isSpeech(host); i += 1) host = path.next(true);
  assert.ok(window.isSpeech(host));
  assert.equal(HostPath.stallLipsClosed(0, 0), 0.25);
  assert.equal(HostPath.stallLipsClosed(3, 0), 1);
});

/** Fake models: the crop's first byte is the host, so the test can see which host each frame was drawn on. */
class FakeModels implements LipModels {
  encodes = 0; renders = 0;
  async encode(samples: Float32Array, frames: number): Promise<Float32Array> {
    this.encodes += 1;
    assert.equal(samples.length, frames * 640 + 80);
    return new Float32Array(frames * 2 * 1024).fill(samples.reduce((a, b) => a + Math.abs(b), 0) / samples.length);
  }
  async render(_window: Float32Array, host: number): Promise<Uint8Array> {
    this.renders += 1;
    const crop = new Uint8Array(12); crop[0] = host; return crop;
  }
}

function pipeline(models: LipModels, lookaheadFrames = 1): StreamingAvatar {
  return new StreamingAvatar(models, LipWindows.h08, new CalmHostWindow(calmJSON), new Float32Array(40 * 1024),
    speechBlinkSet([0, 1, 2]), 12, { lookaheadFrames, batchFrames: 1, standIn: "mirror" });
}

test("instant lips: each frame is drawn once its next frame of audio is in; silence seals and shows the footage", async () => {
  const models = new FakeModels();
  const avatar = pipeline(models);
  const tone = Float32Array.from({ length: 640 * 30 }, (_, i) => 0.3 * Math.sin(i / 7));
  const silence = new Float32Array(640 * 30);
  let last = -1;
  for (let at = 0; at < tone.length; at += 320) last = await avatar.append(tone.subarray(at, at + 320));
  assert.equal(last, 30 - 1 - 1 - 1 + 1, "frames through (available / 640 - 1 - lookahead)");
  for (let at = 0; at < silence.length; at += 320) last = await avatar.append(silence.subarray(at, at + 320));
  last = await avatar.flushTail();
  assert.equal(last, 59);
  const seals: number[] = [], raws: number[] = [];
  for (let frame = 0; frame <= last; frame += 1) {
    const job = avatar.take(frame)!;
    assert.ok(job, `frame ${frame}`);
    seals.push(job.seal); raws.push(job.raw);
    if (job.raw >= 1) assert.equal(job.crop.length, 0, "a sealed frame on a closed-lip lane is the footage: nothing rendered");
  }
  assert.ok(seals.slice(0, 29).every((s) => s === 0), "speech is never sealed");
  // The seal closes over four frames at most a quarter a frame.
  const closing = seals.slice(29);
  for (let i = 1; i < closing.length; i += 1) assert.ok(closing[i] - closing[i - 1] <= 0.25 + 1e-6);
  assert.equal(closing[closing.length - 1], 1);
  assert.ok(models.renders < 60, "silent footage frames skip the renderer");
});

test("a stall walks the head on with the lips closing, until it can hand over to the still idle face", async () => {
  const avatar = pipeline(new FakeModels());
  const tone = Float32Array.from({ length: 640 * 20 }, (_, i) => 0.3 * Math.sin(i / 5));
  for (let at = 0; at < tone.length; at += 320) await avatar.append(tone.subarray(at, at + 320));
  const last = await avatar.flushTail();
  for (let frame = 0; frame <= last; frame += 1) avatar.take(frame);
  avatar.rewindTo(last);
  let handed = false;
  for (let step = 0; step < HostPath.stallFramesLimit && !handed; step += 1) {
    const job = await avatar.stallImage(last);
    assert.ok(job);
    handed = !job.holdsSpeech;
  }
  assert.ok(handed, "the stall reaches a home pose with closed lips");
});

test("the cross-fade reaches half weight when the frame's audio is due", () => {
  const crossfade = new LipCrossfade();
  assert.equal(crossfade.weight(10, 10 * 960), 0.5);
  assert.equal(crossfade.weight(10, 10 * 960 - 480), 0);
  assert.equal(crossfade.weight(10, 10 * 960 + 480), 1);
  assert.equal(crossfade.newestFrame(10 * 960 - 480), 10);
  const fade = new LipFade();
  assert.equal(fade.show(11, 10, 50, 51, 11 * 960 - 240), 0.25);
  assert.equal(fade.refresh(11 * 960), 0.5);
  assert.equal(fade.show(13, 11, 51, 80, 13 * 960), 0.5, "a host jump fades over 120 ms centred on its due time");
  assert.equal(fade.show(30, 13, 80, 81, 30 * 960), 1, "more than one skipped frame steps");
});

test("image ops: rounding, Lanczos taps sum to 2048, area resize of a flat picture stays flat", () => {
  assert.equal(roundHalfEven(2.5), 2);
  assert.equal(roundHalfEven(3.5), 4);
  const taps = lanczosTaps(304, 331);
  for (let d = 0; d < 331; d += 1) {
    const sum = Array.from(taps.weights.subarray(d * 8, d * 8 + 8)).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 2048) <= 4, `taps of ${d} sum to ${sum}`);
  }
  const flat = new Uint8Array(331 * 331 * 3).fill(137);
  assert.ok(areaResize(flat, 331, 304).every((v) => v === 137));
  const up = areaResize(new Uint8Array(375 * 375 * 3).fill(90), 375, 608);
  assert.ok(up.every((v) => v === 90));
});

test("a pack that iOS would refuse is refused", () => {
  assert.throws(() => checkPack({ format: "feathertalk-web", schema: 2 }), PackError);
  assert.throws(() => checkPack({ format: "anime-web" }), PackError);
});
