import { test } from "node:test";
import assert from "node:assert/strict";
import { YoobWebRTCConversation } from "../src/webrtc-conversation";
import { openedMicrophones, realAvatar, sessionEndings, settle, speech } from "./support/real-avatar";
import { FakePeerConnection, installPeerConnection } from "./support/fake-webrtc";

installPeerConnection();
const getAnswer = async () => ({ sdp: "v=0 answer" });

test("a WebRTC conversation meters from the connection and ends the session on stop()", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = realAvatar();
  const convo = new YoobWebRTCConversation(h.avatar, { getAnswer });
  await convo.start();
  FakePeerConnection.last!.connect();
  assert.deepEqual(h.api.calls("start").map((r) => r.token), ["st_1"]);
  await convo.stop();
  assert.deepEqual(h.api.calls("end").map((r) => r.token), ["st_1"]);
});

test("meter: false on a WebRTC conversation leaves the meter to the app, even once the character speaks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = realAvatar();
  const convo = new YoobWebRTCConversation(h.avatar, { getAnswer, meter: false });
  await convo.start();
  FakePeerConnection.last!.connect();
  await settle();
  for (let i = 0; i < 5; i += 1) h.avatar.renderer.audio.remote(speech());
  await settle();

  assert.ok(h.avatar.renderer.rendered.length > 0, "the character spoke");
  assert.equal(h.api.calls("start").length, 0, "and nothing started the meter");
  await convo.stop();
});

for (const [ending, end] of sessionEndings) {
  test(`a WebRTC conversation hangs up when ${ending}`, async (t) => {
    // In full mode the model runs on Yoob's OpenAI account: a peer connection that outlives its session is a
    // conversation nobody is paying for.
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const h = realAvatar();
    const errors: string[] = [];
    const states: string[] = [];
    const convo = new YoobWebRTCConversation(h.avatar, {
      getAnswer, onError: (e) => errors.push(e.code), onState: (s) => states.push(s),
    });
    await convo.start();
    FakePeerConnection.last!.connect();
    const microphone = openedMicrophones.at(-1)!;

    await end(h, t);
    assert.equal(convo.state, "ended");
    assert.equal(FakePeerConnection.last!.closed, true, "the peer connection is closed");
    assert.ok(microphone.getTracks().every((track) => track.stopped), "the microphone is released");
    if (ending.includes("credit")) assert.deepEqual(errors, ["out-of-credit"], "and the conversation says why");
    else assert.deepEqual(errors, []);
  });
}

test("stop() while a WebRTC start() waits for its answer releases everything, and start() works again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = realAvatar();
  let answer!: (value: { sdp: string }) => void;
  let held = true;
  const convo = new YoobWebRTCConversation(h.avatar, {
    getAnswer: () => (held ? new Promise((resolve) => { answer = resolve; }) : getAnswer()),
  });
  const starting = convo.start();
  await settle();
  const first = FakePeerConnection.last!;
  const microphone = openedMicrophones.at(-1)!;
  await convo.stop();
  answer({ sdp: "v=0 late" });
  await starting;
  assert.equal(first.closed, true);
  assert.equal(first.remoteDescription, undefined, "the late answer is not applied");
  assert.ok(microphone.getTracks().every((track) => track.stopped));
  assert.equal(h.api.calls("start").length, 0, "nothing was metered");

  held = false;
  await convo.start();
  assert.notEqual(FakePeerConnection.last, first, "a new connection was opened");
  assert.equal(h.api.calls("start").length, 1, "and metered");
  await convo.stop();
});
