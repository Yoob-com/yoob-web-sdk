import { bankCrop, cropStride, type FeatherPack } from './contract';
import type { PackV2, PackV2Video } from './pack-v2';

/**
 * Where the renderer's two pictures per frame come from: the host image it composites onto, and the inner crop it
 * feeds the model.
 *
 * The two pack layouts answer this differently — one JPEG and one bank row per frame, or one video frame cut two ways
 * — and nothing above this interface needs to know which.
 */
export interface HostFrames {
  /** The full host picture, to draw at its native size. */
  picture(index: number): Promise<CanvasImageSource>;
  /** That frame's mouth crop, `innerSize * innerSize * 3` BGR interleaved, as the model wants it. */
  crop(index: number): Promise<Uint8Array>;
  close(): void;
}

/** How many decoded host frames to keep. Eight are in flight per batch, so this holds a few batches eitherward. */
const CACHE = 24;

/** The old layout: one JPEG per frame, fetched on demand, and a prebuilt bank of crops. */
export class JpegHosts implements HostFrames {
  private images = new Map<number, ImageBitmap>();
  constructor(
    private pack: FeatherPack,
    private bank: Uint8Array,
    private read: (path: string) => Promise<ArrayBuffer>,
    private release: (path: string) => void,
  ) {}

  async picture(index: number): Promise<CanvasImageSource> {
    const cached = this.images.get(index);
    if (cached) return cached;
    const path = this.pack.frames[index].host;
    const bytes = await this.read(path);
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    this.release(path);
    this.images.set(index, image);
    if (this.images.size > CACHE) {
      const oldest = this.images.keys().next().value!;
      this.images.get(oldest)!.close();
      this.images.delete(oldest);
    }
    return image;
  }

  async crop(index: number): Promise<Uint8Array> {
    return bankCrop(this.bank, index, this.pack);
  }

  close(): void {
    for (const image of this.images.values()) image.close();
    this.images.clear();
  }
}

/**
 * The new layout: host frames out of an encoded video, crops cut from them.
 *
 * `VideoDecoder` rather than a `<video>` element, because this runs in a worker where there is no DOM — and because
 * the pack is built for it: each video carries its codec description and the byte range of every frame, so frames can
 * be fed to a decoder directly with no container parsing.
 */
export class VideoHosts implements HostFrames {
  private pictures = new Map<number, VideoFrame>();
  private crops = new Map<number, Uint8Array>();
  private pending?: Promise<void>;
  private canvas: OffscreenCanvas;
  private context: OffscreenCanvasRenderingContext2D;
  private outer: OffscreenCanvas;
  private outerContext: OffscreenCanvasRenderingContext2D;

  private constructor(
    private pack: FeatherPack,
    private video: PackV2Video,
    private bytes: Uint8Array,
    private config: VideoDecoderConfig,
  ) {
    const size = pack.innerSize;
    this.canvas = new OffscreenCanvas(size, size);
    this.outer = new OffscreenCanvas(pack.outerSize, pack.outerSize);
    const context = this.canvas.getContext('2d', { willReadFrequently: true });
    const outerContext = this.outer.getContext('2d');
    if (!context || !outerContext) throw new Error('Offscreen Canvas2D unavailable');
    this.context = context;
    this.outerContext = outerContext;
  }

  /**
   * Picks the encoding this browser will decode and loads it.
   *
   * Smallest first: the packs ship HEVC alongside H.264 and the HEVC is a third smaller, so where it decodes it is
   * both less to download and less to keep. `isConfigSupported` is the only honest test — codec support varies by
   * platform and by whether hardware decoding is available, not by browser name.
   */
  static async open(
    pack: FeatherPack, v2: PackV2, read: (path: string) => Promise<ArrayBuffer>,
  ): Promise<VideoHosts> {
    if (typeof VideoDecoder === 'undefined') {
      throw new Error('This browser cannot decode the character\'s host video (WebCodecs unavailable).');
    }
    const bySize = [...v2.hosts.videos].sort((a, b) => lastByte(a) - lastByte(b));
    for (const video of bySize) {
      const config: VideoDecoderConfig = {
        codec: video.codec,
        description: base64(video.description),
        codedWidth: v2.hosts.width,
        codedHeight: v2.hosts.height,
      };
      const supported = await VideoDecoder.isConfigSupported(config).then((r) => r.supported, () => false);
      if (!supported) continue;
      return new VideoHosts(pack, video, new Uint8Array(await read(video.file)), config);
    }
    throw new Error('This browser cannot decode any of the character\'s host videos.');
  }

  async picture(index: number): Promise<CanvasImageSource> {
    const frame = await this.decoded(index);
    return frame;
  }

  async crop(index: number): Promise<Uint8Array> {
    const cached = this.crops.get(index);
    if (cached) return cached;
    const frame = await this.decoded(index);
    const [x1, y1, x2, y2] = this.pack.frames[index].bbox;
    // The recipe the prebuilt bank was made with, so both layouts feed the model the same pixels: the box, scaled to
    // the outer size, then its centre at the output size, scaled down to the model's input.
    this.outerContext.drawImage(frame, x1, y1, x2 - x1, y2 - y1, 0, 0, this.pack.outerSize, this.pack.outerSize);
    const inset = (this.pack.outerSize - this.pack.outputSize) / 2;
    this.context.drawImage(
      this.outer, inset, inset, this.pack.outputSize, this.pack.outputSize, 0, 0, this.pack.innerSize, this.pack.innerSize,
    );
    const { data } = this.context.getImageData(0, 0, this.pack.innerSize, this.pack.innerSize);
    const out = new Uint8Array(cropStride(this.pack));
    for (let i = 0; i < out.length / 3; i += 1) {
      out[i * 3] = data[i * 4 + 2];       // B
      out[i * 3 + 1] = data[i * 4 + 1];   // G
      out[i * 3 + 2] = data[i * 4];       // R
    }
    this.crops.set(index, out);
    if (this.crops.size > CACHE * 2) this.crops.delete(this.crops.keys().next().value!);
    return out;
  }

  /**
   * One decoded frame.
   *
   * Decoding is serialised: a `VideoDecoder` is a stream, and two callers interleaving chunks into one would get each
   * other's pictures. Callers ask for frames in the renderer's ping-pong order, often backwards, so each request
   * starts at the frame's own keyframe — at most `keyframeInterval` frames of work, and the whole group is kept since
   * the next request is usually its neighbour.
   */
  private decoded(index: number): Promise<VideoFrame> {
    const run = async (): Promise<VideoFrame> => {
      const existing = this.pictures.get(index);
      if (existing) return existing;
      await this.decodeGroup(index);
      const frame = this.pictures.get(index);
      if (!frame) throw new Error(`The character's host video produced no frame ${index}.`);
      return frame;
    };
    // Chain rather than run: the await above may resolve while another group is mid-flight.
    const next = (this.pending ?? Promise.resolve()).then(run, run);
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }

  private async decodeGroup(index: number): Promise<void> {
    const gop = this.video.keyframeInterval;
    const first = Math.floor(index / gop) * gop;
    const last = Math.min(first + gop - 1, this.video.frames.length - 1);

    const decoder = new VideoDecoder({
      output: (frame) => {
        // The timestamp is the frame number: that is what it was encoded with, below.
        const at = Math.round(frame.timestamp / 1000);
        if (this.pictures.has(at)) frame.close();
        else this.pictures.set(at, frame);
      },
      error: () => undefined,
    });
    try {
      decoder.configure(this.config);
      for (let i = first; i <= last; i += 1) {
        const [offset, length] = this.video.frames[i];
        decoder.decode(new EncodedVideoChunk({
          type: i === first ? 'key' : 'delta',
          timestamp: i * 1000,
          data: this.bytes.subarray(offset, offset + length),
        }));
      }
      await decoder.flush();
    } finally {
      if (decoder.state !== 'closed') decoder.close();
    }
    this.evict(index);
  }

  /** Keep the frames around the one just asked for; a `VideoFrame` holds a GPU surface and must be closed. */
  private evict(around: number): void {
    if (this.pictures.size <= CACHE) return;
    const far = [...this.pictures.keys()].sort((a, b) => Math.abs(b - around) - Math.abs(a - around));
    for (const index of far.slice(0, this.pictures.size - CACHE)) {
      this.pictures.get(index)!.close();
      this.pictures.delete(index);
    }
  }

  close(): void {
    for (const frame of this.pictures.values()) frame.close();
    this.pictures.clear();
    this.crops.clear();
  }
}

/** The end of the last frame: how much of the file is actually frames, which is what it costs to download. */
function lastByte(video: PackV2Video): number {
  const [offset, length] = video.frames[video.frames.length - 1];
  return offset + length;
}

function base64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
