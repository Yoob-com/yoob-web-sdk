# Changelog

## Unreleased

- `YoobLiveConversation.stop()` ends the metered session. It left the room and stopped there, so heartbeats kept
  billing until the page closed, and the next `start()` carried on in the same metered session — the time between two
  conversations was billed as talk. `YoobLiveKitSession.stop()` now ends the meter it started too (unless it was made
  with `meter: false`), and so does its room disconnecting; it still never disconnects a room it was handed.

- `YoobLiveConversation.stop()` during `start()` leaves nothing behind. A stop while the backend, the room connection
  or the meter request was still answering used to be ignored by the `start()` in progress, which went on to connect
  the room, publish the microphone and start the meter with nothing left to stop them. `start()` now resolves without
  connecting anything, and `stop()` resolves once the meter request in flight has answered and been ended.
  `avatar.endSession()` likewise waits for a meter request in flight before ending the session, so the end can never
  reach the server ahead of the start.

- `YoobGeminiConversation` meters like `YoobConversation`. It never started the meter itself — only `speak()`'s
  fallback did, at the character's first word, so everything the user said before the first reply went unbilled — and
  `stop()` never ended the session, so heartbeats billed until the page closed. `start()` now starts the meter once the
  microphone is live (and rejects, with the microphone given back, if Yoob refuses it), `stop()` ends the session, and
  a `stop()` during `start()` keeps the socket, microphone and meter from being opened behind it.

- `meter: false` now does what it says. It is meant to hand the meter to the app — the app calls
  `avatar.startMetering()` itself — but `speak()` started the meter on the character's first word regardless, so the
  option was a no-op on every conversation class that takes it (`YoobWebRTCConversation`, `YoobLiveConversation`,
  `YoobLiveKitSession`). `speak()` takes `{ meter: false }` as its second argument (a number is still read as the
  sample rate), and those classes pass it. The test that claimed this worked used a stand-in avatar whose `speak()`
  never metered; it now runs the real one.

  Behaviour change: with `meter: false`, a conversation is not billed until your app calls `startMetering()`. Yoob
  ends sessions that have not started metering within two minutes of opening.

- `speak()` after `endSession()` throws a `session-ended` `YoobError` until a new session opens. The phase stayed
  `ready` and `speak()` went on rendering with no session and no heartbeat — a character speaking unmetered.
  `prepare()`, or a conversation's `start()`, opens a new session and `speak()` works again.

  Behaviour change: code that kept calling `speak()` after a conversation's `stop()` (or after `endSession()`) now
  gets an exception; `YoobLiveKitSession` reports it through `onError`.

- Every conversation class hangs up when its avatar's session ends — Yoob stopping it (no credit, refused,
  unreachable), `avatar.endSession()`, or `avatar.destroy()`. The avatar stopped rendering, but the conversation's own
  connection lived on: `YoobWebRTCConversation` kept its microphone and peer connection open, so in full mode GPT-Live
  went on running on Yoob's OpenAI account; `YoobLiveConversation` stayed in the room, keeping its agent and model
  running; `YoobConversation` and `YoobGeminiConversation` kept their sockets open. Each now goes to `ended`, releases
  everything, and passes Yoob's reason to its `onError`. New: `avatar.onSessionEnd(listener)`, which they use.

- `avatar.destroy()` no longer throws when the microphone is live. It marked the avatar destroyed before stopping the
  microphone, whose audio graph then refused it, so `destroy()` rejected before it had ended the session or released
  the renderer.

- A `YoobWebRTCConversation` stopped while `start()` was waiting on the backend can be started again. The cancelled
  start left an internal flag set, and every later `start()` returned without doing anything.

- A session Yoob closes for never metering goes dormant instead of being replaced at once. The console now ends a
  session that has not started metering within two minutes of opening, with a heartbeat reply of
  `{ stop: true, reason: "unmetered" }`. The SDK used to treat every non-terminal stop as "open a new session now",
  which would have made every idle page call `getCredentials()` every two minutes — into a token server's per-key
  rate limit. Now the character stays on screen with everything it loaded, heartbeats stop, and nothing is reported;
  the next `startMetering()` (which every conversation's `start()` calls), `prepare()`, or first word of `speak()`
  opens a new session through `getCredentials()`, once however many callers are waiting, and meters it. A reopen that
  fails ends the avatar's session exactly as a failed renewal does. Other stop reasons, `abandoned` included, behave
  as before.

  SDKs older than this release reopen immediately when Yoob closes an unmetered session.

## 0.12.0

- The WebRTC transport ends an utterance when the voice stops. `SpeechGate` opened one and never closed it: the
  LiveKit path has always called `endSpeech()` from `closeUtterance`, and this path called only `speak()`. Nothing
  else finalizes the stream, the playback worklet emits `drained` only for a finalized stream, and without `drained`
  the coordinator never rests -- it held the last speech frame on screen, never returned to the idle still, and
  treated the next reply as a continuation of a stream that had already stopped. The character rendered one sentence
  and froze. New in 0.9.0, which is when the gate first started closing mid-conversation.

- The renderer reports the JavaScript either side of the models: `tensor` (building the two input tensors) and
  `composite` (turning the output back into pixels and drawing them). Neither was inside any existing timer, so a
  frame could look cheap in the HUD while most of its cost sat unattributed between the encoder and the renderer.

- `encoderMs` is now per frame, as `stats.ts` has always documented it and as every other timer already was. It was
  reported per batch, which made it incomparable across lookaheads: a longer lookahead makes each encoder call cover
  a longer window *and* more frames, so the batch time rose while the per-frame cost fell, and the HUD showed the
  first number.

  With all four timers honest, Julien on an M-series Mac costs
  `rend 17.7 + enc 13.7 + host 7.2 + composite 1.0 + tensor 0.2 = 39.8 ms` per frame against a 40 ms budget.

## 0.11.0

- Reverts 0.10.0's start gate. The 400 ms PCM cushion and the eight-frame wait are back, and a pack's
  `instantLips.voiceDelayMilliseconds` goes back to being maxed against them rather than replacing them.

  0.10.0 read those as one number and they are three. The cushion is a jitter buffer: it is what stops network jitter
  emptying the playback worklet, and a thin one breaks the voice up. The frame gate gives the renderer a lead before
  the audio clock starts consuming frames, and without it the renderer falls behind and the picture freezes on
  whatever frame it had. The pack's delay is neither of those — it is lip alignment, how long the voice waits so the
  mouth is ready. iOS can start at once because it keeps its own playback cushion as well, and because a late frame
  there only holds the picture: its voice never waits on the renderer. On this path the frames are driven by the
  audio clock, so starving the renderer costs the sound and the picture together.

  0.10.0's measurement did not catch it because the test fed PCM from a local timer into a warm renderer — perfectly
  paced, no jitter, which is the one condition the cushion exists for.

- The resting face from 0.10.0 is unaffected and stays: a second-layout pack still rests on its own blinking still
  and still ignores `idleVideoUrl`.

## 0.10.0

- A pack that states its own lip timing is now believed about when the voice starts. `instantLips.voiceDelayMilliseconds`
  used to be maxed against a fixed 400 ms cushion, so every pack that stated one silently ran on 400 ms and its own
  figure was never once used; the start also waited for eight rendered frames. A pack that states a delay now gets that
  delay and the first frame, which is what it was built for. Packs that state nothing keep 400 ms and eight frames.
  Measured on Julien, who asks for 110 ms: first sound 413 ms after the first audio, now 136 ms; the drawn frame 500 ms
  behind its packet, now 250 ms; frames running 8-9 ahead of the voice, now 1-2. No frame was held in either case.
- A second-layout pack now rests on its own blinking still and ignores `idleVideoUrl`. An idle loop is footage of the
  character talking, so a page that supplied one showed the character moving its head and mouth while nobody was
  speaking — and the loops we ship are 540x960 against a 1080x1920 canvas, so it was also the only blurry thing on
  screen. The pack's still was downloaded and never drawn. In silence the mouth is now completely still and only the
  eyes blink, as the iOS SDK has always done.

## 0.9.0

- A GPT-Live character rests between replies instead of mouthing the silence. GPT-Live never stops sending: it streams
  continuously and fills the gaps with zeroes, and all of it was reaching the renderer, so the head and lips moved for
  as long as a call lasted and the idle loop never got a turn. Audio now reaches the renderer while the voice is
  audible and for 400 ms after, so the quiet inside a sentence still carries the clock and the quiet between replies
  does not.

## 0.8.0

- A FeatherTalk pack with no idle loop now rests on its own blinking still instead of freezing on the last speech
  frame, and a reply settles onto it over 250 ms. Packs that ship an idle loop, and the Luna renderer, are unchanged.

## 0.7.0

- A performance HUD: `stats: true` or `?yoobstats=1` draws draw/frame/lip rates, the time inside each model, the
  audio cushion and the two latencies that matter, and reports the same snapshot to `onStats` once a second.
- Counts things the FeatherTalk path never reported: a draw with no frame ready (the freeze a viewer sees as a
  stutter), frames rendered and discarded unseen, batches starved of audio, and playback underruns — which the audio
  worklet has always measured and nothing subscribed to.

## 0.6.0

- Full mode: `YoobWebRTCConversation` without `getAnswer`. A session opened with `mode: "full"` carries a credential
  for one conversation and the SDK presents it to Yoob, so an integrator needs no OpenAI key and no handshake route.
  `getAnswer` is unchanged for anyone bringing their own.
- `liveHosts` pins where a full-mode conversation may be opened, defaulting to `*.yoob.com`, so a compromised backend
  cannot negotiate the user's microphone somewhere else.

## 0.5.0

- Accepts `realistic-web` as well as `feathertalk-web`: the same renderer, republished under a name that says what it
  draws rather than how.
- Takes the models' tensor names from the pack instead of assuming them. A re-export renamed the renderer's output
  from `clip_0` to `output`, which nothing in the pack layout showed — the character downloaded perfectly and then
  rendered nothing. A pack that names none keeps the old names.

## 0.4.0

- Reads the second FeatherTalk pack layout alongside the first, chosen by `runtime.pack` on the signed manifest. Host
  frames come from an encoded video decoded with WebCodecs rather than one JPEG per frame, and the mouth crops are cut
  from those frames rather than from a prebuilt bank. The characters republished on 2026-10-12 need this; the packs
  they replaced keep working unchanged.
- Takes a second-layout pack's own lip timing (`instantLips`), including the voice delay that keeps the first word
  behind the first lip frame. `lookaheadFrames` and `mirrorPadding` still override it.
- A character that ships a still instead of an idle loop rests on the still rather than refusing to prepare.
- Fixed: the idle video was matched as the first tier-1 `.mp4`, which a pack carrying `hosts.mp4` could satisfy.

## Unreleased

- Add `YoobWebRTCConversation`: GPT-Live over a direct peer connection. Your backend exchanges the SDP offer for an
  answer with your OpenAI key, and audio then travels between the browser and OpenAI with no server in the middle.
  Exported from the package root, since unlike the LiveKit entry it needs nothing but the browser's own WebRTC.
- Add `avatar.attachMediaStream(stream, onAudio)`, the plain-WebRTC twin of `attachAudioTrack`.
- Add `lookaheadFrames` and `mirrorPadding` to `YoobAvatarOptions`, for measuring a FeatherTalk pack against
  something other than the lookahead it was tuned with. Both default to today's behaviour.

## 0.3.0

- Add the `feathertalk-web` engine for the 13 October 7 avatar exports, including both 144 and 288 pixel inputs.
- Use their stock speech encoder, per-character normalization, host frames and masked BGR renderer inputs.
- Preserve the user-activated audio context when choosing the engine; retain the existing Luna engine and signing key.
- Support streaming speech, interruption, encrypted asset loading and the existing session lifecycle for the new engine.
- Trust the separate `yoob-feathertalk-2026-10` manifest signing key. New packs require SDK 0.3.0.

## 0.2.0

Security hardening. Needs the Yoob API that ships with it (heartbeats with renewed grants).

- **Heartbeats are enforced.** They start when `prepare()` opens the session, not after the download. The character
  stops rendering, the phase becomes `stopped`, and the new `onSessionEnded` option fires when Yoob refuses the session
  (401/403 → `unauthorized`), the workspace is out of credit (402 or `stop` with `out-of-credits` → `out-of-credit`),
  or a sandbox session reaches its limit or the workspace is suspended (new error code `session-ended`). A session
  Yoob no longer knows (404, or `stop` for another reason) is replaced through `getCredentials()`.
- **An outage doesn't stop characters.** Heartbeats that get no answer (network errors, timeouts, 408, 429, 5xx,
  unreadable replies) are retried after 2 s, 6 s, then every 15 s, and the character keeps rendering. It stops as
  `session-ended` with `details.reason` `unreachable` only when the new `heartbeatOutageGraceSeconds` option (default
  600, from 0 to 1800) has passed since the last successful heartbeat. New `onHeartbeatDegraded` and
  `onHeartbeatRecovered` options report the outage and its end; without `onHeartbeatDegraded` the SDK logs a warning.
  Denials (401, 402, 403, terminal `stop` reasons) still stop the character at once, even during an outage.
- **Renewed download grants.** A heartbeat reply may carry `download_token` (with `download_token_expires_at`; the
  names `grant` and `grant_expires_at` are also accepted); the page and the render worker use it for the next
  downloads. Replies without it work as before.
- **Terminal stop reasons.** `stop` with `sandbox-limit` or `suspended` ends the session (`session-ended`), and
  `key-revoked` ends it as `unauthorized`, instead of opening a new session.
- **Voice host pinning.** Yoob voice sessions connect only to `wss://*.yoob.com`. The new `voiceHosts` option allows
  a self-hosted relay.
- **Credentials check.** `getCredentials()` must return a `session_token` and a `download_token`; anything else fails
  with `unauthorized` and a clear message.
- **Example token server.** Fails closed until you add your own auth (`YOOB_EXAMPLE_ALLOW_ANONYMOUS=1` for local
  development, set by `npm run token-server`), accepts only characters in `YOOB_CHARACTERS`
  (default `luna-realistic,luna-anime`) and never asks for `*`, rate-limits each user, always pins the voice prompt,
  and never passes request fields such as `is_sandbox` through. Sandbox sessions come from `yoob_test_` keys.
- README: new Security section.

## 0.1.1

- Install fix: no postinstall step, no runtime dependencies.

## 0.1.0

- First release: WebGPU characters, Yoob voice, your own OpenAI Realtime, Gemini Live and LiveKit agents.
