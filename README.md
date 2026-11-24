# @yoob/avatar

Talking characters rendered in the browser with WebGPU. You give Yoob speech; it plays the audio and moves the face in
sync, on the visitor's own GPU. Add a microphone and Yoob voice, and you have a live spoken conversation with barge-in,
with no provider key. You can also bring your own OpenAI Realtime, GPT-Live, Gemini Live or LiveKit agent.

- **Light.** About 20 KB gzipped to start. Rendering workers load when a character is created, and character files
  (37 MB) stream from `cdn.yoob.com` in verified chunks cached in the browser. On a good connection the character
  appears in about half a second, and a returning visitor is ready in about one. Encrypted characters (the realistic
  characters since 2026.10.15.1) are cached encrypted: the session asks Yoob for the character's key
  (`POST /api/v1/sessions/keys`, answered only while the session's heartbeats are live) and the SDK decrypts each chunk
  in memory, never storing the decrypted files.
- **Private.** Faces render on the visitor's GPU. Conversation audio goes only to the voice service you choose. See
  [Network](#network).

Works in current desktop Chrome and Edge. Mobile browsers are not supported yet; `YoobAvatar.isSupported()` tells you
before you load anything.

## Install

```sh
npm install @yoob/avatar
```

## Open a session on your backend

Keep your Yoob API key on the server and hand the page a short-lived session. Check who is asking first: every
session is metered to your workspace.

See [What is billed](#what-is-billed) for when a session starts costing money — it is not when you open it.

```js
// POST /yoob-session on your server
const user = await requireSignedInUser(req);            // your auth
await rateLimit(user.id);                               // your limits
const character = ALLOWED.has(req.body.character) ? req.body.character : reject(400);
const response = await fetch("https://app.yoob.com/api/v1/avatar/sessions", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.YOOB_API_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ characters: [character] }), // one character, never "*"
});
return response.json(); // { session_token, download_token, heartbeat_seconds, ... }
```

[`examples/token-server`](examples/token-server/server.mjs) is a runnable version. It refuses every request
until you replace its `requireUser()` with your own sign-in check; `YOOB_EXAMPLE_ALLOW_ANONYMOUS=1` (which
`npm run token-server` sets) turns that off for local development only. See [Security](#security).

### Or: a temporary key, and the page opens its own sessions

Instead of opening every session itself, your server can make a short-lived **temporary key** (`yoob_tmp_…`) with the
`avatar` scope and hand the page only that. The page then calls `/api/v1/avatar/sessions` itself, with the same body
and response as above. The key is billed to your workspace, so check who is asking before you make one:

```js
// POST /yoob-temp-key on your server
const user = await requireSignedInUser(req);            // your auth
const response = await fetch("https://app.yoob.com/api/v1/keys/temporary", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.YOOB_API_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ scopes: ["avatar"], end_user_id: user.id, expires_in: 900, per_minute: 10 }),
});
return response.json(); // { id, key: "yoob_tmp_…", expires_at, scopes, end_user_id, ... }
```

```ts
const tempKey = await fetch("/yoob-temp-key", { method: "POST" }).then((r) => r.json());
const avatar = new YoobAvatar({
  container: document.querySelector("#character")!,
  character: "luna-anime",
  getCredentials: () =>
    fetch("https://app.yoob.com/api/v1/avatar/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${tempKey.key}`, "content-type": "application/json" },
      body: JSON.stringify({ characters: ["luna-anime"] }),
    }).then((r) => r.json()),
});
```

- Sessions opened with the key carry its `end_user_id`, whatever the body says.
- The key lasts 15 minutes by default (`expires_in`, 60 s to 24 h). Ask your server for a new one before
  `expires_at`: an expired or revoked key gets `401 unauthorized`, one without the `avatar` scope `403 key_scope`.
  `max_concurrent` and `per_minute` add limits of the key's own on top of your plan's.
- The page writes the session body, so it chooses the characters, `mode` and anything else in it. Pin prompts and
  restrict characters on a server-opened session instead when that matters.
- Revoke it on sign-out with `DELETE https://app.yoob.com/api/v1/keys/temporary/<id>` (the API key or the temporary
  key itself as the bearer). Revoking the API key ends all its temporary keys.

Every field and error: [Temporary keys](https://app.yoob.com/public/docs/authentication#temporary-keys).

## Show a character

```ts
import { YoobAvatar } from "@yoob/avatar";

const support = await YoobAvatar.isSupported();
if (!support.supported) showFallback(support.reason);

const avatar = new YoobAvatar({
  container: document.querySelector("#character")!,
  character: "luna-anime",
  getCredentials: () => fetch("/yoob-session", { method: "POST" }).then((r) => r.json()),
  onProgress: ({ fraction }) => (bar.value = fraction),
  onPhase: (phase) => console.log(phase), // downloading → warming → ready ⇄ speaking
  onSessionEnded: (error) => showMessage(error.message), // out of credit, refused, or Yoob unreachable for 10 min
});
await avatar.prepare();
```

The character fills its container (`fit: "contain"` letterboxes instead).

The character draws 25 lip frames a second, and by default each one cross-fades into the next at your display's
refresh rate, timed so the lips still meet the audio. The mouth also fades back to the idle face when a reply ends or
is interrupted. `lipCadence: "step"` shows whole lip frames instead, as 0.2 did.

A realistic character's voice is held back 65 ms on its way to the speaker (`displayLatencyMs`), because the browser
shows the face canvas about that much after its frames are drawn. Set `displayLatencyMs: 0` if your page already
delays the voice, or another value if you have measured your own display path.

The voice starts as soon as the face can keep up with it. A reply given whole (`speak()` with all its audio, then
`endSpeech()`) starts once its first lip frames are drawn, about 50-70 ms after `endSpeech()`, and its face is drawn
`displayLatencyMs` ahead instead of the voice being held back: first sound about 80-100 ms after the audio, against
about 200 ms in 0.7.3. Audio streamed faster than real time starts about 50 ms after its first packet; audio streamed
at real time (a live call) waits the character's own delay, about 110 ms, which the lips need for their look-ahead.
`voiceDelayMs` changes that longest wait (50-300 ms); below the character's own, streamed lips can fall behind.

If the session can't continue, the character stops rendering, the phase becomes `stopped`, and `onSessionEnded` and
`onError` receive a `YoobError`: `out-of-credit` when the workspace has no credit left, `unauthorized` when Yoob
refuses the session or its API key was revoked, or `session-ended` when a session reaches its time limit, when
the workspace is suspended, or when Yoob can't be reached for the whole outage grace window (`error.details.reason` is
`unreachable`). `speak()` then throws the same error. Call `prepare()` to open a new session.

A conversation running on the avatar ends with its session: whichever class it is, it hangs up (state `ended`; the
microphone, socket, peer connection or LiveKit room released) and its own `onError` receives the same error. The same
happens, without an error, when the app calls `avatar.destroy()` or `avatar.endSession()`.
`avatar.onSessionEnd(listener)` lets your own code do likewise; it returns a function that removes the listener.

If heartbeats get no answer (network errors, timeouts, 408, 429, 5xx), the character keeps rendering while the SDK
retries (after 2 s, 6 s, then every 15 s). `onHeartbeatDegraded(detail)` fires when that starts and
`onHeartbeatRecovered()` when a heartbeat succeeds again. The character stops only once
`heartbeatOutageGraceSeconds` (default 600, from 0 to 1800) have passed since the last successful heartbeat. Set it to
0 to stop at the first failure.

## Make it talk

```ts
button.onclick = async () => {
  await avatar.unlockAudio();              // browsers allow sound only after a click
  for await (const chunk of myTtsStream()) {
    avatar.speak(chunk);                   // Int16Array, 24 kHz mono
  }
  avatar.endSpeech();
};

const heardMs = avatar.interrupt();        // stop now; returns what was heard
```

A voice at another rate plays at that rate, with its full bandwidth: `avatar.speak(chunk, 48000)` (8-192 kHz, one rate
per utterance). The face follows a 24 kHz copy the SDK makes, on the same clock; don't downsample to 24 kHz yourself,
which loses everything above about 11 kHz.

## Talk with it: Yoob voice

No provider key needed; minutes are billed through your Yoob workspace. Yoob hosts the voice and
tunes it for the characters: server turn detection, far-field noise reduction, captions and a 1.08 speaking speed.

```ts
import { YoobConversation } from "@yoob/avatar";

const conversation = new YoobConversation(avatar, {
  getVoiceSession: () => fetch("/yoob-voice", { method: "POST" }).then((r) => r.json()),
  greet: true,
  onUserTranscript: (text) => (userCaption.textContent = text),
  onAssistantTranscript: (text) => (lunaCaption.textContent = text),
  onState: (state) => console.log(state), // connecting → listening → thinking → speaking
  onError: (error) => (status.textContent = error.message),
});

talkButton.onclick = () => conversation.start();   // asks for the microphone
endButton.onclick = () => conversation.stop();
```

Your backend asks Yoob for a voice session with your API key and returns the response as is:

```js
// POST /yoob-voice on your server
// Voice sessions are still opened by api2.yoob.com; avatar sessions moved to the console.
const response = await fetch("https://api2.yoob.com/api/v1/voice/sessions", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.YOOB_API_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({
    voice: "marin",
    instructions: "You are Luna, a warm, curious companion.", // up to 8,000 characters
    max_seconds: 900,                                       // optional, default 1800
  }),
});
// Build the body yourself. Don't pass the page's request through.
res.status(response.status).json(await response.json());
// 201 { voice_session_id, voice_token, url, model, max_seconds, credits_per_minute, expires_at }
```

- **One session per conversation.** A voice session opens exactly one connection, and its token must be used within 5
  minutes. `start()` calls `getVoiceSession` every time, so don't cache the response.
- **Voice and instructions.** Set them on your backend: the page can't change them, and the prompt never reaches the
  browser. Always send them; otherwise the page decides what the voice says on your bill. `voice` is one of `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin` or
  `cedar`. If the backend leaves them out, the conversation's `voice` and `instructions` options are used instead.
- **Voice host.** The SDK connects only to `wss://*.yoob.com` and refuses any other session `url`. To run your own
  relay, list its host: `voiceHosts: ["voice.example.com"]` (`*.example.com` matches subdomains).
- **Fixed settings.** Yoob sets the model, turn detection, noise reduction, transcription and speed, so those options
  are ignored.
- **Errors.** When the workspace is out of credit, the API answers `402 { "code": "quota_exceeded" }`, and `start()`
  fails with a `YoobError` whose code is `out-of-credit`. A rejected API key becomes `unauthorized`. If the voice
  service ends the call, `onError` receives a `voice-session` error with a message you can show the user.
  `error.details.closeCode` holds the WebSocket close code:

| Close code | Message |
|---|---|
| 4001, 4002, 4003 | The voice session was refused, had expired, or was already used. Start the conversation again. |
| 4008 | This conversation reached its usage limit. |
| 4009 | This conversation reached its time limit (`max_seconds`). |
| 4010 | The conversation ended because it was idle for too long. |
| 4029 | Voice has reached its usage limit for now (too many conversations at once, or the daily quota). Try again later. |
| 1013 | Voice is busy right now. Try again in a moment. |
| 1011 | The voice service disconnected. Start the conversation again. |

`sendText(text)`, captions and barge-in work the same as with your own OpenAI account.

## Talk with it: your own OpenAI account

Pass `getClientSecret` instead of `getVoiceSession`, and OpenAI bills your account directly:

```ts
const conversation = new YoobConversation(avatar, {
  getClientSecret: () => fetch("/openai-secret", { method: "POST" }).then((r) => r.json()).then((s) => s.value),
  voice: "marin",
  instructions: "You are Luna, a warm, curious companion.",
  greet: true,
  onState: (state) => console.log(state),
});
```

Your backend creates the client secret with
[`POST /v1/realtime/client_secrets`](https://platform.openai.com/docs/api-reference/realtime-sessions). The defaults
come from latency measurements on the Yoob demo:

| Setting | Default | Why |
|---|---|---|
| `turnDetection` | `server_vad`, 450 ms silence | Replies start about 0.8 s sooner than `semantic_vad` |
| `noiseReduction` | `far_field` | Laptop and kiosk microphones |
| `speed` | `1.08` | Natural but snappy |

The microphone stays open while the character speaks, so the user can interrupt; the browser's echo canceller removes
the character's voice. In a noisy room, raise `turnDetection.threshold` rather than muting.

## Talk with it: Gemini Live

Bring your own Gemini voice with `YoobGeminiConversation`. It has the same states, transcripts and barge-in as
`YoobConversation`.

```ts
import { YoobGeminiConversation } from "@yoob/avatar";

const conversation = new YoobGeminiConversation(avatar, {
  getToken: () => fetch("/gemini-token", { method: "POST" }).then((r) => r.json()).then((t) => t.name),
  voice: "Kore",
  systemInstruction: "You are Luna, a warm, curious companion.",
  greet: true,
  onUserTranscript: (text) => (userCaption.textContent = text),
  onAssistantTranscript: (text) => (lunaCaption.textContent = text),
  onState: (state) => console.log(state),
});

talkButton.onclick = () => conversation.start();   // asks for the microphone
endButton.onclick = () => conversation.stop();
```

The page never sees your Gemini API key. Your backend creates a single-use
[ephemeral token](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens) and returns its `name`:

```js
// POST /gemini-token on your server
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const token = await ai.authTokens.create({
  config: {
    uses: 1,
    expireTime: new Date(Date.now() + 30 * 60_000).toISOString(),    // messages stop after this
    newSessionExpireTime: new Date(Date.now() + 60_000).toISOString(), // the page must connect before this
    liveConnectConstraints: { model: "gemini-3.8-live" },              // optional: lock the model
  },
});
return { name: token.name };
```

Without the SDK, call `POST https://generativelanguage.googleapis.com/v1beta/auth_tokens` with the
`x-goog-api-key` header and a body of `{ "uses": 1, "expireTime": "…", "newSessionExpireTime": "…" }`. Settings
locked with `liveConnectConstraints` take precedence over the ones the page sends; Google's
[`lockAdditionalFields`](https://googleapis.github.io/python-genai/genai.html#genai.types.CreateAuthTokenConfig.lock_additional_fields)
controls which. Lock at least the model, so a leaked token can't be used for anything else.

The conversation connects to Gemini's `BidiGenerateContentConstrained` WebSocket with the token. It converts the
microphone's 24 kHz audio to the 16 kHz Gemini expects, and plays Gemini's 24 kHz replies through the avatar.

| Option | Default | Why |
|---|---|---|
| `model` | `gemini-3.8-live` | Google's recommended low-latency native-audio Live model |
| `voice` | Gemini's choice | Any prebuilt voice name, for example `Kore` or `Puck` |
| `activityDetection.startSensitivity` | `"high"` | Quick barge-in. Use `"low"` in noisy rooms. |
| `activityDetection.endSensitivity` | `"high"` | Ends the user's turn sooner |
| `activityDetection.silenceDurationMs` | `450` | The silence window Yoob measured as fastest with OpenAI |
| `activityDetection.prefixPaddingMs` | `100` | Short enough for one-word answers |
| `inputTranscription` / `outputTranscription` | `true` | Captions for both sides |

`sendText(text)` sends a typed turn. `onGoAway(timeLeft)` tells you when Gemini is about to close the connection:
audio-only sessions last up to 15 minutes. Gemini doesn't report when a user turn ends, so a spoken turn goes from
`listening` straight to `speaking`. `thinking` appears after `greet` and `sendText`.

## Talk with it: hosted live voice, with no key of your own

Open the session with `mode: "full"` and Yoob opens the conversation too: Duotone, Yoob's own voice (Undertone
listens, a language model answers, Overtone speaks). Pass the session response through unchanged and there is nothing
else to build — no route of your own, no provider key:

```ts
const conversation = new YoobWebRTCConversation(avatar, {
  onUserTranscript: (text) => (userCaption.textContent = text),
  onAssistantTranscript: (text) => (lunaCaption.textContent = text),
});
```

The session carries a credential for **one** conversation, good for about five minutes, and the minutes are billed to
your Yoob workspace at the `full` rate. The credit is reserved when the session opens rather than when someone speaks,
shrinks as real minutes are billed, and is released when the session ends.

`YoobWebRTCConversation` runs the call through `YoobDuotoneConversation` (since 0.19.0; full mode was GPT-Live before,
and the console no longer opens it, so update from 0.18.x). Use `YoobDuotoneConversation` directly for `sendText()`, a
typed turn. `voice` is a Yoob voice id such as `"w1371"`; without one, each character speaks in its own voice.

Pin the character's prompt on your backend, in the same request that opens the session. The page can pass
`instructions` and `voice`, but a pinned one wins and the page's is ignored — and the model runs on Yoob's side, so
what an end user can make a character say is worth deciding on your server.

A full-mode conversation is only ever opened against `*.yoob.com`; override `liveHosts` only to reach a console you
run yourself.

## Talk with it: GPT-Live, with your own key

GPT-Live cannot be reached from a page on its own: it authenticates with an `Authorization` header, and a browser's
WebSocket cannot set one. So the model takes an SDP offer instead. Your backend does the handshake with your OpenAI
key and hands back only the answer, and the audio then travels between the browser and OpenAI directly — your server
is not in the media path and neither is ours.

```ts
import { YoobWebRTCConversation } from "@yoob/avatar";

const conversation = new YoobWebRTCConversation(avatar, {
  getAnswer: (offer) =>
    fetch("/gpt-live-answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sdp: offer }),
    }).then((r) => r.json()),            // → { sdp }
  onUserTranscript: (text) => (userCaption.textContent = text),
  onAssistantTranscript: (text) => (lunaCaption.textContent = text),
  onState: (state) => console.log(state), // connecting → listening → ended
});

talkButton.onclick = () => conversation.start();   // asks for the microphone, unlocks sound
endButton.onclick = () => conversation.stop();
```

Your backend creates the session. The offer is the only thing the page sends, and the answer is the only thing it
receives — per-session ICE and DTLS parameters, useless outside that one peer connection:

```js
// POST /gpt-live-answer  { sdp }  →  { sdp }
const upstream = await fetch("https://api.openai.com/v1/live/sessions", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({
    session: {
      model: "gpt-live-1",
      instructions: "You are Luna, a warm, curious companion.",
      audio: { output: { voice: "marin" } },
      // No audio.format: with WebRTC the codec is negotiated in SDP, and sending one is refused.
    },
    transport: { type: "webrtc", sdp },
  }),
});
const { transport } = await upstream.json();       // 201
res.json({ sdp: transport.sdp });                  // the session id stays on your server
```

Check the offer before forwarding it: cap it (40 kB is plenty) and refuse anything with a video section. The model is
full-duplex and runs its own turn-taking — it listens while it speaks and yields on its own — so there is no barge-in
to perform and no `greet` to send. The HTTP request itself starts the session; `session.start` is refused.

`model`, `instructions` and `audio.output.voice` are fixed for the life of a session.

The microphone is published with echo cancellation, which matters more here than anywhere else: the model hears
itself through the speakers otherwise. Pass `microphone: false` to publish it yourself.

**Billing.** Creating a session bills 15 seconds of voice up front, credited back once the session starts. A session
that never connects still costs those 15 seconds, so open one when the user asks to talk, not on page load. Avatar
minutes are metered by Yoob as usual from the moment the connection is live. `meter: false` hands the meter to you:
see [`meter: false`](#meter-false).

## LiveKit agents

`@yoob/avatar/livekit` shows a [LiveKit](https://docs.livekit.io/agents/) voice agent as a Yoob character. The agent's
audio track is decoded in the browser and drives the face on the visitor's GPU: there is no avatar worker in the room
and no video track, so nothing extra runs on your servers and the call uses only audio bandwidth. The agent needs
nothing special; any normal voice agent works.

```sh
npm install @yoob/avatar livekit-client
```

```ts
import { Room } from "livekit-client";
import { YoobLiveKitSession } from "@yoob/avatar/livekit";

const room = new Room();
const session = new YoobLiveKitSession(avatar, {
  room,
  onUserTranscript: (text) => (userCaption.textContent = text),
  onAssistantTranscript: (text) => (lunaCaption.textContent = text),
  onState: (state) => console.log(state), // connecting → listening → thinking → speaking
});

talkButton.onclick = async () => {
  const sound = avatar.unlockAudio();     // while the click still allows sound
  const { url, token } = await fetch("/livekit-token", { method: "POST" }).then((r) => r.json());
  await room.connect(url, token);
  await sound;
  await session.start();                  // publishes the microphone
};
endButton.onclick = async () => {
  await session.stop();
  await room.disconnect();
};
```

`session.stop()` ends the metered session it started (and so does the room disconnecting), but leaves the room
connected: it is yours. The session follows the first agent in the room (or `agentIdentity`). It splits the agent's speech into replies with
the agent's `lk.agent.state` attribute, or with 600 ms of silence (`silenceMs`) when the agent does not publish one. If
the agent stops speaking while the user is talking, the character stops at once. The microphone is published through
LiveKit with echo cancellation; pass `microphone: { deviceId }` to pick an input, or `microphone: false` to publish it
yourself. Captions come from the agent's `lk.transcription` text streams.

The avatar plays the agent's voice, so don't also attach that track yourself (for example with `RoomAudioRenderer`),
or it will be heard twice. `livekit-client` 2.9 or newer is required only for this entry point; the main package does
not include it.

### With `livekit-plugins-yoob` on the agent

An agent that runs `yoob.AvatarSession` from the Python package `livekit-plugins-yoob` announces its character in its
attributes and opens Yoob sessions for the people in the call over an RPC, with the agent's own Yoob key. The app then
needs no `/yoob-session` route: `agentAvatar(room)` waits for the agent's announcement and returns the character and a
`getCredentials` that goes through the agent.

```ts
import { YoobAvatar } from "@yoob/avatar";
import { YoobLiveKitSession, agentAvatar } from "@yoob/avatar/livekit";

await room.connect(url, token);
const { character, version, getCredentials } = await agentAvatar(room);
const avatar = new YoobAvatar({ container, character, version, getCredentials });
const session = new YoobLiveKitSession(avatar, { room });
talkButton.onclick = () => session.start();
```

```python
# the agent
await ctx.connect()
avatar = yoob.AvatarSession(character="astrid")
await avatar.start(session, room=ctx.room)
```

Only participants that are not agents get sessions, a few per minute each. Your LiveKit token server still decides who
joins the room, so it is the check on who is billed. `agentAvatar` rejects with a `YoobError` (`network`) when no agent
announces a character within `timeoutMs` (default 30 s), and `getCredentials` with Yoob's reason (`unauthorized`,
`out-of-credit`) when the agent's key is refused.

To handle a track yourself, `avatar.attachAudioTrack(track, (pcm) => avatar.speak(pcm))` mutes a LiveKit
`RemoteAudioTrack` and hands you its sound as 24 kHz PCM. Call `endSpeech()` when a reply ends.

## Microphone controls

`avatar.microphone` handles input selection, mute and level:

```ts
const mic = avatar.microphone;
select.replaceChildren(...(await mic.devices()).map((d) => new Option(d.label, d.deviceId)));
select.onchange = () => mic.select(select.value || null);     // switches mid-conversation
muteButton.onclick = () => mic.setMuted(!mic.muted);
mic.on("level", (level) => (meter.style.width = `${level * 100}%`));
mic.on("devices", refreshList);                                // plugged in or removed
mic.on("error", (error) => (status.textContent = error.message));
```

A stalled input is detected within about 1.6 s and reopened automatically. An unplugged device falls back to the
system default. Errors explain what to do next, for example "Microphone access is blocked. Allow the microphone for
this site and try again."

Using your own voice stack? Call `mic.start()` and read `mic.on("audio", pcm => …)` (24 kHz PCM16, 20 ms packets).

## Characters

SDK 0.3.0 also supports lip-sync packs:
`valentina`, `leonie`, `astrid`, `linda`, `lina`, `zoe`, `maya`,
`santiago`, `julien`, `lars`, `ren`, `kofi`, and `bruno`.
Pass the same ID in `YoobAvatar({ character })` and your backend session's `characters` list.

**These ids changed on 2026-10-12.** They were `r2-f01-valentina`, `r2-m16-kofi` and so on; the old ids now carry
different packs and are not served to SDK keys, so a session naming one is refused at download. Update the ids in your
backend's `characters` list. The faces are the same, at twice the resolution.
The signed manifest chooses the engine automatically; conversation and metering APIs are unchanged.
These packs use their own shared encoder and cannot use Luna's distilled encoder.
A forward/backward host sequence runs during speech, against the pack's neutral host as the reference.

There are two pack layouts and SDK 0.5.0 reads both, choosing by whether the signed manifest names an index file
(`runtime.pack`). The original ships one JPEG per host frame — loaded as speech advances, up to eight at a time — with
a prebuilt bank of mouth crops and a looping idle video. The second ships the host frames as video and no bank: the
frames are decoded with WebCodecs from the byte ranges the pack lists, and each mouth crop is cut from its frame, so
there is nothing to keep in step between the two. **A browser without WebCodecs cannot play a second-layout
character**; every current browser has it, and the SDK says so plainly rather than failing later.

A second-layout pack also states its own lip timing (`instantLips`), which governs when the voice starts, and the
voice the face is meant to speak in (`face.voice`). It rests on its own still, blinking, and ignores `idleVideoUrl`:
an idle loop is footage of the character talking, so showing one while nobody is speaking moves the head and mouth
for no reason. Neither layout reproduces the iOS pose-selection controller yet.
Per-frame inference and download speed determine whether playback can sustain real time on a given device.

| Id | Style | Engine | Download |
|---|---|---|---|
| `luna-anime` | Anime | `anime-web` | 37 MB |
| `astrid`, `valentina`, `leonie`, `linda`, `santiago`, `julien`, `lars` | Realistic | `realistic-web` | 30-35 MB |
| `lina`, `zoe`, `maya`, `ren`, `kofi`, `bruno` | Realistic | `realistic-web` | 30-31 MB |

In the realistic characters, the character's own footage plays under the face along a head path that
moves as she does when she listens or speaks, and only the lips are drawn, from the voice, 25 times a second, with the
app's blinks, silence seal and lip finish. They render in a worker on WebGPU; the footage is HEVC where the browser
decodes it (Chrome and Edge on Macs and most Windows PCs) and H.264 elsewhere (a larger download). `character: "<id>"`
works as for `luna-anime`.

## Measuring performance

Pass `stats: true`, or add `?yoobstats=1` to the page, and the SDK draws what the renderer is actually doing:

```
draw 60fps   frames 27/s   lips 13fps   queue 8
enc 27.4ms   rend 41.0ms   host 1.3ms
audio 431ms   lead +7f
lip 440ms   reply 433ms   waited on frames
webgpu · kofi · 2026.10.12.2 · 1080x1920
```

The same snapshot goes to `onStats` once a second, so an app can log or graph it.

| | |
|---|---|
| `draw` | canvas draws per second — the animation frame loop |
| `frames` | frames the renderer produced per second; 25 is real time |
| `lips` | how often the mouth is redrawn. A 576px pack runs the renderer every other frame by design, so the head moves at 25 and the lips at 12.5 |
| `queue` | frames rendered and waiting to be drawn, of 20 |
| `enc` / `rend` / `host` | time in the encoder, in the renderer per mouth frame, and getting one host picture |
| `audio` | milliseconds of voice buffered ahead of the playhead |
| `lead` | how far ahead of the voice the frames run. Two frames is 80 ms, the edge of noticeable offset |
| `lip` / `reply` | audio arriving to its mouth frame drawn, and a reply's first audio to its first sound |
| `waited on` | which start gate was last to clear: `audio` means the network was slow, `frames` means the renderer was |

A second line appears only when something is wrong — `held` (a draw with no frame ready, which is the freeze a
viewer sees), `dropped`, `starved` (the renderer ran out of audio) and `underrun` (playback ran dry, which is
audible). A quiet HUD is a healthy one.

The overlay is a `div.yoob-avatar-stats` inside the avatar's root, so a page can restyle or hide it.

## What is billed

A session is billed for the time the user spends talking to the character, and for nothing else.

Opening a session and calling `prepare()` costs nothing, however long they take: a session exists so the character can
be downloaded, and on a cold cache that download is tens of seconds that nobody asked to pay for. The meter starts when
a conversation's `start()` brings the microphone up, and stops when that conversation's `stop()`, `avatar.destroy()`
or closing the page ends the session. That holds for every conversation class — `YoobConversation`,
`YoobGeminiConversation`, `YoobWebRTCConversation`, `YoobLiveConversation` and `YoobLiveKitSession` — and a `stop()`
that lands while `start()` is still connecting leaves nothing running and nothing metered. Heartbeats run the whole time, but the ones before the meter starts only keep the session alive and renew its
download grant.

```js
avatar.prepare();            // downloads and warms the character — free, and as early as you like
await conversation.start();  // microphone live: the meter starts here
conversation.stop();         // the meter stops and the session ends
```

That means `prepare()` can run as soon as the page loads, so the character is ready the moment someone presses Talk,
without buying the wait.

A session that has not started metering within **two minutes** of opening is closed by Yoob. On a page that prepared
early and is waiting for someone to press Talk, that is expected and costs you nothing: the character stays on
screen with everything it downloaded, heartbeats stop, no error is reported and the phase does not change. When the
user starts talking — `startMetering()`, which every conversation's `start()` calls, `prepare()`, or the first word of
`speak()` — the SDK opens a new session through `getCredentials()` and meters that one. If the new session can't be
opened, the avatar stops exactly as it does when a renewal fails: phase `stopped`, `onSessionEnded` and `onError`.
(SDKs before this release open a replacement session the moment Yoob closes an unmetered one, so an idle page asks
`getCredentials()` for a new session every two minutes. Upgrade if your token server rate-limits session opens.)

Once a session has ended — `stop()`, or `avatar.endSession()` if you drive the avatar yourself — the character stays
on screen, but `speak()` throws a `session-ended` `YoobError` instead of rendering with nothing to bill it to.
`prepare()`, or the next conversation's `start()`, opens a new session without downloading the character again.

`onSessionStarted` is the moment billing begins — the place to start a usage clock. It reports `maxSeconds` when the
API caps the session, as it does for free ones.

```js
const avatar = new YoobAvatar({
  // …
  onSessionStarted: ({ maxSeconds }) => startClock(maxSeconds),
  onSessionEnded: (error) => stopClock(error.message),
});
```

### Voice is billed by the session, not by the voice provider

What a minute costs is fixed when your backend opens the session, by its `mode`:

| `mode` | what it covers |
|---|---|
| `full` | the character and the conversation |
| `avatar` | the character alone |

The SDK's heartbeat is what bills it. **Yoob never reads your LiveKit, your agent, your OpenAI account or any other
voice provider** — so bring your own and nothing about billing changes, and there is no usage to export, reconcile or
grant us access to.

That holds for every path here. A `YoobLiveKitSession` pointed at a room you run on your own LiveKit meters the same
way as one pointed at ours, because the meter was never in the room.

Driving the avatar yourself, without a conversation class? The first `speak()` starts the meter, or call
`avatar.startMetering()` at whatever moment counts as the start in your app. It is idempotent, and it rejects — before
the conversation goes ahead — if the workspace has no credit, the key was revoked, or a free allowance is used up.

### `meter: false`

`YoobWebRTCConversation`, `YoobLiveConversation` and `YoobLiveKitSession` take `meter: false`. It means **your app
starts the meter**, by calling `avatar.startMetering()` when it decides the conversation has begun. Nothing in the SDK
starts it for you then: not the microphone going live, and not the character's first word. `speak()` takes the same
choice per call, as `avatar.speak(pcm, { meter: false })`.

It is not a way to render unmetered. Yoob closes a session that has not started metering within **two minutes** of
opening, so call `startMetering()` when the user starts talking, as the conversation classes do.

## Network

| Request | When | Contents |
|---|---|---|
| `cdn.yoob.com` character files | First visit and version updates | Download grant |
| `cdn.yoob.com` ONNX Runtime WebAssembly | First visit | Nothing |
| `app.yoob.com/api/v1/sessions/heartbeat` | Every 15 s from the start of `prepare()`, until the session ends | Session token |
| `app.yoob.com/api/v1/sessions/start` | The user starts talking | Session token |
| `app.yoob.com/api/v1/sessions/end` | `conversation.stop()`, `destroy()` or page close | Session token |
| `wss://voice.yoob.com/v1/realtime` | Yoob voice conversations | Voice token, microphone audio, typed text |
| `app.yoob.com/api/v1/live/duotone` | Full-mode conversations | Microphone audio (16 kHz), typed text; her voice back |
| A peer connection to OpenAI | GPT-Live on your own key (`getAnswer`) | Microphone audio, the character's voice |

With Yoob voice, microphone audio goes from the browser to `voice.yoob.com`, which meters the
minutes. With your own OpenAI account, it goes directly from the browser to OpenAI, and with
`YoobGeminiConversation` directly to Google. With `YoobLiveKitSession`, it goes to your LiveKit server, and the agent's audio comes back from it.

`YoobWebRTCConversation` is the odd one: audio goes straight between the browser and OpenAI over WebRTC, so it
reaches OpenAI's media addresses rather than any host of ours or yours. Only the SDP offer and answer pass through
your backend. A network that blocks UDP will fall back to TCP on 443, and one that blocks both cannot use this
transport.

## Security

- **Keys stay on your server.** A Yoob API key never belongs in a page, an app bundle or a repository. The API
  rejects key calls that come from a browser (any request with an `Origin`), so a key pasted into a page doesn't work.
  The page only ever holds a session token, a download grant and a voice token, or a
  [temporary key](#or-a-temporary-key-and-the-page-opens-its-own-sessions) if you let it open sessions itself.
- **Every session is billed.** Each session a key opens is billed to the key's workspace.
- **Grants are short-lived and per character.** A download grant covers the characters its session was opened for and
  expires soon. Heartbeats may hand the SDK a renewed grant, which it uses from the next download on. A voice token
  opens one conversation and must be used within 5 minutes.
- **Heartbeats are enforced.** Heartbeats start with the session. Explicit denials stop the character at once: a
  refused session (401 or 403), an exhausted workspace (402), or a `stop` reply for out of credit, a time limit, a
  suspended workspace or a revoked key. The character stops rendering and `onSessionEnded` fires.
- **An outage doesn't stop characters.** If Yoob can't be reached (network errors, timeouts, 408, 429, 5xx), the
  character keeps rendering for up to 10 minutes after the last successful heartbeat while the SDK retries, then
  stops as `session-ended` with reason `unreachable`. `heartbeatOutageGraceSeconds` changes the window (0 to 1800).
  The current download grant keeps being used meanwhile; if it expires during the outage, new downloads fail, but a
  character that already loaded keeps rendering. When Yoob ends an idle session (a laptop that slept), the SDK asks
  `getCredentials()` for a new one. When Yoob closes a session that never started metering, the SDK waits until the
  user starts talking before asking for a new one.
- **Voice only goes to Yoob.** Yoob voice sessions connect only to `wss://*.yoob.com` unless you set `voiceHosts`.
- **What your token server must do.** The example server does each of these; keep them when you write your own:
  1. Authenticate the user before minting anything, and fail closed.
  2. Rate-limit sessions per user.
  3. Accept only the character ids you offer, and send exactly that one character. Never `"*"`.
  4. Always set the voice and instructions for voice sessions on the server.
  5. Build the request body yourself. Don't pass fields from the page through to Yoob.
  6. Keep the key in the server's environment, and return Yoob's response without logging tokens.

## Content Security Policy

Allow `connect-src https://cdn.yoob.com https://app.yoob.com` (plus `wss://voice.yoob.com` for Yoob voice,
`wss://api.openai.com` or `wss://generativelanguage.googleapis.com` for your own provider, or your LiveKit server for
LiveKit agents),
`script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`, and `img-src blob:` plus `media-src blob:` (the poster
and idle video are shown from verified in-memory copies). Workers and audio worklets ship as files, so scripts need no
`data:` or `blob:` source.

## License

Apache-2.0. Includes ONNX Runtime Web (MIT); see NOTICE. Character model files are licensed separately under the
[Yoob Model License](https://github.com/Yoob-com/yoob-web-sdk/blob/main/LICENSE-MODELS.md): use them only through the
SDK in metered Yoob sessions; no extraction, redistribution or reverse engineering. Packs are marked per workspace, and
every manifest names the license in its `license` field.
