# FeatherTalk web character pack (`feathertalk-web`, schema 1)

The realistic characters of the Luna app (Astrid, Valentina, Leonie, Linda, Santiago, Julien, Lars, Lina, Zoe, Maya, Ren,
Kofi, Bruno) run in the browser on the `feathertalk-web` engine of `@yoob/avatar`. It is a port of the iOS runtime
(`language-companions/ios/LanguageCompanions/AvatarRuntime`): the character's own footage plays under the face along its
head path, and only the lips are drawn by the character's lip model from the voice, 25 lip frames a second.

A pack is one directory per character. `scripts/feathertalk-pack.mjs` builds it from an iOS face folder plus the
character's ONNX renderer; the Yoob CDN packer (`yoob-cdn/packer/pack.mjs`) then chunks and signs it like any other web
pack. Nothing in a pack is committed to git.

## Files

| Path | What | Tier |
|---|---|---|
| `pack.json` | The descriptor below. Small; read first. | 1 |
| `still/base.jpg` | The still idle face (host `still.host` with its lips closed), 1080 x 1920. Also the poster. | 0/1 |
| `still/blink-<n>.jpg` | The blink pictures, `still.rect` sized, drawn over the eyes (speech blinks). | 1 |
| `closed_audio.f32` | The closed-mouth audio window: 40 x 1024 float32, little endian (163,840 bytes). | 2 |
| `encoder.onnx` | The FeatherTalk audio encoder (FeatherHuBERT, the iOS `encoder21` / `encoder_runtime`). The same bytes in every pack, so the CDN stores its chunks once. | 2 |
| `renderer.onnx` | The character's lip renderer (UNet + SR-lite x2). | 2 |
| `hosts.mp4` | The iOS pack's HEVC host footage, byte for byte (`manifest.json` receipt). Decoded with WebCodecs where the browser has HEVC. | 2 |
| `hosts.h264.mp4` | The same footage as H.264 for browsers without HEVC: High profile, no B-frames, a keyframe every 15 frames (as the HEVC), CRF 14 (about 51 dB PSNR against the HEVC), the HEVC's colour tags. Only downloaded when `hosts.mp4` can't be decoded. | 2 |

The runtime never parses MP4: `pack.json` carries each video's codec string, decoder description (`hvcC` / `avcC`) and
every frame's byte range, so a frame is a slice of the file handed to `VideoDecoder` as an `EncodedVideoChunk`.

## `pack.json`

```jsonc
{
  "format": "feathertalk-web",
  "schema": 1,
  "id": "astrid",                       // the CDN character id
  "name": "Astrid",
  "identity": "astrid-exp-B350-e174",   // the iOS pack identity (AvatarManifest.identity)
  "audio": {
    "sampleRate": 16000, "fps": 25, "samplesPerFrame": 640, "encoderTailSamples": 80,
    "waveformMean": 0.000182, "waveformStd": 0.0603,   // the encoder input is (sample - mean) / std
    "encoderWindowFrames": [8, 13, 14, 15, 16, 17, 18, 19, 20, 21]
  },
  "windows": { "lookahead": 9, "left": 16, "right": 4, "bootstrap": 8 },   // LipWindows
  "geometry": {                         // CropGeometry; the 288 trunk faces: 288 / 576 / 608, hole 8, 8, 270 x 260
    "inner": 144, "output": 288, "outer": 304,
    "hole": { "x": 4, "y": 4, "width": 135, "height": 130 },
    "featherPixels": 8, "channelOrder": "BGR"
  },
  "models": {
    // encoder: audio [B, N] (N = frames x 640 + 80, normalised with waveformMean/Std) -> hidden [B, 2 x frames, 1024]
    "encoder": { "file": "encoder.onnx", "input": "audio", "output": "hidden", "batch": true },
    // renderer: image [1, 6, inner, inner] (reference BGR / 255, then the same crop with the hole zeroed) and
    // audio [1, 40, 1024] -> clip_0 [1, 3, output, output], BGR in [0, 1]
    "renderer": { "file": "renderer.onnx", "image": "image", "audio": "audio", "output": "clip_0", "precision": "fp16" },
    "closedAudio": "closed_audio.f32"
  },
  "hosts": {
    "width": 1080, "height": 1920, "count": 258,
    "boxes": [[382, 597, 708, 923], ...],   // per host frame: x0, y0, x1, y1 (square), the face box the crops are cut from
    "colour": { "matrix": "smpte170m", "primaries": "bt709", "transfer": "bt709", "range": "tv" },
    "videos": [
      { "file": "hosts.mp4", "codec": "hvc1.1.6.L120.90", "description": "<base64 hvcC>", "keyframeInterval": 15,
        "frames": [[offset, size], ...] },   // in display order; frame i is host i; a keyframe every keyframeInterval
      { "file": "hosts.h264.mp4", "codec": "avc1.64002a", "description": "<base64 avcC>", "keyframeInterval": 15,
        "frames": [[offset, size], ...] }
    ]
  },
  "calmWindow": { ... },                // calm-window.json as iOS reads it (AvatarPack.CalmHostWindow): the head path
  "hostPoses": { ... },                 // host-poses.json (informational; not read by the runtime)
  "still": {
    "base": "still/base.jpg", "host": 10, "rect": [379, 476, 308, 127], "sequence": [0, 1, 2, 3, 4, 5],
    "blinks": ["still/blink-0.jpg", ...]
  },
  "face": { "voice": "sage", "lipLeadMilliseconds": 0, "articulationGain": 1.2 },
  "instantLips": { "lookaheadFrames": 1, "batchFrames": 1, "standIn": "mirror", "voiceDelayMilliseconds": 110 },
  "lipPicture": {                       // LipPicture for this identity, or null (the whole square over the 8 px feather)
    "sharpen": 1.2, "teeth": 1.5,
    "mouth": { "centerX": 0.48, "centerY": 0.54, "radiusX": 0.45, "radiusY": 0.38, "rotationDegrees": -20, "softness": 0.0833333 }
  },
  "files": { "renderer.onnx": { "bytes": 0, "sha256": "..." }, ... },   // every other file of the pack
  "source": { ... }                     // provenance: face folder, iOS manifest SHA-256, ONNX export record
}
```

Rules the runtime checks at load (a pack that fails one is refused, as iOS refuses a pack):

- `audio`: 16 kHz, 25 fps, 640 samples a frame, 80 tail samples, `waveformStd` > 1e-6, the window list above.
- `windows`: the H08 contract (9 / 16 / 4 / 8) or a low-lookahead one (bootstrap 0, left >= 16, left + 1 + right = 21).
- `geometry`: output a whole multiple of inner, outer a multiple of the scale, the face side (outer / scale) at least inner
  with an even border, the hole inside the inner crop, feather 8.
- `hosts.boxes`: one square box per host inside the frame; `calmWindow` must fit the host count (`CalmHostWindow.fits`).
- `instantLips`: lookahead 0-12, batch 1-6, stand-in `mirror` or `silence`, voice delay 0-1000 ms; `articulationGain`
  0.5-2.
- Every file is checked against `files` (bytes and SHA-256) before use; the CDN also checks every chunk.

## Host pictures

The runtime converts the footage's YCbCr to RGB itself, as VideoToolbox does for these clips on iOS (fitted on the iOS
decode of three host frames: 91.5% of channel values exact, never more than 2 levels off; `image-ops.ts` VT_601_RGB).
The renderer's crops are cut from the decoded frames on the GPU at load (inner) and per frame (outer) with the iOS
`DerivedCrops` arithmetic (OpenCV INTER_AREA), so no crop banks ship.

## Derived values (the same as iOS)

- `instantLips` comes from the lead (`LipTiming.instantLips(leadMilliseconds:)`): lookahead = round(lead / 40) + 1,
  batch 1, mirror, voice delay = (2 x lookahead + 1) x 20 - lead + 30 + 20 ms. All 13 faces are lead-free: 1 frame, 110 ms.
- The silence seal is judged `round(lead / 40)` frames later (`silenceGateShiftFrames`): 0 for these faces.
- `lipPicture` is iOS `LipPicture.face(identity:)` (Valentina, Leonie, Astrid, Linda, Santiago, Julien, Lars); the six
  288 trunk faces have none and paste the whole square over the 8-pixel feather.

## CDN

`yoob-cdn/characters/<id>.web.json`:

```json
{
  "character": "astrid", "platform": "web", "version": "2026.10.07.1", "engine": "feathertalk-web",
  "displayName": "Astrid", "minSDK": "0.4.0",
  "source": "<web pack directory>",
  "idle": { "source": "<web pack directory>/still", "fps": 25 },
  "tiers": { "pack.json": 1, "still/base.jpg": 1 },
  "runtime": { "assetVersion": "<id>-<identity>-web1", "pack": "pack.json" }
}
```

The packer's `poster.jpg` is then `still/base.jpg` (the first JPEG of the still folder). SDKs before 0.4.0 refuse the
engine by `minSDK`; 0.4.0 refuses `latest.web.json` manifests whose engine it doesn't know.

## Building a pack

```sh
node scripts/feathertalk-pack.mjs \
  --face ~/.local/share/language-companions/assets/avatars-astrid-exp/B \
  --onnx <web-onnx>/B --encoder <web-onnx>/_shared/encoder.onnx \
  --id astrid --out packs/astrid
```

`packs/` is ignored by git. The script needs `ffmpeg` and `ffprobe` on the PATH. It verifies the iOS receipts of every
file it copies, re-encodes the H.264 fallback and checks that it decodes to the same frame count.
