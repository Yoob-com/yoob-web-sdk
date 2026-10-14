import { test } from "node:test";
import assert from "node:assert/strict";
import { YoobLiveConversation } from "../src/livekit";
import { realAvatar, settle, type Harness } from "./support/real-avatar";
import { fakeLiveKit } from "./support/fake-livekit";

const room = { url: "wss://agents.test", token: "lk_token" };

/** Heartbeats sent in the next minute of mocked time. */
async function heartbeatsInAMinute(t: { mock: { timers: { tick: (ms: number) => void } } }, h: Harness): Promise<number> {
  const before = h.api.calls("heartbeat").length;
  for (let i = 0; i < 4; i += 1) {
    t.mock.timers.tick(15_000);
    await settle();
  }
  return h.api.calls("heartbeat").length - before;
}

test("stopping a LiveKit conversation ends the metered session, and the next start opens a new one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const livekit = fakeLiveKit();
  t.after(() => livekit.restore());
  const h = realAvatar();
  const convo = new YoobLiveConversation(h.avatar, { getLiveSession: async () => room });

  await convo.start();
  assert.deepEqual(h.api.calls("start").map((r) => r.token), ["st_1"], "metered when the microphone went live");

  await convo.stop();
  assert.deepEqual(h.api.calls("end").map((r) => r.token), ["st_1"], "stop() ends the session it metered");
  assert.equal(await heartbeatsInAMinute(t, h), 0, "nothing is billed after stop()");

  // Coming back later must not reuse a session that was billed while nobody was talking.
  await convo.start();
  assert.deepEqual(h.api.calls("start").map((r) => r.token), ["st_1", "st_2"]);
  await convo.stop();
});

for (const step of ["getLiveSession", "room.connect", "startMetering"] as const) {
  test(`stop() while start() awaits ${step} leaves no room, microphone or meter running`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const livekit = fakeLiveKit();
    t.after(() => livekit.restore());
    const h = realAvatar();
    let releaseSession!: () => void;
    const sessionHeld = new Promise<void>((resolve) => { releaseSession = resolve; });
    const convo = new YoobLiveConversation(h.avatar, {
      getLiveSession: async () => {
        if (step === "getLiveSession") await sessionHeld;
        return room;
      },
    });
    const release = step === "room.connect" ? livekit.holdConnect()
      : step === "startMetering" ? h.api.holdStart()
      : releaseSession;

    const starting = convo.start();
    await settle();
    if (step === "startMetering") assert.equal(h.api.calls("start").length, 1, "the meter request is in flight");
    // stop() resolves once everything is released, which for a meter request in flight means once it has answered.
    const stopping = convo.stop();
    release();
    await stopping;
    await starting.catch(() => undefined);
    await settle();

    assert.equal(livekit.connected, false, "the room is disconnected");
    assert.equal(livekit.microphone, false, "the microphone is not published");
    for (const { token } of h.api.calls("start")) {
      assert.ok(h.api.calls("end", token).length > 0, `the session ${token} that started metering was ended`);
    }
    assert.equal(await heartbeatsInAMinute(t, h), 0, "nothing is billed afterwards");
    assert.equal(convo.state, "ended");
  });
}

test("a LiveKit session in the app's own room ends the meter it started, on stop() or when the room drops", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const livekit = fakeLiveKit();
  t.after(() => livekit.restore());
  const { Room } = await import("livekit-client");
  const { YoobLiveKitSession } = await import("../src/livekit");

  const h = realAvatar();
  const appRoom = new Room();
  await appRoom.connect("wss://app.test", "app_token");
  const session = new YoobLiveKitSession(h.avatar, { room: appRoom });
  await session.start();
  assert.deepEqual(h.api.calls("start").map((r) => r.token), ["st_1"]);
  await session.stop();
  assert.deepEqual(h.api.calls("end").map((r) => r.token), ["st_1"], "stop() ends the session it metered");
  assert.equal(livekit.connected, true, "and leaves the app's room alone");

  await session.start();
  assert.deepEqual(h.api.calls("start").map((r) => r.token), ["st_1", "st_2"]);
  await appRoom.disconnect();
  await settle();
  assert.deepEqual(h.api.calls("end").map((r) => r.token), ["st_1", "st_2"], "a dropped room ends it too");
  assert.equal(await heartbeatsInAMinute(t, h), 0);
});
