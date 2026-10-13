import { test } from "node:test";
import assert from "node:assert/strict";
import { StatsCollector } from "../src/stats";

test("rates are per window and reset, so a stall shows instead of averaging away", () => {
  const stats = new StatsCollector();
  // A healthy second: 60 draws, 25 frames.
  for (let i = 0; i < 60; i += 1) stats.noteDraw();
  for (let i = 0; i < 25; i += 1) stats.noteFrame();
  const first = stats.sample(performance.now() + 1000);
  assert.ok(Math.abs(first.drawFps - 60) < 1, `drawFps was ${first.drawFps}`);
  assert.ok(Math.abs(first.frameFps - 25) < 1, `frameFps was ${first.frameFps}`);

  // The next second, nothing happens. The window must say so rather than remember the good one.
  const second = stats.sample(performance.now() + 2000);
  assert.equal(Math.round(second.drawFps), 0);
  assert.equal(Math.round(second.frameFps), 0);
});

test("the stall counters count, and clear with the window", () => {
  const stats = new StatsCollector();
  stats.noteHeld(); stats.noteHeld();
  stats.noteDropped(3);
  stats.noteWaiting();
  stats.noteUnderrun(40);
  const first = stats.sample(performance.now() + 1000);
  assert.equal(first.heldFrames, 2);
  assert.equal(first.droppedFrames, 3);
  assert.equal(first.waitingBatches, 1);
  assert.equal(first.underruns, 1);
  assert.equal(first.underrunMs, 40);
  const second = stats.sample(performance.now() + 2000);
  assert.equal(second.heldFrames, 0);
  assert.equal(second.underruns, 0);
});

test("inference times are means, and a skipped stage does not drag them to zero", () => {
  const stats = new StatsCollector();
  stats.noteInference(4, 10, 1);
  // A frame that reused the previous mouth reports no renderer time; it must not count as a fast render.
  stats.noteInference(4, 0, 1);
  const s = stats.sample(performance.now() + 1000);
  assert.equal(s.encoderMs, 4);
  assert.equal(s.rendererMs, 10);
  assert.equal(s.hostMs, 1);
});

test("reply latency is measured from the first audio of a turn to the first sound", () => {
  const stats = new StatsCollector();
  stats.noteReplyAudio(1000);
  // Later audio in the same reply must not move the start.
  stats.noteReplyAudio(1200);
  stats.noteReplyHeard(1500);
  assert.equal(stats.sample(performance.now() + 1000).replyLatencyMs, 500);

  // A reply that was cancelled leaves nothing to measure against.
  const other = new StatsCollector();
  other.noteReplyEnded();
  other.noteReplyHeard(2000);
  assert.equal(other.sample(performance.now() + 1000).replyLatencyMs, undefined);
});
