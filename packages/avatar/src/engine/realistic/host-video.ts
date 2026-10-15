// The character's host footage decoded with WebCodecs (iOS: HostVideoDecoder.swift). The head path walks its lanes forward
// and backward, so a whole group of pictures is decoded at once and kept (iOS keeps 16 decoded frames); a frame is
// delivered as its YCbCr planes (the compositor converts them to RGB as VideoToolbox does).
import type { HostVideo } from "./pack";
import type { YuvPlanes } from "./image-ops";

export function base64Bytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function videoSupported(video: HostVideo, width: number, height: number): Promise<boolean> {
  if (typeof VideoDecoder === "undefined") return false;
  try {
    const result = await VideoDecoder.isConfigSupported({
      codec: video.codec, codedWidth: width, codedHeight: height, description: base64Bytes(video.description),
      hardwareAcceleration: "no-preference",
    });
    return result.supported === true;
  } catch {
    return false;
  }
}

/** The first video of the pack this browser decodes, or undefined. */
export async function pickVideo(videos: HostVideo[], width: number, height: number): Promise<HostVideo | undefined> {
  for (const video of videos) if (await videoSupported(video, width, height)) return video;
  return undefined;
}

export class HostVideoDecoder {
  /** Decoded groups of pictures kept (each `keyframeInterval` frames of YCbCr). */
  static readonly cachedGroups = 3;
  private readonly groups = new Map<number, Promise<YuvPlanes[]>>();
  private readonly order: number[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly description: Uint8Array;
  decodeMs = 0;
  groupsDecoded = 0;

  constructor(private readonly video: HostVideo, private readonly data: Uint8Array, readonly width: number, readonly height: number) {
    this.description = base64Bytes(video.description);
  }

  get count(): number { return this.video.frames.length; }

  /** Host `index`'s planes; `prefetch` names hosts to decode ahead. */
  frame(index: number, prefetch: number[] = []): Promise<YuvPlanes> {
    const interval = this.video.keyframeInterval;
    const group = Math.floor(index / interval);
    const pending = this.group(group);
    for (const next of prefetch) {
      const g = Math.floor(next / interval);
      if (g !== group) void this.group(g).catch(() => undefined);
    }
    return pending.then((frames) => frames[index - group * interval]);
  }

  private group(group: number): Promise<YuvPlanes[]> {
    let pending = this.groups.get(group);
    if (pending) {
      this.order.splice(this.order.indexOf(group), 1);
      this.order.push(group);
      return pending;
    }
    // One decode at a time: the decoder is configured per group, and the groups the head needs next come in order.
    pending = this.queue.then(() => this.decodeGroup(group));
    this.queue = pending.catch(() => undefined);
    this.groups.set(group, pending);
    this.order.push(group);
    while (this.order.length > HostVideoDecoder.cachedGroups) this.groups.delete(this.order.shift()!);
    pending.catch(() => this.groups.delete(group));
    return pending;
  }

  private async decodeGroup(group: number): Promise<YuvPlanes[]> {
    const started = performance.now();
    const interval = this.video.keyframeInterval;
    const first = group * interval, last = Math.min(this.count, first + interval);
    const frames: YuvPlanes[] = new Array(last - first);
    const copies: Promise<void>[] = [];
    let failure: unknown;
    const decoder = new VideoDecoder({
      output: (frame) => {
        const index = Math.round(frame.timestamp / 40_000) - first;
        copies.push(copyPlanes(frame).then((planes) => { if (index >= 0 && index < frames.length) frames[index] = planes; })
          .finally(() => frame.close()));
      },
      error: (error) => { failure = error; },
    });
    decoder.configure({ codec: this.video.codec, codedWidth: this.width, codedHeight: this.height, description: this.description,
      optimizeForLatency: true });
    for (let i = first; i < last; i += 1) {
      const [offset, size] = this.video.frames[i];
      decoder.decode(new EncodedVideoChunk({
        type: i === first ? "key" : "delta", timestamp: i * 40_000, duration: 40_000, data: this.data.subarray(offset, offset + size),
      }));
    }
    await decoder.flush();
    decoder.close();
    await Promise.all(copies);
    if (failure) throw failure;
    if (frames.some((f) => !f)) throw new Error(`host video group ${group} decoded short`);
    this.decodeMs += performance.now() - started; this.groupsDecoded += 1;
    return frames;
  }
}

/** A decoded frame's planes, copied tightly packed (NV12 keeps Cb and Cr interleaved). */
async function copyPlanes(frame: VideoFrame): Promise<YuvPlanes> {
  const visible = frame.visibleRect ?? { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
  const w = visible.width, h = visible.height, cw = (w + 1) >> 1, ch = (h + 1) >> 1;
  const format = frame.format;
  const rect = { x: visible.x, y: visible.y, width: w, height: h };
  if (format === "NV12") {
    const buffer = new Uint8Array(w * h + cw * 2 * ch);
    await frame.copyTo(buffer, { rect, layout: [{ offset: 0, stride: w }, { offset: w * h, stride: cw * 2 }] });
    return { width: w, height: h, y: buffer.subarray(0, w * h), u: buffer.subarray(w * h), v: buffer.subarray(w * h), yStride: w, uvStride: cw * 2, interleaved: true };
  }
  if (format === "I420" || format === "I420A") {
    const buffer = new Uint8Array(w * h + 2 * cw * ch + (format === "I420A" ? w * h : 0));
    const layout = [{ offset: 0, stride: w }, { offset: w * h, stride: cw }, { offset: w * h + cw * ch, stride: cw }];
    if (format === "I420A") layout.push({ offset: w * h + 2 * cw * ch, stride: w });
    await frame.copyTo(buffer, { rect, layout });
    return { width: w, height: h, y: buffer.subarray(0, w * h), u: buffer.subarray(w * h, w * h + cw * ch),
      v: buffer.subarray(w * h + cw * ch, w * h + 2 * cw * ch), yStride: w, uvStride: cw };
  }
  throw new Error(`host video frames come as ${format}; NV12 or I420 needed`);
}
