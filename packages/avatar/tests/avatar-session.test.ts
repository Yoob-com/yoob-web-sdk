import { test } from "node:test";
import assert from "node:assert/strict";
import { YoobError } from "../src/index";
import { realAvatar, settle, speech } from "./support/real-avatar";

test("a real avatar opens a session on prepare(), meters on request and ends it on endSession()", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { avatar, api, phases } = realAvatar();
  await avatar.prepare();
  assert.equal(avatar.phase, "ready");
  assert.deepEqual(phases, ["downloading", "ready"]);
  assert.equal(api.calls("start").length, 0, "preparing is not metered");

  await avatar.startMetering();
  assert.deepEqual(api.calls("start").map((r) => r.token), ["st_1"]);

  t.mock.timers.tick(15_000);
  await settle();
  assert.deepEqual(api.calls("heartbeat").map((r) => r.token), ["st_1"], "heartbeats bill the open session");

  await avatar.endSession();
  assert.deepEqual(api.calls("end").map((r) => r.token), ["st_1"]);
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(api.calls("heartbeat").length, 1, "no heartbeats after the session ended");
});

test("speak() after the session was ended refuses rather than render unmetered, until a new session opens", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { avatar, api } = realAvatar();
  await avatar.prepare();
  avatar.speak(speech());
  avatar.endSpeech();
  await settle();
  assert.deepEqual(api.calls("start").map((r) => r.token), ["st_1"]);
  await avatar.endSession();
  const rendered = avatar.renderer.rendered.length;

  assert.throws(() => avatar.speak(speech()), (error: YoobError) => {
    assert.equal(error.code, "session-ended");
    assert.match(error.message, /prepare\(\)/);
    return true;
  });
  await settle();
  assert.equal(avatar.renderer.rendered.length, rendered, "nothing was rendered");
  assert.equal(api.calls("start").length, 1, "and no session was quietly metered");
  assert.equal(avatar.phase, "ready", "the character is still on screen");

  // A new session makes it speak again, metered.
  await avatar.prepare();
  avatar.speak(speech());
  await settle();
  assert.ok(avatar.renderer.rendered.length > rendered);
  assert.deepEqual(api.calls("start").map((r) => r.token), ["st_1", "st_2"]);
});
