# Yoob Web SDK

Talking characters rendered in the browser. This repository holds:

| Path | What |
|---|---|
| [`packages/avatar`](packages/avatar) | `@yoob/avatar`: the SDK, with rendering, microphone, and conversations with Yoob voice, OpenAI Realtime, Gemini Live or LiveKit |
| [`apps/demo`](apps/demo) | A one-page demo: talk to Luna, pick a microphone, mute, see captions |
| [`examples/token-server`](examples/token-server) | The backend calls that turn your Yoob API key into a browser session and a voice session. It refuses requests until you add your own auth |

Start with the [package README](packages/avatar/README.md). For iOS, see
[Yoob-com/yoob-ios-sdk](https://github.com/Yoob-com/yoob-ios-sdk).

## Develop

```sh
npm install
npm run build
npm test
YOOB_API_KEY=yoob_test_… npm run token-server   # 127.0.0.1:3100, anonymous access for local development only
npm run demo        # http://localhost:5173
```

Security: see the [package README](packages/avatar/README.md#security).

## Contributing

Members of the [Yoob-com](https://github.com/Yoob-com) GitHub organization get their own sandbox key, so a fresh
clone shows the characters without anyone sharing a secret:

```sh
gh auth login          # once, with your GitHub account
npm install
npm run dev-key        # saves a sandbox key to ~/.config/yoob/contributor.key
npm run token-server   # uses that key when YOOB_API_KEY is not set
npm run demo           # http://localhost:5173 (WebGPU: desktop Chrome, Edge or Safari 26)
```

The key is a sandbox key: free 5-minute sessions, an hour a day, never billed. Running `npm run dev-key` again
replaces it. If it says you are not a member, make your organization membership public or ask an owner to add you.

## License

Apache-2.0. Character model files are licensed separately and are not in this repository.
