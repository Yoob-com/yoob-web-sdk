# Yoob web demo

Talk to Luna in the browser: microphone choice, mute, level meter, captions, and a sample line.

```sh
npm install && npm run build   # at the repository root
YOOB_API_KEY=yoob_test_… npm run token-server   # at the root: /yoob-session and /yoob-voice on 127.0.0.1:3100
npm run demo
```

`npm run token-server` sets `YOOB_EXAMPLE_ALLOW_ANONYMOUS=1`, which lets anyone who can reach the server mint
sessions. That is fine on your machine only; before you deploy a token server, replace `requireUser()` with your own
sign-in check. A `yoob_test_` key opens sandbox sessions that don't use credits.

Talk uses Yoob voice, so no provider key is needed; minutes are billed to your Yoob workspace. To use your own OpenAI
account instead, start the token server with `OPENAI_API_KEY` and switch `getVoiceSession` in `src/main.ts` to the
`getClientSecret` line next to it.

`?character=<id>` shows another character (for example `?character=astrid`; see the SDK README's character list), and
the Character menu switches between them.

### FeatherTalk packs without the CDN (development)

Build a pack with `scripts/feathertalk-pack.mjs` (see `packages/avatar/FORMAT.md`), then run the demo on the SDK's
sources with the packs directory:

```sh
YOOB_SDK_SOURCE=1 YOOB_PACKS_DIR=/path/to/packs npm run demo
```

`?pack=/packs/<id>/` loads `<packs>/<id>` with no session. `parity.html` measures a pack: `mode=offline` composes every
frame of a WAV (`YOOB_REF_DIR`, `?wav=/ref/<file>`) as the Luna app's `AvatarModelProbe --stream` does and saves each
frame's 448 px face window to `YOOB_PARITY_OUT` (compare with `scripts/feathertalk-parity/`); `mode=live` speaks it at
1x through `YoobAvatar` (muted) and reports rendered, shown, skipped and late frames and when each frame was shown.
