import { test } from "node:test";
import assert from "node:assert/strict";
import { realAvatar, settle } from "./support/real-avatar";

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
