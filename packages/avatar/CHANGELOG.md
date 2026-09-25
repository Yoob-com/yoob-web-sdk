# Changelog

## 0.3.0

Smoother lips, from the Luna app's avatar work of 2026-09-24/25. No API break; the new option defaults to the app's
behaviour.

- **Lip frames cross-fade at the display's rate.** The character draws 25 lip frames a second. They used to be shown
  whole, so on a 60 or 120 Hz screen the mouth moved in 40 ms steps. Each new lip frame now fades in over the one
  before across 40 ms, redrawn at every display refresh. The fade reaches half weight when the frame's audio is due,
  so lip-sync is unchanged. More than one skipped lip frame, or a jump in the idle footage, still steps.
- **No jump at the end of a reply.** When a reply ends or is interrupted, the mouth now fades back to the idle face
  over 160 ms instead of vanishing in one picture, and the first mouth of a reply fades in over 120 ms centred on its
  audio.
- **New option `lipCadence`**: `"blend"` (default) as above, or `"step"` for the 0.2 drawing, pixel for pixel.
- Cost: only the mouth region is redrawn between lip frames (two region-sized canvas copies per refresh), about
  0.05 ms of main-thread time per display refresh (headless Chrome on a Mac).

## 0.2.1

- The voice resumes after an underrun only once 160 ms of audio is queued (120 ms for a reply's last syllables),
  instead of on each packet, so a jittery connection no longer plays as a string of short bursts.

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
