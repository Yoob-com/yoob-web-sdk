// The console ends a session that has not started metering within two minutes of opening, with a heartbeat reply of
// `{ stop: true, reason: "unmetered" }`. That is not a failure and not a reason to open a new session at once -- an
// idle page doing that would open one every two minutes, into the integrator's per-key rate limit. The session goes
// dormant: the character stays on screen, nothing beats, and the next startMetering() reopens it first.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { YoobError } from "../src/index";
import { YoobWebRTCConversation } from "../src/webrtc-conversation";
import { realAvatar, settle, speech, type Harness } from "./support/real-avatar";
import { FakePeerConnection, installPeerConnection } from "./support/fake-webrtc";

type T = TestContext;

/** A prepared avatar whose first heartbeat is answered with an unmetered stop. */
async function dormantAvatar(t: T): Promise<Harness> {
  try { t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] }); } catch { /* already, for a second avatar */ }
  const h = realAvatar();
  await h.avatar.prepare();
  h.api.heartbeatReplies.push({ status: 200, body: { stop: true, reason: "unmetered" } });
  t.mock.timers.tick(15_000);
  await settle();
  assert.equal(h.api.calls("heartbeat").length, 1, "the beat that was told the session is unmetered");
  return h;
}

async function aMinutePasses(t: T): Promise<void> {
  for (let i = 0; i < 4; i += 1) { t.mock.timers.tick(15_000); await settle(); }
}

test("an unmetered stop opens no new session and sends no more heartbeats; the character stays", async (t) => {
  const h = await dormantAvatar(t);
  await aMinutePasses(t);
  assert.equal(h.opened, 1, "getCredentials() was not called again");
  assert.equal(h.api.calls("heartbeat").length, 1, "and nothing beats while dormant");
  assert.equal(h.avatar.phase, "ready");
  assert.ok(!h.phases.includes("stopped") && !h.phases.includes("failed"));
  assert.deepEqual(h.errors, [], "it is not an error");
  assert.deepEqual(h.ended, []);
  assert.equal(h.avatar.renderer.destroyed, false, "the loaded character is kept");
});

test("the next startMetering() reopens the session once, then meters it", async (t) => {
  const h = await dormantAvatar(t);
  await h.avatar.startMetering();
  assert.equal(h.opened, 2);
  assert.deepEqual(h.api.calls("start").map((r) => r.token), ["st_2"], "the new session is the one metered");
  await aMinutePasses(t);
  assert.ok(h.api.calls("heartbeat", "st_2").length >= 4, "and heartbeats bill it");
  assert.deepEqual(h.errors, []);
});

test("concurrent startMetering() calls share one reopen and one meter start", async (t) => {
  const h = await dormantAvatar(t);
  await Promise.all([h.avatar.startMetering(), h.avatar.startMetering(), h.avatar.prepare()]);
  assert.equal(h.opened, 2, "one getCredentials() call");
  assert.deepEqual(h.api.calls("start").map((r) => r.token), ["st_2"]);
});

test("speak() on a dormant session reopens it and speaks; after endSession() it still refuses", async (t) => {
  const h = await dormantAvatar(t);
  h.avatar.speak(speech());
  await settle();
  assert.ok(h.avatar.renderer.rendered.length > 0, "the character spoke");
  assert.equal(h.opened, 2);
  assert.deepEqual(h.api.calls("start").map((r) => r.token), ["st_2"], "metered from the first word");

  await h.avatar.endSession();
  assert.throws(() => h.avatar.speak(speech()), (error: YoobError) => error.code === "session-ended");
  assert.equal(h.opened, 2, "an ended session is not reopened behind the app's back");
});

test("a reopen that fails ends the session as a failed renewal does", async (t) => {
  for (const [failure, code, message] of [
    [new Error("backend down"), "session-ended", "The Yoob session ended and a new one couldn't be opened."],
    [new YoobError("out-of-credit", "No credit."), "out-of-credit", "No credit."],
  ] as const) {
    const h = await dormantAvatar(t);
    h.failNextOpen(failure);
    await assert.rejects(h.avatar.startMetering(), (error: YoobError) => error.code === code && error.message === message);
    assert.equal(h.avatar.phase, "stopped");
    assert.deepEqual(h.ended, [{ code, message }], "onSessionEnded");
    assert.deepEqual(h.errors, [{ code, message }], "and onError, once");
    assert.equal(h.api.calls("start").length, 0);
  }
});

test("other stop reasons keep their behaviour: abandoned renews at once, terminal ones stop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const abandoned = realAvatar();
  await abandoned.avatar.prepare();
  abandoned.api.heartbeatReplies.push({ status: 200, body: { stop: true, reason: "abandoned" } });
  t.mock.timers.tick(15_000);
  await settle();
  assert.equal(abandoned.opened, 2, "a new session is opened straight away");
  assert.equal(abandoned.avatar.phase, "ready");
  await abandoned.avatar.endSession();

  const broke = realAvatar();
  await broke.avatar.prepare();
  broke.api.heartbeatReplies.push({ status: 200, body: { stop: true, reason: "out-of-credits" } });
  t.mock.timers.tick(15_000);
  await settle();
  assert.equal(broke.opened, 1);
  assert.equal(broke.avatar.phase, "stopped");
  assert.deepEqual(broke.ended.map((e) => e.code), ["out-of-credit"]);
});

test("a conversation started on a dormant avatar opens a new session and meters it", async (t) => {
  installPeerConnection();
  const h = await dormantAvatar(t);
  const convo = new YoobWebRTCConversation(h.avatar, { getAnswer: async () => ({ sdp: "v=0 answer" }) });
  await convo.start();
  FakePeerConnection.last!.connect();
  assert.equal(h.opened, 2);
  assert.deepEqual(h.api.calls("start").map((r) => r.token), ["st_2"]);
  assert.equal(convo.state, "listening");
  await convo.stop();
  assert.deepEqual(h.api.calls("end").map((r) => r.token), ["st_2"]);
});
