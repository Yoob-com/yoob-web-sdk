import { isFeatherTalk } from '../cdn';
import { DEFAULT_TENSORS, type FeatherPack } from './contract';

/**
 * The second FeatherTalk pack layout, `pack.json`, named by the manifest's `runtime.pack`.
 *
 * It describes the same renderer as `feathertalk.json` and differs in where the pictures come from. The old layout
 * shipped one JPEG per host frame and a prebuilt bank of mouth crops; this one ships the host frames as video and no
 * bank at all, so the crops are cut from the decoded frame at run time. Everything the two have in common — geometry,
 * waveform normalisation, mouth mask — carries the same values, so both read into one `FeatherPack`.
 *
 * Only the fields this SDK uses are typed. The pack carries more (`calmWindow`, `hostPoses`, the blink stills) for the
 * idle controller, which is not implemented here yet.
 */
export interface PackV2 {
  format: string;
  schema: number;
  id: string;
  audio: { sampleRate: number; fps: number; waveformMean: number; waveformStd: number };
  geometry: {
    inner: number; output: number; outer: number;
    hole: { x: number; y: number; width: number; height: number };
    featherPixels: number; channelOrder: string;
  };
  models: {
    encoder: { file: string; input?: string; output?: string };
    renderer: { file: string; image?: string; audio?: string; output?: string };
    closedAudio?: string;
  };
  hosts: {
    width: number; height: number; count: number;
    boxes: Array<[number, number, number, number]>;
    videos: PackV2Video[];
  };
  still?: { host?: number };
  face?: { voice?: string };
  instantLips?: {
    lookaheadFrames?: number;
    standIn?: string;
    voiceDelayMilliseconds?: number;
  };
}

/**
 * One encoding of the host frames.
 *
 * `description` is the codec's own configuration record (hvcC or avcC), base64; `frames[i]` is `[byteOffset, length]`
 * of frame `i` inside the file. Between them a `VideoDecoder` can be configured and any frame fed to it without
 * demuxing the container — which is the whole reason the pack carries them.
 */
export interface PackV2Video {
  file: string;
  codec: string;
  description: string;
  keyframeInterval: number;
  frames: Array<[number, number]>;
}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Reads `pack.json` into the shape the engine already speaks.
 *
 * `frames` keeps one entry per host frame, as the old layout had, but with no `host` file to fetch: the picture comes
 * from the video instead. `width`/`height` are the host frame's own, and the boxes are already in that space, so
 * `worker.ts`'s per-frame rescale becomes the identity rather than a special case.
 */
export function readPackV2(raw: unknown): { pack: FeatherPack; v2: PackV2 } {
  const v2 = raw as PackV2;
  if (!isFeatherTalk(v2?.format) || v2.schema !== 1) {
    throw new Error('Unsupported FeatherTalk pack contract');
  }
  const { audio, geometry: g, hosts, models } = v2;
  if (!hosts?.videos?.length || !Array.isArray(hosts.boxes)) throw new Error('FeatherTalk pack has no host frames');
  if (hosts.boxes.length !== hosts.count) throw new Error('FeatherTalk host boxes do not match the frame count');
  if (!positive(hosts.width) || !positive(hosts.height)) throw new Error('Invalid FeatherTalk host size');
  for (const video of hosts.videos) {
    if (typeof video.file !== 'string' || typeof video.codec !== 'string' || typeof video.description !== 'string'
      || !positive(video.keyframeInterval) || video.frames?.length !== hosts.count) {
      throw new Error('Invalid FeatherTalk host video');
    }
  }

  const pack: FeatherPack = {
    tensors: {
      encoderInput: models.encoder.input ?? DEFAULT_TENSORS.encoderInput,
      encoderOutput: models.encoder.output ?? DEFAULT_TENSORS.encoderOutput,
      rendererImage: models.renderer.image ?? DEFAULT_TENSORS.rendererImage,
      rendererAudio: models.renderer.audio ?? DEFAULT_TENSORS.rendererAudio,
      rendererOutput: models.renderer.output ?? DEFAULT_TENSORS.rendererOutput,
    },
    fps: audio.fps,
    sampleRate: audio.sampleRate,
    innerSize: g.inner,
    outerSize: g.outer,
    outputSize: g.output,
    width: hosts.width,
    height: hosts.height,
    waveformMean: audio.waveformMean,
    waveformStd: audio.waveformStd,
    hole: g.hole,
    featherPixels: g.featherPixels,
    frames: hosts.boxes.map((bbox) => ({ bbox, width: hosts.width, height: hosts.height, host: '' })),
    encoder: models.encoder.file,
    renderer: models.renderer.file,
    // No bank: the crops are cut from the decoded host frame. `innerBank` stays in the type for the old layout.
    innerBank: '',
    // The still's host is the neutral pose the pack was built around; the old layout called it frame zero.
    referenceFrame: v2.still?.host ?? 0,
  };
  return { pack, v2 };
}
