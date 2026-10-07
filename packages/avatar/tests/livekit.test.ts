import { test } from "node:test";
import assert from "node:assert/strict";
import type { Room } from "livekit-client";
import { YoobLiveKitSession, type YoobLiveKitSessionOptions } from "../src/livekit";
import { YoobError, type YoobAvatar } from "../src/index";

type Fn = (...args: unknown[]) => void;

class FakeTrack {
  readonly kind = "audio";
  constructor(readonly sid: string) {}
}

class FakeParticipant {
  audioTrackPublications = new Map<string, { track?: FakeTrack; isSubscribed: boolean; setSubscribed: (on: boolean) => void }>();
  constructor(
    readonly identity: string,
    public attributes: Record<string, string> = {},
    readonly kind = 0,
    track?: FakeTrack,
  ) {
    if (track) this.publish(track);
  }
  get isAgent() { return this.kind === 4; }
  publish(track: FakeTrack) {
    this.audioTrackPublications.set(track.sid, { track, isSubscribed: true, setSubscribed: () => undefined });
  }
}

class FakeRoom {
  listeners = new Map<string, Set<Fn>>();
  remoteParticipants = new Map<string, FakeParticipant>();
  textHandlers = new Map<string, Fn>();
  mic: Array<{ enabled: boolean; options?: Record<string, unknown> }> = [];
  localParticipant = {
    identity: "user",
    isSpeaking: false,
    trackPublications: new Map([["mic", { trackSid: "TR_user_mic" }]]),
    setMicrophoneEnabled: async (enabled: boolean, options?: Record<string, unknown>) => { this.mic.push({ enabled, options }); },
  };
  constructor(withTextStreams = true) {
    if (!withTextStreams) return;
    Object.assign(this, {
      registerTextStreamHandler: (topic: string, handler: Fn) => {
        if (this.textHandlers.has(topic)) throw new Error("already registered");
        this.textHandlers.set(topic, handler);
      },
      unregisterTextStreamHandler: (topic: string) => this.textHandlers.delete(topic),
    });
  }
  on(event: string, fn: Fn) { (this.listeners.get(event) ?? this.listeners.set(event, new Set()).get(event)!).add(fn); }
  off(event: string, fn: Fn) { this.listeners.get(event)?.delete(fn); }
  emit(event: string, ...args: unknown[]) { for (const fn of this.listeners.get(event) ?? []) fn(...args); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
  join(participant: FakeParticipant) {
    this.remoteParticipants.set(participant.identity, participant);
    this.emit("participantConnected", participant);
  }
  setState(participant: FakeParticipant, state: string) {
    participant.attributes = { ...participant.attributes, "lk.agent.state": state };
    this.emit("participantAttributesChanged", { "lk.agent.state": state }, participant);
  }
  /** Delivers a text stream the way livekit-client does. */
  async stream(topic: string, identity: string, attributes: Record<string, string>, chunks: string[]) {
    const reader = {
      info: { attributes },
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
    };
    this.textHandlers.get(topic)?.(reader, { identity });
    await tick();
  }
}

function fakeAvatar() {
  const calls: string[] = [];
  const taps = new Map<FakeTrack, (pcm: Int16Array) => void>();
  const tags = new WeakMap<Int16Array, number>();
  let meterFails: Error | undefined;
  const avatar = {
    prepare: async () => { calls.push("prepare"); },
    unlockAudio: async () => { calls.push("unlock"); },
    startMetering: async () => {
      calls.push("meter");
      if (meterFails) throw meterFails;
    },
    speak: (pcm: Int16Array) => calls.push(`speak:${tags.get(pcm)}`),
    endSpeech: () => calls.push("end"),
    interrupt: () => { calls.push("interrupt"); return 0; },
    attachAudioTrack: async (track: FakeTrack, onAudio: (pcm: Int16Array) => void) => {
      calls.push(`attach:${track.sid}`);
      taps.set(track, onAudio);
      return () => { calls.push(`detach:${track.sid}`); taps.delete(track); };
    },
  };
  /** One tagged 20 ms packet, loud or silent. */
  const packet = (track: FakeTrack, tag: number, loud = true) => {
    const pcm = new Int16Array(480).fill(loud ? 4000 : 3);
    tags.set(pcm, tag);
    taps.get(track)?.(pcm);
  };
  return {
    avatar: avatar as unknown as YoobAvatar, calls, taps, packet,
    failMetering: (error: Error) => { meterFails = error; },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function setup(options: Partial<YoobLiveKitSessionOptions> = {}, room = new FakeRoom()) {
  const fake = fakeAvatar();
  const states: string[] = [];
  const session = new YoobLiveKitSession(fake.avatar, {
    room: room as unknown as Room,
    onState: (state) => states.push(state),
    ...options,
  });
  return { ...fake, room, session, states };
}

test("finds the agent, taps its audio and publishes the microphone through LiveKit", async () => {
  const room = new FakeRoom();
  room.remoteParticipants.set("viewer", new FakeParticipant("viewer", {}, 0, new FakeTrack("TR_viewer")));
  room.remoteParticipants.set("agent", new FakeParticipant("agent", {}, 4, new FakeTrack("TR_agent")));
  const { session, calls, states } = await setup({}, room);
  await session.start();
  await tick();
  assert.deepEqual(calls.slice(0, 3), ["unlock", "prepare", "attach:TR_agent"]);
  assert.equal(session.agentParticipant?.identity, "agent");
  assert.deepEqual(room.mic, [{
    enabled: true,
    options: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  }]);
  assert.deepEqual(states, ["connecting", "listening"]);
});

test("an agent that joins later is found by its state attribute or identity", async () => {
  const { session, room, calls } = await setup({ agentIdentity: "bot", microphone: false });
  await session.start();
  assert.equal(room.mic.length, 0);
  room.join(new FakeParticipant("other", { "lk.agent.state": "listening" }));
  const track = new FakeTrack("TR_bot");
  const bot = new FakeParticipant("bot");
  room.join(bot);
  bot.publish(track);
  room.emit("trackSubscribed", track, {}, bot);
  await tick();
  assert.equal(session.agentParticipant?.identity, "bot");
  assert.deepEqual(calls.filter((c) => c.startsWith("attach")), ["attach:TR_bot"]);
});

test("without agent state, silence splits utterances and pauses keep their length", async () => {
  const track = new FakeTrack("TR_a");
  const room = new FakeRoom();
  room.remoteParticipants.set("a", new FakeParticipant("a", {}, 4, track));
  const { session, calls, packet, states } = await setup({}, room);
  await session.start();
  await tick();
  calls.length = 0;
  packet(track, 1, false);                         // leading silence is skipped
  packet(track, 2);
  for (let i = 0; i < 10; i += 1) packet(track, 100 + i, false); // 200 ms pause: kept
  packet(track, 3);
  for (let i = 0; i < 30; i += 1) packet(track, 200 + i, false); // 600 ms: ends the utterance
  packet(track, 300, false);
  packet(track, 4);
  assert.deepEqual(calls, [
    "speak:2",
    ...Array.from({ length: 10 }, (_, i) => `speak:${100 + i}`),
    "speak:3",
    "end",
    "speak:4",
  ]);
  assert.deepEqual(states.slice(-3), ["speaking", "listening", "speaking"]);
});

test("with agent state, the reply ends shortly after the agent stops speaking", async () => {
  const track = new FakeTrack("TR_a");
  const agent = new FakeParticipant("a", { "lk.agent.state": "thinking" }, 4, track);
  const room = new FakeRoom();
  room.remoteParticipants.set("a", agent);
  const { session, calls, packet, states } = await setup({}, room);
  await session.start();
  await tick();
  calls.length = 0;
  room.setState(agent, "speaking");
  packet(track, 1);
  for (let i = 0; i < 40; i += 1) packet(track, 100 + i, false); // long pause while speaking: passed through
  packet(track, 2);
  room.setState(agent, "listening");
  packet(track, 3);                                // audio still in flight after the state change
  for (let i = 0; i < 15; i += 1) packet(track, 200 + i, false); // 300 ms tail
  assert.equal(calls.at(-1), "end");
  assert.ok(!calls.includes("interrupt"));
  assert.ok(calls.includes("speak:3"));
  assert.ok(!calls.some((c) => /^speak:2\d\d$/.test(c)), "trailing silence is not played");
  assert.equal(calls.filter((c) => /^speak:1\d\d$/.test(c)).length, 40);
  assert.deepEqual(states, ["connecting", "thinking", "speaking", "listening"]);
});

test("the character stops at once when the user talks over the agent", async () => {
  const track = new FakeTrack("TR_a");
  const agent = new FakeParticipant("a", { "lk.agent.state": "speaking" }, 4, track);
  const room = new FakeRoom();
  room.remoteParticipants.set("a", agent);
  const { session, calls, packet } = await setup({}, room);
  await session.start();
  await tick();
  calls.length = 0;
  packet(track, 1);
  room.emit("activeSpeakersChanged", [room.localParticipant]);
  room.setState(agent, "listening");
  packet(track, 2);                                // stale audio after the cut is dropped
  assert.deepEqual(calls, ["speak:1", "interrupt"]);
  room.emit("activeSpeakersChanged", []);
  room.setState(agent, "thinking");
  room.setState(agent, "speaking");
  packet(track, 3);
  assert.deepEqual(calls.slice(2), ["speak:3"]);
});

test("a fresh user transcript also counts as talking over the agent", async () => {
  const track = new FakeTrack("TR_a");
  const agent = new FakeParticipant("a", { "lk.agent.state": "speaking" }, 4, track);
  const room = new FakeRoom();
  room.remoteParticipants.set("a", agent);
  const users: Array<[string, boolean]> = [];
  const { session, calls, packet } = await setup({ onUserTranscript: (t, f) => users.push([t, f]) }, room);
  await session.start();
  await tick();
  packet(track, 1);
  // Agents publish the user's words for the user's microphone track.
  await room.stream("lk.transcription", "a", { "lk.transcribed_track_id": "TR_user_mic", "lk.transcription_final": "false" }, ["wait"]);
  room.setState(agent, "listening");
  assert.equal(calls.at(-1), "interrupt");
  assert.deepEqual(users, [["wait", false]]);
});

test("transcripts come from LiveKit text streams", async () => {
  const room = new FakeRoom();
  room.remoteParticipants.set("a", new FakeParticipant("a", {}, 4));
  const users: Array<[string, boolean]> = [];
  const agent: Array<[string, boolean]> = [];
  const { session } = await setup({
    microphone: false,
    onUserTranscript: (t, f) => users.push([t, f]),
    onAssistantTranscript: (t, f) => agent.push([t, f]),
  }, room);
  await session.start();
  await room.stream("lk.transcription", "user", { "lk.transcription_final": "true" }, ["hello there"]);
  await room.stream("lk.transcription", "a", { "lk.transcription_final": "false" }, ["Hi", " there", "!"]);
  assert.deepEqual(users, [["hello there", false], ["hello there", true]]);
  assert.deepEqual(agent, [["Hi", false], ["Hi there", false], ["Hi there!", false], ["Hi there!", true]]);
});

test("older rooms fall back to transcription events", async () => {
  const room = new FakeRoom(false);
  room.remoteParticipants.set("a", new FakeParticipant("a", {}, 4));
  const agent: Array<[string, boolean]> = [];
  const { session } = await setup({ microphone: false, onAssistantTranscript: (t, f) => agent.push([t, f]) }, room);
  await session.start();
  const a = room.remoteParticipants.get("a");
  room.emit("transcriptionReceived", [{ id: "s1", text: "Hello", final: false }], a);
  room.emit("transcriptionReceived", [{ id: "s1", text: "Hello world", final: true }], a);
  assert.deepEqual(agent, [["Hello", false], ["Hello world", true]]);
});

test("stop() removes every listener, detaches the track and unpublishes the microphone", async () => {
  const track = new FakeTrack("TR_a");
  const agent = new FakeParticipant("a", { "lk.agent.state": "speaking" }, 4, track);
  const room = new FakeRoom();
  room.remoteParticipants.set("a", agent);
  const { session, calls, packet, taps, states } = await setup({}, room);
  await session.start();
  await tick();
  packet(track, 1);
  const onAudio = taps.get(track)!;
  assert.ok(room.listenerCount() > 0);
  await session.stop();
  assert.equal(room.listenerCount(), 0);
  assert.equal(room.textHandlers.size, 0);
  assert.ok(calls.includes("detach:TR_a"));
  assert.ok(calls.includes("interrupt"));
  assert.deepEqual(room.mic.at(-1), { enabled: false, options: undefined });
  assert.equal(states.at(-1), "ended");
  const before = calls.length;
  onAudio(new Int16Array(480).fill(4000));         // a late packet does nothing
  assert.equal(calls.length, before);
  // It can start again: the text stream topic is free.
  await session.start();
  assert.equal(room.textHandlers.size, 1);
});

test("the agent leaving releases its track; a room disconnect ends the session", async () => {
  const track = new FakeTrack("TR_a");
  const agent = new FakeParticipant("a", {}, 4, track);
  const room = new FakeRoom();
  room.remoteParticipants.set("a", agent);
  const { session, calls, states } = await setup({}, room);
  await session.start();
  await tick();
  room.remoteParticipants.delete("a");
  room.emit("participantDisconnected", agent);
  assert.ok(calls.includes("detach:TR_a"));
  assert.equal(session.agentParticipant, undefined);
  assert.equal(states.at(-1), "connecting");
  room.emit("disconnected");
  await tick();
  assert.equal(session.state, "ended");
  assert.equal(room.listenerCount(), 0);
});

test("the meter starts with the microphone, not with the character's first word", async () => {
  // Billing is the SDK's job, not the room's: an integrator may be running their own LiveKit and their own agent, and
  // Yoob never sees that account. Left to `speak()`, the clock would start at the first reply — so a user talking
  // before any answer would be unbilled, and a character that never speaks would be free.
  const { session, calls } = await setup();
  await session.start();

  assert.ok(calls.includes("meter"), "metering started");
  assert.ok(calls.indexOf("meter") > calls.indexOf("prepare"), "after the character is prepared");
  // No audio has arrived, so nothing has spoken; the meter is running regardless.
  assert.ok(!calls.some((c) => c.startsWith("speak:")), "and before anyone has spoken");
});

test("a workspace with no credit never opens the microphone for long", async () => {
  const fake = fakeAvatar();
  fake.failMetering(new YoobError("out-of-credit", "This Yoob workspace is out of credit."));
  const room = new FakeRoom();
  const session = new YoobLiveKitSession(fake.avatar, { room: room as unknown as Room });

  await assert.rejects(session.start(), (error: YoobError) => error.code === "out-of-credit");
  // Refused before the conversation rather than after it, and the microphone it opened is given back.
  assert.deepEqual(room.mic.map((m) => m.enabled), [true, false]);
});

test("meter: false leaves the meter alone and the room still works", async () => {
  // For an app embedding the avatar in a call it is already billing by its own means.
  const { session, calls } = await setup({ meter: false });
  await session.start();

  assert.ok(!calls.includes("meter"));
  assert.ok(calls.includes("prepare"));
});
