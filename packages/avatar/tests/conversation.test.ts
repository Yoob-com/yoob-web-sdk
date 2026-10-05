import { test } from "node:test";
import assert from "node:assert/strict";
import { YoobConversation, isAllowedVoiceUrl, voiceCloseError, type YoobVoiceSession } from "../src/conversation";
import { YoobError } from "../src/cdn";
import type { YoobAvatar } from "../src/index";

class FakeSocket {
  static OPEN = 1;
  static last?: FakeSocket;
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  onclose?: (event: { code: number; reason: string }) => void;
  constructor(readonly url: string, readonly protocols: string[]) {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  server(event: object) { this.onmessage?.({ data: JSON.stringify(event) }); }
  serverClose(code: number, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
}
(globalThis as unknown as { WebSocket: typeof FakeSocket }).WebSocket = FakeSocket;

function fakeAvatar() {
  const calls: string[] = [];
  const listeners: Array<(pcm: Int16Array) => void> = [];
  let heard = 0;
  let micStart: () => Promise<void> = async () => undefined;
  let meter: () => Promise<void> = async () => undefined;
  const avatar = {
    prepare: async () => undefined,
    unlockAudio: async () => undefined,
    startMetering: async () => { calls.push("meter-start"); await meter(); },
    endSession: async () => { calls.push("meter-end"); },
    speak: (pcm: Int16Array) => { calls.push(`speak:${pcm.length}`); heard = 1234; },
    endSpeech: () => calls.push("end"),
    interrupt: () => { calls.push("interrupt"); const h = heard; heard = 0; return h; },
    microphone: {
      on: (_: string, fn: (pcm: Int16Array) => void) => { listeners.push(fn); return () => undefined; },
      start: async () => { calls.push("mic-start"); await micStart(); },
      stop: () => calls.push("mic-stop"),
    },
  };
  return {
    avatar: avatar as unknown as YoobAvatar,
    calls,
    mic: (pcm: Int16Array) => listeners.forEach((l) => l(pcm)),
    onMicStart: (fn: () => Promise<void>) => { micStart = fn; },
    onMeterStart: (fn: () => Promise<void>) => { meter = fn; },
  };
}

const b64 = (samples: number[]) => Buffer.from(new Int16Array(samples).buffer).toString("base64");

test("configures a fast, echo-safe session and streams mic audio", async () => {
  const { avatar, mic } = fakeAvatar();
  const convo = new YoobConversation(avatar, { getClientSecret: async () => "ek_test", voice: "marin" });
  await convo.start();
  const socket = FakeSocket.last!;
  assert.deepEqual(socket.protocols, ["realtime", "openai-insecure-api-key.ek_test"]);
  const update = socket.sent[0] as { session: { audio: { input: Record<string, unknown>; output: Record<string, unknown> } } };
  assert.equal(update.session.audio.input.turn_detection && (update.session.audio.input.turn_detection as { type: string }).type, "server_vad");
  assert.deepEqual(update.session.audio.input.noise_reduction, { type: "far_field" });
  assert.equal(update.session.audio.output.speed, 1.08);
  mic(new Int16Array([1, 2]));
  assert.equal(socket.sent.at(-1)?.type, "input_audio_buffer.append");
  assert.equal(socket.sent.at(-1)?.audio, b64([1, 2]));
  assert.equal(convo.state, "listening");
});

test("plays the active reply and barges in with an exact truncate", async () => {
  const { avatar, calls } = fakeAvatar();
  const states: string[] = [];
  const convo = new YoobConversation(avatar, { getClientSecret: async () => "ek", onState: (s) => states.push(s) });
  await convo.start();
  const socket = FakeSocket.last!;
  socket.server({ type: "response.created", response: { id: "r1" } });
  socket.server({ type: "response.output_item.added", response_id: "r1", item: { id: "i1" } });
  socket.server({ type: "response.output_audio.delta", response_id: "r1", delta: b64([5, 6, 7]) });
  assert.ok(calls.includes("speak:3"));
  assert.equal(convo.state, "speaking");
  socket.sent.length = 0;
  socket.server({ type: "input_audio_buffer.speech_started" });
  assert.ok(calls.includes("interrupt"));
  assert.deepEqual(socket.sent.map((e) => e.type), ["response.cancel", "conversation.item.truncate"]);
  assert.equal(socket.sent[1].audio_end_ms, 1234);
  // Late audio from the cancelled reply is ignored.
  const before = calls.length;
  socket.server({ type: "response.output_audio.delta", response_id: "r1", delta: b64([1]) });
  assert.equal(calls.length, before);
  assert.equal(convo.state, "listening");
});

test("finishes incomplete replies but drops failed ones", async () => {
  const { avatar, calls } = fakeAvatar();
  const convo = new YoobConversation(avatar, { getClientSecret: async () => "ek" });
  await convo.start();
  const socket = FakeSocket.last!;
  socket.server({ type: "response.created", response: { id: "r2" } });
  socket.server({ type: "response.output_audio.delta", response_id: "r2", delta: b64([1, 1]) });
  socket.server({ type: "response.done", response: { id: "r2", status: "incomplete" } });
  assert.equal(calls.at(-1), "end");
  assert.ok(!calls.slice(-2).includes("interrupt"));
  socket.server({ type: "response.created", response: { id: "r3" } });
  socket.server({ type: "response.done", response: { id: "r3", status: "failed" } });
  assert.ok(calls.slice(-2).includes("interrupt"));
  convo.stop();
  assert.ok(calls.includes("mic-stop"));
  assert.equal(convo.state, "ended");
});

const RELAY = "wss://voice.yoob.com/v1/realtime?model=gpt-realtime-2.1-mini";
const voiceSession = (token = "yv1.grant"): (() => Promise<YoobVoiceSession>) => async () => ({
  voice_session_id: "vs_1", voice_token: token, url: RELAY, model: "gpt-realtime-2.1-mini",
  max_seconds: 1800, credits_per_minute: 1, expires_at: "2026-09-17T12:05:00Z",
});

test("Yoob voice connects to the relay with the grant subprotocol and sends only voice and instructions", async () => {
  const { avatar, mic } = fakeAvatar();
  const convo = new YoobConversation(avatar, {
    getVoiceSession: voiceSession(),
    voice: "marin",
    instructions: "You are Luna.",
    // Ignored with Yoob voice: the relay sets these.
    model: "gpt-realtime",
    speed: 1.4,
    turnDetection: { type: "semantic_vad" },
    noiseReduction: "near_field",
  });
  await convo.start();
  const socket = FakeSocket.last!;
  assert.equal(socket.url, RELAY);
  assert.deepEqual(socket.protocols, ["realtime", "yoob-voice-grant.yv1.grant"]);
  assert.deepEqual(socket.sent, [
    { type: "session.update", session: { instructions: "You are Luna." } },
    { type: "session.update", session: { audio: { output: { voice: "marin" } } } },
  ]);
  mic(new Int16Array([3, 4]));
  assert.deepEqual(socket.sent.at(-1), { type: "input_audio_buffer.append", audio: b64([3, 4]) });
  assert.equal(convo.state, "listening");
});

test("Yoob voice sends no session.update when the backend sets voice and instructions", async () => {
  const { avatar } = fakeAvatar();
  const convo = new YoobConversation(avatar, { getVoiceSession: voiceSession(), greet: true });
  await convo.start();
  assert.deepEqual(FakeSocket.last!.sent, [{ type: "response.create" }]);
});

test("Yoob voice ignores locked voice and instructions, but reports other relay errors", async () => {
  const { avatar } = fakeAvatar();
  const errors: YoobError[] = [];
  const convo = new YoobConversation(avatar, { getVoiceSession: voiceSession(), voice: "cedar", onError: (e) => errors.push(e) });
  await convo.start();
  const socket = FakeSocket.last!;
  socket.server({ type: "error", error: { code: "yoob_voice_locked", message: "The Yoob voice relay rejected the event: voice_locked." } });
  socket.server({ type: "error", error: { code: "yoob_instructions_locked" } });
  assert.equal(errors.length, 0);
  socket.server({ type: "error", error: { code: "yoob_invalid_audio", message: "rejected: invalid_audio" } });
  assert.equal(errors.length, 1);
  assert.equal(convo.state, "listening");
});

test("Yoob voice keeps playback and barge-in unchanged", async () => {
  const { avatar, calls } = fakeAvatar();
  const convo = new YoobConversation(avatar, { getVoiceSession: voiceSession() });
  await convo.start();
  const socket = FakeSocket.last!;
  socket.server({ type: "response.created", response: { id: "r1" } });
  socket.server({ type: "response.output_item.added", response_id: "r1", item: { id: "i1" } });
  socket.server({ type: "response.output_audio.delta", response_id: "r1", delta: b64([5, 6, 7]) });
  assert.ok(calls.includes("speak:3"));
  assert.equal(convo.state, "speaking");
  socket.sent.length = 0;
  socket.server({ type: "input_audio_buffer.speech_started" });
  assert.deepEqual(socket.sent, [
    { type: "response.cancel", response_id: "r1" },
    { type: "conversation.item.truncate", item_id: "i1", content_index: 0, audio_end_ms: 1234 },
  ]);
  convo.sendText("Hello");
  assert.deepEqual(socket.sent.slice(-2).map((e) => e.type), ["conversation.item.create", "response.create"]);
});

test("a relay close mid-conversation ends it with a clear error", async () => {
  const { avatar, calls } = fakeAvatar();
  const errors: YoobError[] = [];
  const convo = new YoobConversation(avatar, { getVoiceSession: voiceSession(), onError: (e) => errors.push(e) });
  await convo.start();
  FakeSocket.last!.serverClose(4009, "session_time_limit");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "voice-session");
  assert.equal(errors[0].message, "This conversation reached its time limit.");
  assert.deepEqual(errors[0].details, { closeCode: 4009, closeReason: "session_time_limit" });
  assert.equal(convo.state, "ended");
  assert.ok(calls.includes("mic-stop"));
});

test("a relay close while the microphone starts fails start() once", async () => {
  const { avatar, calls, onMicStart } = fakeAvatar();
  const errors: YoobError[] = [];
  const states: string[] = [];
  onMicStart(async () => FakeSocket.last!.serverClose(4002, "grant_expired"));
  const convo = new YoobConversation(avatar, { getVoiceSession: voiceSession(), onError: (e) => errors.push(e), onState: (s) => states.push(s) });
  await assert.rejects(convo.start(), (error: YoobError) => error.details.closeCode === 4002);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "The voice session expired before it connected. Start the conversation again.");
  assert.ok(!states.includes("listening"));
  assert.equal(convo.state, "ended");
  assert.ok(calls.includes("mic-stop"));
});

test("stop() during start() leaves the microphone off", async () => {
  const { avatar, calls, onMicStart } = fakeAvatar();
  let convo!: YoobConversation;
  onMicStart(async () => convo.stop());
  convo = new YoobConversation(avatar, { getVoiceSession: voiceSession() });
  await convo.start();
  assert.equal(convo.state, "ended");
  assert.equal(calls.filter((c) => c === "mic-stop").length, 2);
});

test("maps every relay close code to a user-facing error", () => {
  const expected: Record<number, string> = {
    1011: "The voice service disconnected. Start the conversation again.",
    1013: "Voice is busy right now. Try again in a moment.",
    4000: "The voice service refused this app's request. Update the app and try again.",
    4001: "The voice session was refused. Start the conversation again.",
    4002: "The voice session expired before it connected. Start the conversation again.",
    4003: "This voice session was already used. Start the conversation again.",
    4008: "This conversation reached its usage limit.",
    4009: "This conversation reached its time limit.",
    4010: "The conversation ended because it was idle for too long.",
    4029: "Voice has reached its usage limit for now. Try again later.",
    1006: "The conversation disconnected (1006).",
  };
  for (const [code, message] of Object.entries(expected)) {
    const error = voiceCloseError(Number(code), "why");
    assert.equal(error.code, "voice-session");
    assert.equal(error.message, message);
    assert.equal(error.details.closeCode, Number(code));
  }
});

test("turns Yoob API errors passed through by the backend into YoobErrors", async () => {
  const cases: Array<[unknown, YoobError["code"]]> = [
    [{ code: "quota_exceeded" }, "out-of-credit"],
    [{ error: "Invalid or revoked API key" }, "unauthorized"],
    [{}, "voice-session"],
    [{ voice_token: "t", url: "http://voice.yoob.com/v1/realtime" }, "voice-session"],
  ];
  for (const [body, code] of cases) {
    const { avatar } = fakeAvatar();
    const before = FakeSocket.last;
    const convo = new YoobConversation(avatar, { getVoiceSession: async () => body as YoobVoiceSession });
    await assert.rejects(convo.start(), (error: YoobError) => error.code === code);
    assert.equal(FakeSocket.last, before);
    assert.equal(convo.state, "ended");
  }
});

test("needs exactly one way to connect", () => {
  const { avatar } = fakeAvatar();
  assert.throws(() => new YoobConversation(avatar, {}), YoobError);
  assert.throws(() => new YoobConversation(avatar, { getVoiceSession: voiceSession(), getClientSecret: async () => "ek" }), YoobError);
});

test("connects Yoob voice only to *.yoob.com unless voiceHosts says otherwise", async () => {
  for (const url of [
    "wss://evil.example.com/v1/realtime", "wss://yoob.com.evil.com/v1/realtime", "wss://evilyoob.com/v1/realtime",
    "wss://user:pw@voice.yoob.com/v1/realtime", "not a url",
  ]) {
    const { avatar } = fakeAvatar();
    const before = FakeSocket.last;
    const convo = new YoobConversation(avatar, { getVoiceSession: async () => ({ voice_token: "t", url }) });
    await assert.rejects(convo.start(), (error: YoobError) => error.code === "voice-session" && /allowed host|wss/.test(error.message), url);
    assert.equal(FakeSocket.last, before, url);
  }
  const { avatar } = fakeAvatar();
  const selfHosted = "wss://voice.example.com/v1/realtime";
  const convo = new YoobConversation(avatar, {
    getVoiceSession: async () => ({ voice_token: "t", url: selfHosted }), voiceHosts: ["voice.example.com"],
  });
  await convo.start();
  assert.equal(FakeSocket.last?.url, selfHosted);
  convo.stop();
});

test("matches voice hosts exactly or by subdomain", () => {
  assert.ok(isAllowedVoiceUrl("wss://voice.yoob.com/v1/realtime?model=x"));
  assert.ok(isAllowedVoiceUrl("wss://VOICE.Yoob.com./v1/realtime"));
  assert.ok(isAllowedVoiceUrl("wss://eu.voice.yoob.com/v1/realtime"));
  assert.ok(!isAllowedVoiceUrl("wss://yoob.com/v1/realtime"));
  assert.ok(!isAllowedVoiceUrl("ws://voice.yoob.com/v1/realtime"));
  assert.ok(!isAllowedVoiceUrl("wss://voice.yoob.com.attacker.io/"));
  assert.ok(isAllowedVoiceUrl("wss://relay.example.com/", ["*.example.com"]));
  assert.ok(!isAllowedVoiceUrl("wss://relay.example.com/", ["example.com"]));
  assert.ok(!isAllowedVoiceUrl("wss://relay.example.com/", ["*."]));
});

test("the meter starts once the microphone is live, not before", async () => {
  const { avatar, calls } = fakeAvatar();
  const convo = new YoobConversation(avatar, { getVoiceSession: voiceSession() });
  await convo.start();
  // Nothing is billed for connecting or for the permission prompt: the meter starts after the mic does.
  assert.ok(calls.indexOf("meter-start") > calls.indexOf("mic-start"));
  assert.equal(convo.state, "listening");
});

test("a workspace with no credit never reaches listening", async () => {
  const { avatar, calls, onMeterStart } = fakeAvatar();
  const errors: YoobError[] = [];
  const states: string[] = [];
  onMeterStart(async () => { throw new YoobError("out-of-credit", "This Yoob workspace is out of credit."); });
  const convo = new YoobConversation(avatar, { getVoiceSession: voiceSession(), onError: (e) => errors.push(e), onState: (s) => states.push(s) });
  await assert.rejects(convo.start(), (error: YoobError) => error.code === "out-of-credit");
  assert.equal(errors.length, 1);
  assert.ok(!states.includes("listening"));
  assert.ok(calls.includes("mic-stop"));
});

test("stop() ends the metered session so nothing accrues afterwards", async () => {
  const { avatar, calls } = fakeAvatar();
  const convo = new YoobConversation(avatar, { getVoiceSession: voiceSession() });
  await convo.start();
  convo.stop();
  assert.ok(calls.includes("meter-end"));
  assert.equal(convo.state, "ended");
});
