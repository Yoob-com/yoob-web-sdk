import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeechGate } from "../src/webrtc-conversation";

const chunk = (level: number, n = 480) => { const pcm = new Int16Array(n); pcm.fill(level); return pcm; };

test("the silence GPT-Live sends between replies never reaches the renderer", () => {
  const gate = new SpeechGate();
  // Measured against the live API: 95% of what arrives while nobody is talking peaks at 1.
  for (let t = 0; t < 10_000; t += 20) {
    assert.equal(gate.accepts(chunk(1), t), false, `silence at ${t}ms`);
  }
});

test("quiet inside a reply still flows, so the mouth keeps its clock", () => {
  const gate = new SpeechGate();
  assert.equal(gate.accepts(chunk(4000), 1000), true, "the voice");
  // The pause between two sentences is shorter than the tail and must not break the reply in half.
  assert.equal(gate.accepts(chunk(0), 1100), true, "100ms gap");
  assert.equal(gate.accepts(chunk(0), 1399), true, "just inside the tail");
  // Long after the voice stopped, the character is at rest again.
  assert.equal(gate.accepts(chunk(0), 1401), false, "past the tail");
});

test("a new reply reopens the gate, and each sound extends it", () => {
  const gate = new SpeechGate();
  gate.accepts(chunk(4000), 0);
  assert.equal(gate.accepts(chunk(0), 500), false, "settled");
  assert.equal(gate.accepts(chunk(4000), 5000), true, "speaks again");
  assert.equal(gate.accepts(chunk(4000), 5300), true, "and again, extending");
  assert.equal(gate.accepts(chunk(0), 5650), true, "still within the tail of the later sound");
  assert.equal(gate.accepts(chunk(0), 5701), false);
});

test("the threshold sits above the model's noise floor and below a real voice", () => {
  const gate = new SpeechGate();
  assert.equal(gate.accepts(chunk(47), 0), false, "47 is the filler");
  assert.equal(gate.accepts(chunk(48), 0), true, "48 is audible");
});
