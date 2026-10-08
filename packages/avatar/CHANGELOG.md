# Changelog

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
