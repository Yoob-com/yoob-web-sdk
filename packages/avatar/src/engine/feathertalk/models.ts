// The FeatherTalk encoder and renderer on ONNX Runtime Web (iOS: AvatarModels.swift).
import { createSession, ort } from "../inference/ort-runtime";
import type { LipModels } from "./streaming";
import type { CropGeometry, FeatherTalkPack } from "./pack";

const f32 = Math.fround;
/** byte / 255 exactly as the iOS table (Float(b) / 255). */
const BYTE_SCALE = Float32Array.from({ length: 256 }, (_, b) => f32(b / 255));

export interface ModelTimings { encodeMs: number; encodes: number; encodedWindows: number; renderMs: number; renders: number }

export class FeatherTalkModels implements LipModels {
  readonly timings: ModelTimings = { encodeMs: 0, encodes: 0, encodedWindows: 0, renderMs: 0, renders: 0 };
  private readonly mean: number;
  private readonly std: number;
  private readonly image: Float32Array;
  /** Inner crops of every host, BGR, host after host (`setInnerCrops`). */
  private innerCrops: Uint8Array = new Uint8Array(0);

  private constructor(
    private readonly encoder: ort.InferenceSession,
    private readonly renderer: ort.InferenceSession,
    private readonly pack: FeatherTalkPack,
    private readonly geometry: CropGeometry,
  ) {
    this.mean = f32(pack.audio.waveformMean); this.std = f32(pack.audio.waveformStd);
    this.image = new Float32Array(6 * geometry.inner * geometry.inner);
  }

  static async load(pack: FeatherTalkPack, geometry: CropGeometry, encoderModel: Uint8Array, rendererModel: Uint8Array,
    providers: ("webgpu" | "wasm")[] = ["webgpu"]): Promise<FeatherTalkModels> {
    // Warnings only (the renderer's constant-folding notes are expected).
    const quiet = { logSeverityLevel: 3 as const };
    const renderer = await createSession(rendererModel, providers, "FeatherTalk renderer", undefined, quiet);
    const encoder = await createSession(encoderModel, providers, "FeatherTalk encoder", undefined, quiet);
    return new FeatherTalkModels(encoder, renderer, pack, geometry);
  }

  /** The renderer's input crops of every host (iOS DerivedCrops), derived from the host video once at load. */
  setInnerCrops(crops: Uint8Array): void {
    if (crops.length !== this.pack.hosts.count * this.geometry.innerBytes) throw new Error("inner crops");
    this.innerCrops = crops;
  }

  /** The GPU device ONNX Runtime runs on (the compositor shares it). */
  static async device(): Promise<GPUDevice | undefined> {
    try { return await ort.env.webgpu.device as GPUDevice; } catch { return undefined; }
  }


  async encode(samples: Float32Array, frameCount: number): Promise<Float32Array> {
    return (await this.encodeBatch([samples], frameCount))[0];
  }

  /** Several windows of one length in one encoder call (the encoder has a batch axis). */
  async encodeBatch(windows: Float32Array[], frameCount: number): Promise<Float32Array[]> {
    const length = frameCount * 640 + 80;
    if (!this.pack.audio.encoderWindowFrames.includes(frameCount) || windows.some((w) => w.length !== length)) {
      throw new Error("invalid encoder window");
    }
    const batch = this.pack.models.encoder.batch ? windows.length : 1;
    if (batch !== windows.length) {
      const out: Float32Array[] = [];
      for (const window of windows) out.push(...await this.encodeBatchNow([window], length, frameCount));
      return out;
    }
    return this.encodeBatchNow(windows, length, frameCount);
  }

  private async encodeBatchNow(windows: Float32Array[], length: number, frameCount: number): Promise<Float32Array[]> {
    const started = performance.now();
    const input = new Float32Array(windows.length * length);
    const mean = this.mean, std = this.std;
    windows.forEach((window, b) => {
      for (let i = 0; i < length; i += 1) input[b * length + i] = f32(f32(window[i] - mean) / std);
    });
    const names = this.pack.models.encoder;
    const tensor = new ort.Tensor("float32", input, [windows.length, length]);
    const result = await this.encoder.run({ [names.input]: tensor });
    const output = result[names.output];
    const tokens = frameCount * 2;
    if (!output || output.dims.length !== 3 || output.dims[1] !== tokens || output.dims[2] !== 1024) throw new Error(`encoder output ${output?.dims}`);
    const data = await output.getData() as Float32Array;
    tensor.dispose(); output.dispose();
    this.timings.encodeMs += performance.now() - started; this.timings.encodes += 1; this.timings.encodedWindows += windows.length;
    return windows.map((_, b) => data.slice(b * tokens * 1024, (b + 1) * tokens * 1024));
  }

  async render(window: Float32Array, host: number): Promise<Uint8Array> {
    const started = performance.now();
    const g = this.geometry, inner = g.inner, plane = inner * inner, hole = g.hole;
    const crops = this.innerCrops, base = host * plane * 3, image = this.image;
    for (let c = 0; c < 3; c += 1) {
      for (let i = 0; i < plane; i += 1) {
        const value = BYTE_SCALE[crops[base + i * 3 + c]];
        image[c * plane + i] = value;
        image[(c + 3) * plane + i] = value;
      }
      const masked = (c + 3) * plane;
      for (let y = hole.y; y < hole.y + hole.height; y += 1) image.fill(0, masked + y * inner + hole.x, masked + y * inner + hole.x + hole.width);
    }
    const names = this.pack.models.renderer;
    const imageTensor = new ort.Tensor("float32", image, [1, 6, inner, inner]);
    const audioTensor = new ort.Tensor("float32", window, [1, 40, 1024]);
    const result = await this.renderer.run({ [names.image]: imageTensor, [names.audio]: audioTensor });
    const output = result[names.output];
    const side = g.output;
    if (!output || output.dims.join() !== [1, 3, side, side].join()) throw new Error(`renderer output ${output?.dims}`);
    const values = await output.getData() as Float32Array;
    imageTensor.dispose(); audioTensor.dispose(); output.dispose();
    // value x 255, clamped, truncated (vDSP_vfixu8), interleaved BGR.
    const count = side * side, bytes = new Uint8Array(count * 3);
    for (let c = 0; c < 3; c += 1) {
      for (let i = 0; i < count; i += 1) {
        const v = values[c * count + i];
        if (!Number.isFinite(v)) throw new Error("nonfinite prediction");
        const s = f32(v * 255);
        bytes[i * 3 + c] = s <= 0 ? 0 : s >= 255 ? 255 : Math.trunc(s);
      }
    }
    this.timings.renderMs += performance.now() - started; this.timings.renders += 1;
    return bytes;
  }

  /** One encode and one render on silence, so the first call frame pays no shader compilation. */
  async warmUp(closedAudio: Float32Array): Promise<void> {
    for (const frames of this.pack.audio.encoderWindowFrames) await this.encode(new Float32Array(frames * 640 + 80), frames);
    await this.render(closedAudio, this.pack.calmWindow.first);
  }
}
