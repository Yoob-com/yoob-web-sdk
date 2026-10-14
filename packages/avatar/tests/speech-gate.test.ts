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

/**
 * What the caller must do when the gate closes.
 *
 * The tests above check the gate's arithmetic and stop there, which is how the WebRTC path shipped without ever
 * ending an utterance: `endSpeech()` is the only thing that finalizes the stream, the playback worklet emits
 * `drained` only for a finalized stream, and without `drained` the coordinator never rests, never returns to the
 * idle still and never starts the next utterance. The character rendered one sentence and froze on its last frame.
 */
test("the gate closing ends the utterance, exactly once", () => {
  const gate = new SpeechGate();
  const calls: string[] = [];
  const pump = (pcm: Int16Array, now: number) => {
    const action = gate.update(pcm, now);
    if (action !== "idle") calls.push(action);
  };

  pump(chunk(4000), 0);
  pump(chunk(4000), 20);
  assert.deepEqual(calls, ["speak", "speak"]);

  // Quiet inside the reply keeps flowing: the mouth would lose its clock otherwise.
  pump(chunk(0), 200);
  assert.deepEqual(calls.slice(2), ["speak"]);

  // Past the tail the reply is over, and that has to be said once -- not never, and not on every silent chunk.
  pump(chunk(0), 500);
  pump(chunk(0), 520);
  pump(chunk(0), 2000);
  assert.deepEqual(calls.slice(3), ["end"], "one end, however long the silence runs");
});

test("a reply after the gate closed is a new utterance", () => {
  const gate = new SpeechGate();
  const calls: string[] = [];
  const pump = (pcm: Int16Array, now: number) => {
    const action = gate.update(pcm, now);
    if (action !== "idle") calls.push(action);
  };

  pump(chunk(4000), 0);
  pump(chunk(0), 500);          // settles: "end"
  pump(chunk(4000), 5000);      // the model speaks again
  pump(chunk(0), 5600);         // and settles again
  assert.deepEqual(calls, ["speak", "end", "speak", "end"]);
});

test("update and accepts agree about which audio is speech", () => {
  const a = new SpeechGate(), b = new SpeechGate();
  for (const [level, now] of [[4000, 0], [0, 100], [0, 500], [4000, 900], [0, 2000]] as const) {
    assert.equal(b.update(chunk(level), now) === "speak", a.accepts(chunk(level), now), `at ${now}ms`);
  }
});
