# Yoob Model License 1.0

Effective 2026-10-12. Copyright 2026 Tap Mobile. All rights reserved.

This license covers Yoob character model files: every file of a Yoob character pack served from `cdn.yoob.com` or
bundled in a Yoob app. That includes renderer and audio encoder weights (ONNX, Core ML or any other format), host
footage, stills, audio windows, manifests, and anything derived from them. We call these the "Model Files". The SDK
source code in this repository is a separate matter and stays under Apache-2.0 (`LICENSE`).

## 1. They are ours

The Model Files are proprietary to Tap Mobile ("Yoob", "we"). They are licensed, not sold. Each character portrays a
real performer whose likeness we license; you get no right to that likeness apart from the rendering described here.

## 2. What you may do

You may let the Yoob SDK download the Model Files and run them on your end users' devices, but only:

- inside a session opened through the Yoob API with your own API key, while that session is live and metered; and
- for the characters that session names.

The SDK may cache the files on the device to make later sessions faster. That cache is part of the SDK, not a copy you
may use.

## 3. What you may not do

- Extract, export or save the Model Files outside the SDK, or keep using them after the session ends.
- Run them, or anything derived from them, without a metered Yoob session: for example in a forked SDK with
  heartbeats removed, on your own server, or in another engine.
- Copy, host, share, sell, sublicense or redistribute them.
- Reverse engineer, decompile, convert, quantize, fine-tune, distill or modify them, or use them, their outputs or
  their footage to train or evaluate other models.
- Remove, alter or hide the marks described below.
- Use a character's face, voice or likeness outside the SDK's rendering.

## 4. Marked copies

Packs are marked for the workspace they are served to, inside the model weights, in a way that survives copying,
format conversion and quantization. We can tell which workspace a copy came from, and we log every download.

## 5. Ending and enforcement

If you break these terms, your rights under this license end at once and we may revoke your keys and suspend your
workspace. You are responsible for use made under your API keys. We may enforce these terms, and our copyright and
other rights in the Model Files, in any court with jurisdiction.

## 6. No warranty

The Model Files are provided "as is", without warranty of any kind. To the extent the law allows, we are not liable for
any damages arising from their use.

Your agreement with Yoob (the console terms) also applies. Where it conflicts with this license on the Model Files, this
license wins unless that agreement says otherwise in writing.
