# Changelog

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
