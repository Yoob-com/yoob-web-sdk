// The playback worklet resumes an underrun only with a cushion (or after the tail wait), never on each small packet.
import test from "node:test";
import assert from "node:assert/strict";

(globalThis as any).sampleRate = 24000;
(globalThis as any).AudioWorkletProcessor = class { port = { postMessage: () => {}, onmessage: null as unknown } };
// @ts-ignore: a plain-JS worklet module without declarations
const worklet: any = await import("../src/engine/audio/playback-worklet.js");
const { Serve320PlaybackProcessor, RESTART_CUSHION_SECONDS } = worklet;

function processor() {
  const p = new Serve320PlaybackProcessor() as any;
  p.reset(1, false);
  p.started = true;
  return p;
}
const block = () => [[new Float32Array(128)]];
const ms = (n: number) => new Float32Array(Math.round(24 * n)).fill(0.1);

test("a restart after an underrun waits for the cushion until the stream is final", () => {
  const p = processor();
  p.enqueue(ms(20));
  assert.equal(p.running, true, "the first start of an utterance plays at once");
  for (let i = 0; i < 8; i++) p.process([], block());         // 20 ms played, then ~22 ms of underrun
  assert.equal(p.running, false);
  assert.ok(p.underrunDeviceSamples > 0);
  p.enqueue(ms(40));
  assert.equal(p.running, false, "40 ms is below the 160 ms cushion: keep waiting");
  p.enqueue(ms(130));
  assert.equal(p.running, true, "170 ms queued: resume");
  assert.equal(RESTART_CUSHION_SECONDS, 0.16);

  const q = processor();
  q.enqueue(ms(10));
  for (let i = 0; i < 6; i++) q.process([], block());
  q.enqueue(ms(30));
  for (let i = 0; i < 40; i++) q.process([], block());
  assert.equal(q.running, false, "an open stream does not force tiny bursts on a timer");
  q.final = true;
  q.process([], block());
  assert.equal(q.running, true, "a finalized short tail still plays");
});
