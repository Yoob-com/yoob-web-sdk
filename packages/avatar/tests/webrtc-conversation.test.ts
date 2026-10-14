import { test } from "node:test";
import assert from "node:assert/strict";
import { YoobWebRTCConversation } from "../src/webrtc-conversation";
import { realAvatar, settle, speech } from "./support/real-avatar";
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
