# @yoob/avatar

Talking characters rendered in the browser with WebGPU. You give Yoob speech; it plays the audio and moves the face in
sync, on the visitor's own GPU. Add a microphone and Yoob voice, and you have a live spoken conversation with barge-in,
with no provider key. You can also bring your own OpenAI Realtime, Gemini Live or LiveKit agent.

- **Light.** About 20 KB gzipped to start. Rendering workers load when a character is created, and character files
  (37 MB) stream from `cdn.yoob.com` in verified chunks cached in the browser. On a good connection the character
  appears in about half a second, and a returning visitor is ready in about one.
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

```js
// POST /yoob-session on your server
const user = await requireSignedInUser(req);            // your auth
await rateLimit(user.id);                               // your limits
const character = ALLOWED.has(req.body.character) ? req.body.character : reject(400);
const response = await fetch("https://api2.yoob.com/api/v1/avatar/sessions", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.YOOB_API_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ characters: [character] }), // one character, never "*"
});
return response.json(); // { session_token, download_token, heartbeat_seconds, ... }
```

[`examples/token-server`](../../examples/token-server/server.mjs) is a runnable version. It refuses every request
until you replace its `requireUser()` with your own sign-in check; `YOOB_EXAMPLE_ALLOW_ANONYMOUS=1` (which
`npm run token-server` sets) turns that off for local development only. See [Security](#security).

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

If the session can't continue, the character stops rendering, the phase becomes `stopped`, and `onSessionEnded` and
`onError` receive a `YoobError`: `out-of-credit` when the workspace has no credit left, `unauthorized` when Yoob
refuses the session or its API key was revoked, or `session-ended` when a sandbox session reaches its time limit, when
the workspace is suspended, or when Yoob can't be reached for the whole outage grace window (`error.details.reason` is
`unreachable`). `speak()` then throws the same error. Call `prepare()` to open a new session.

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

## Talk with it: Yoob voice

No provider key needed; minutes are billed through your Yoob workspace. Yoob hosts the voice (OpenAI Realtime) and
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

The session follows the first agent in the room (or `agentIdentity`). It splits the agent's speech into replies with
the agent's `lk.agent.state` attribute, or with 600 ms of silence (`silenceMs`) when the agent does not publish one. If
the agent stops speaking while the user is talking, the character stops at once. The microphone is published through
LiveKit with echo cancellation; pass `microphone: { deviceId }` to pick an input, or `microphone: false` to publish it
yourself. Captions come from the agent's `lk.transcription` text streams.

The avatar plays the agent's voice, so don't also attach that track yourself (for example with `RoomAudioRenderer`),
or it will be heard twice. `livekit-client` 2.9 or newer is required only for this entry point; the main package does
not include it.

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

| Id | Style | Download |
|---|---|---|
| `luna-anime` | Anime | 37 MB |

`luna-realistic` is available in the [iOS SDK](https://github.com/Yoob-com/yoob-ios-sdk). Its web renderer is on the way.

## Network

| Request | When | Contents |
|---|---|---|
| `cdn.yoob.com` character files | First visit and version updates | Download grant |
| `cdn.yoob.com` ONNX Runtime WebAssembly | First visit | Nothing |
| `api2.yoob.com/api/v1/sessions/heartbeat` | Every 15 s from the start of `prepare()` | Session token |
| `api2.yoob.com/api/v1/sessions/end` | `destroy()` or page close | Session token |
| `wss://voice.yoob.com/v1/realtime` | Yoob voice conversations | Voice token, microphone audio, typed text |

With Yoob voice, microphone audio goes from the browser to `voice.yoob.com`, which relays it to OpenAI and meters the
minutes. With your own OpenAI account, it goes directly from the browser to OpenAI, and with
`YoobGeminiConversation` directly to Google. With `YoobLiveKitSession`, it goes to your LiveKit server, and the agent's audio comes back from it.

## Security

- **Keys stay on your server.** A Yoob API key never belongs in a page, an app bundle or a repository. The API
  rejects key calls that come from a browser (any request with an `Origin`), so a key pasted into a page doesn't work.
  The page only ever holds a session token, a download grant and a voice token.
- **Test keys for development.** A `yoob_test_` key opens sandbox sessions that don't use credits and are limited in
  length (a few minutes each, with a daily total). Sandbox mode comes from the key alone; there is no request flag
  to turn it on.
- **Grants are short-lived and per character.** A download grant covers the characters its session was opened for and
  expires soon. Heartbeats may hand the SDK a renewed grant, which it uses from the next download on. A voice token
  opens one conversation and must be used within 5 minutes.
- **Heartbeats are enforced.** Heartbeats start with the session. Explicit denials stop the character at once: a
  refused session (401 or 403), an exhausted workspace (402), or a `stop` reply for out of credit, a sandbox limit, a
  suspended workspace or a revoked key. The character stops rendering and `onSessionEnded` fires.
- **An outage doesn't stop characters.** If Yoob can't be reached (network errors, timeouts, 408, 429, 5xx), the
  character keeps rendering for up to 10 minutes after the last successful heartbeat while the SDK retries, then
  stops as `session-ended` with reason `unreachable`. `heartbeatOutageGraceSeconds` changes the window (0 to 1800).
  The current download grant keeps being used meanwhile; if it expires during the outage, new downloads fail, but a
  character that already loaded keeps rendering. When Yoob ends an idle session (a laptop that slept), the SDK asks
  `getCredentials()` for a new one.
- **Voice only goes to Yoob.** Yoob voice sessions connect only to `wss://*.yoob.com` unless you set `voiceHosts`.
- **What your token server must do.** The example server does each of these; keep them when you write your own:
  1. Authenticate the user before minting anything, and fail closed.
  2. Rate-limit sessions per user.
  3. Accept only the character ids you offer, and send exactly that one character. Never `"*"`.
  4. Always set the voice and instructions for voice sessions on the server.
  5. Build the request body yourself. Don't pass fields from the page through to Yoob.
  6. Keep the key in the server's environment, and return Yoob's response without logging tokens.

## Content Security Policy

Allow `connect-src https://cdn.yoob.com https://api2.yoob.com` (plus `wss://voice.yoob.com` for Yoob voice,
`wss://api.openai.com` or `wss://generativelanguage.googleapis.com` for your own provider, or your LiveKit server for
LiveKit agents),
`script-src 'self' 'wasm-unsafe-eval'`, `worker-src 'self'`, and `img-src blob:` plus `media-src blob:` (the poster
and idle video are shown from verified in-memory copies). Workers and audio worklets ship as files, so scripts need no
`data:` or `blob:` source.

## License

Apache-2.0. Character model files are licensed separately. Includes ONNX Runtime Web (MIT); see NOTICE.
