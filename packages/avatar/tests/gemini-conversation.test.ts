import { test } from "node:test";
import assert from "node:assert/strict";
import { GEMINI_LIVE_URL, YoobGeminiConversation } from "../src/gemini-conversation";
import { YoobError } from "../src/cdn";
import type { YoobAvatar } from "../src/index";
import { realAvatar, settle } from "./support/real-avatar";

type Message = Record<string, any>;

class FakeSocket {
  static OPEN = 1;
  static last?: FakeSocket;
  static onSetup: (socket: FakeSocket) => void = (socket) => socket.server({ setupComplete: {} }, true);
  readyState = 1;
  binaryType = "blob";
  sent: Message[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  onclose?: (event: { code: number; reason: string }) => void;
  constructor(readonly url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(data: string) {
    const message = JSON.parse(data) as Message;
    this.sent.push(message);
    if (message.setup) queueMicrotask(() => FakeSocket.onSetup(this));
  }
  close() { this.readyState = 3; }
  /** Gemini sends JSON in binary frames; `binary` exercises that path. */
  server(message: object, binary = false) {
    const text = JSON.stringify(message);
    this.onmessage?.({ data: binary ? new TextEncoder().encode(text).buffer : text });
  }
  drop(code: number, reason: string) { this.readyState = 3; this.onclose?.({ code, reason }); }
}
(globalThis as unknown as { WebSocket: typeof FakeSocket }).WebSocket = FakeSocket;

function fakeAvatar() {
  const calls: string[] = [];
  const spoken: Int16Array[] = [];
  const listeners: Array<(pcm: Int16Array) => void> = [];
  const avatar = {
    phase: "ready",
    prepare: async () => undefined,
    unlockAudio: async () => undefined,
    startMetering: async () => { calls.push("meter-start"); },
    endSession: async () => { calls.push("meter-end"); },
    speak: (pcm: Int16Array) => { calls.push(`speak:${pcm.length}`); spoken.push(pcm); avatar.phase = "speaking"; },
    endSpeech: () => calls.push("end"),
    interrupt: () => { calls.push("interrupt"); avatar.phase = "ready"; return 0; },
    microphone: {
      on: (_: string, fn: (pcm: Int16Array) => void) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },
      start: async () => calls.push("mic-start"),
      stop: () => calls.push("mic-stop"),
    },
  };
  return {
    avatar: avatar as unknown as YoobAvatar, raw: avatar, calls, spoken,
    mic: (pcm: Int16Array) => listeners.forEach((l) => l(pcm)),
  };
}

const b64 = (samples: Int16Array | number[]) =>
  Buffer.from(Int16Array.from(samples).buffer).toString("base64");
const decode = (text: string) => { const b = Buffer.from(text, "base64"); return new Int16Array(b.buffer, b.byteOffset, b.length / 2); };
const audio = (samples: number[], rate = 24_000) =>
  ({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: `audio/pcm;rate=${rate}`, data: b64(samples) } }] } } });

test("connects with the ephemeral token and sends a complete setup first", async () => {
  const { avatar } = fakeAvatar();
  const convo = new YoobGeminiConversation(avatar, {
    getToken: async () => "auth_tokens/abc+/=",
    voice: "Kore",
    systemInstruction: "You are Luna.",
  });
  await convo.start();
  const socket = FakeSocket.last!;
  assert.equal(socket.url, `${GEMINI_LIVE_URL}?access_token=auth_tokens%2Fabc%2B%2F%3D`);
  assert.ok(socket.url.includes("BidiGenerateContentConstrained"));
  assert.equal(socket.binaryType, "arraybuffer");
  assert.deepEqual(socket.sent[0], {
    setup: {
      model: "models/gemini-3.8-live",
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
      },
      systemInstruction: { parts: [{ text: "You are Luna." }] },
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
          endOfSpeechSensitivity: "END_SENSITIVITY_HIGH",
          prefixPaddingMs: 100,
          silenceDurationMs: 450,
        },
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  });
  assert.equal(socket.sent.length, 1);
  assert.equal(convo.state, "listening");
  convo.stop();
});

test("options change the model, VAD and transcription, and greet sends a user turn", async () => {
  const { avatar } = fakeAvatar();
  const states: string[] = [];
  const convo = new YoobGeminiConversation(avatar, {
    getToken: async () => "t",
    model: "models/gemini-3.8-live-extended-thinking",
    activityDetection: { startSensitivity: "low", endSensitivity: "low", prefixPaddingMs: 20, silenceDurationMs: 800 },
    inputTranscription: false,
    outputTranscription: false,
    greet: "Say hi in Spanish.",
    onState: (s) => states.push(s),
  });
  await convo.start();
  const [first, second] = FakeSocket.last!.sent;
  assert.equal(first.setup.model, "models/gemini-3.8-live-extended-thinking");
  assert.equal(first.setup.generationConfig.speechConfig, undefined);
  assert.equal(first.setup.systemInstruction, undefined);
  assert.deepEqual(first.setup.realtimeInputConfig.automaticActivityDetection, {
    disabled: false, startOfSpeechSensitivity: "START_SENSITIVITY_LOW", endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
    prefixPaddingMs: 20, silenceDurationMs: 800,
  });
  assert.equal("inputAudioTranscription" in first.setup, false);
  assert.equal("outputAudioTranscription" in first.setup, false);
  assert.deepEqual(second, { clientContent: { turns: [{ role: "user", parts: [{ text: "Say hi in Spanish." }] }], turnComplete: true } });
  assert.deepEqual(states, ["connecting", "listening", "thinking"]);
  convo.stop();
});

test("microphone audio is resampled to 16 kHz and sent only after setup completes", async () => {
  const { avatar, mic } = fakeAvatar();
  const convo = new YoobGeminiConversation(avatar, { getToken: async () => "t" });
  await convo.start();
  const socket = FakeSocket.last!;
  const packet = Int16Array.from({ length: 480 }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24_000)));
  for (let i = 0; i < 10; i += 1) mic(packet);
  const chunks = socket.sent.slice(1);
  assert.ok(chunks.length >= 9);
  let total = 0;
  for (const chunk of chunks) {
    assert.deepEqual(Object.keys(chunk), ["realtimeInput"]);
    assert.equal(chunk.realtimeInput.audio.mimeType, "audio/pcm;rate=16000");
    total += decode(chunk.realtimeInput.audio.data).length;
  }
  assert.ok(Math.abs(total - 3_200) <= 8, `sent ${total} samples for 200 ms`);
  convo.stop();
  mic(packet);
  assert.equal(socket.sent.length, chunks.length + 1);
});

test("plays model audio, streams transcripts and ends the utterance on turnComplete", async () => {
  const { avatar, raw, calls, spoken } = fakeAvatar();
  const user: Array<[string, boolean]> = [];
  const assistant: Array<[string, boolean]> = [];
  const convo = new YoobGeminiConversation(avatar, {
    getToken: async () => "t",
    onUserTranscript: (t, f) => user.push([t, f]),
    onAssistantTranscript: (t, f) => assistant.push([t, f]),
  });
  await convo.start();
  const socket = FakeSocket.last!;
  socket.server({ serverContent: { inputTranscription: { text: "Hola," } } });
  socket.server({ serverContent: { inputTranscription: { text: " qué tal" } } }, true);
  assert.deepEqual(user, [["Hola,", false], ["Hola, qué tal", false]]);
  socket.server(audio([1, 2, 3, 4]), true);
  assert.deepEqual([...spoken[0]], [1, 2, 3, 4]);
  assert.equal(convo.state, "speaking");
  assert.deepEqual(user.at(-1), ["Hola, qué tal", true]);
  socket.server({ serverContent: { outputTranscription: { text: "Muy " } } });
  socket.server({ serverContent: { outputTranscription: { text: "bien." } } });
  assert.deepEqual(assistant, [["Muy ", false], ["Muy bien.", false]]);
  socket.server({ serverContent: { generationComplete: true } });
  assert.equal(calls.at(-1), "end");
  socket.server({ serverContent: { turnComplete: true } });
  assert.deepEqual(assistant.at(-1), ["Muy bien.", true]);
  assert.equal(convo.state, "speaking", "still playing");
  raw.phase = "ready";
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(convo.state, "listening");
  // The next user utterance starts a fresh caption.
  socket.server({ serverContent: { inputTranscription: { text: "Gracias" } } });
  assert.deepEqual(user.at(-1), ["Gracias", false]);
  // Audio at another rate is converted to the avatar's 24 kHz.
  socket.server(audio(Array(1600).fill(1000), 16_000));
  assert.ok(Math.abs(spoken.at(-1)!.length - 2400) <= 16);
  assert.ok(!calls.includes("interrupt"));
  convo.stop();
});

test("interruption stops the avatar at once and closes the reply", async () => {
  const { avatar, calls } = fakeAvatar();
  const assistant: Array<[string, boolean]> = [];
  const convo = new YoobGeminiConversation(avatar, { getToken: async () => "t", onAssistantTranscript: (t, f) => assistant.push([t, f]) });
  await convo.start();
  const socket = FakeSocket.last!;
  socket.server(audio([5, 6]));
  socket.server({ serverContent: { outputTranscription: { text: "Let me tell you a long" } } });
  socket.server({ serverContent: { interrupted: true } });
  assert.equal(calls.at(-1), "interrupt");
  assert.equal(convo.state, "listening");
  assert.deepEqual(assistant.at(-1), ["Let me tell you a long", true]);
  socket.server({ serverContent: { turnComplete: true } });
  assert.equal(convo.state, "listening");
  // The next reply starts a fresh transcript.
  socket.server({ serverContent: { outputTranscription: { text: "Sure." } } });
  assert.deepEqual(assistant.at(-1), ["Sure.", false]);
  socket.sent.length = 0;
  convo.sendText("Tell me a joke");
  assert.deepEqual(socket.sent, [{ realtimeInput: { text: "Tell me a joke" } }]);
  assert.equal(calls.at(-1), "interrupt");
  assert.equal(convo.state, "thinking");
  convo.stop();
});

test("setup errors reject start; later disconnects and goAway are reported", async () => {
  const saved = FakeSocket.onSetup;
  FakeSocket.onSetup = (socket) => socket.drop(1008, "Unauthenticated: token expired");
  const failed = fakeAvatar();
  const errors: YoobError[] = [];
  const bad = new YoobGeminiConversation(failed.avatar, { getToken: async () => "old", onError: (e) => errors.push(e) });
  await assert.rejects(bad.start(), /1008: Unauthenticated: token expired/);
  assert.equal(bad.state, "ended");
  assert.equal(errors.length, 1);
  assert.ok(!failed.calls.includes("mic-start"));

  FakeSocket.onSetup = (socket) => socket.server({ error: { code: 400, message: "Invalid voice" } });
  await assert.rejects(new YoobGeminiConversation(fakeAvatar().avatar, { getToken: async () => "t" }).start(), /Invalid voice/);
  FakeSocket.onSetup = saved;

  const tokenFailure = new YoobGeminiConversation(fakeAvatar().avatar, { getToken: async () => { throw new Error("backend down"); } });
  await assert.rejects(tokenFailure.start(), (e: unknown) => e instanceof YoobError && e.message === "backend down");

  const live = fakeAvatar();
  const later: YoobError[] = [];
  const away: string[] = [];
  const convo = new YoobGeminiConversation(live.avatar, { getToken: async () => "t", onError: (e) => later.push(e), onGoAway: (t) => away.push(t) });
  await convo.start();
  const socket = FakeSocket.last!;
  socket.server({ goAway: { timeLeft: "30s" } });
  assert.deepEqual(away, ["30s"]);
  socket.server({ error: { code: 429, message: "Quota exceeded" } });
  assert.equal(later.at(-1)?.message, "Quota exceeded");
  socket.drop(1011, "Internal error");
  assert.match(later.at(-1)!.message, /1011: Internal error/);
  assert.equal(convo.state, "ended");
  assert.ok(live.calls.includes("mic-stop"));
});

test("Gemini starts the meter when the microphone goes live and ends the session on stop()", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = realAvatar();
  const convo = new YoobGeminiConversation(h.avatar, { getToken: async () => "auth_tokens/x" });
  await convo.start();
  // The user may talk for a while before the first reply: that is billed, so the meter cannot wait for speak().
  assert.deepEqual(h.api.calls("start").map((r) => r.token), ["st_1"], "metered before anything was said");
  assert.equal(h.avatar.renderer.rendered.length, 0);

  convo.stop();
  await settle();
  assert.deepEqual(h.api.calls("end").map((r) => r.token), ["st_1"], "stop() ends the session");
  const beats = h.api.calls("heartbeat").length;
  for (let i = 0; i < 4; i += 1) { t.mock.timers.tick(15_000); await settle(); }
  assert.equal(h.api.calls("heartbeat").length, beats, "nothing is billed after stop()");
  assert.equal(h.avatar.renderer.audio.microphoneOpen, false);
});

test("a Gemini workspace with no credit never reaches listening", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = realAvatar();
  h.api.startReplies.push({ status: 402, body: { code: "quota_exceeded", error: "This workspace is out of credit." } });
  const states: string[] = [];
  const convo = new YoobGeminiConversation(h.avatar, { getToken: async () => "auth_tokens/x", onState: (s) => states.push(s) });
  await assert.rejects(convo.start(), (error: YoobError) => error.code === "out-of-credit");
  assert.ok(!states.includes("listening"));
  assert.equal(h.avatar.renderer.audio.microphoneOpen, false, "the microphone is given back");
  assert.equal(FakeSocket.last!.readyState, 3, "and Gemini is hung up on");
});

test("stop() while a Gemini start() is fetching its token leaves no socket, microphone or meter", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = realAvatar();
  let release!: (token: string) => void;
  const before = FakeSocket.last;
  const convo = new YoobGeminiConversation(h.avatar, { getToken: () => new Promise((resolve) => { release = resolve; }) });
  const starting = convo.start();
  await settle();
  convo.stop();
  release("auth_tokens/x");
  await starting.catch(() => undefined);
  await settle();
  assert.equal(FakeSocket.last, before, "no socket was opened");
  assert.equal(h.avatar.renderer.audio.microphoneOpen, false);
  assert.equal(h.api.calls("start").length, 0, "nothing was metered");
  assert.equal(convo.state, "ended");
});
