import { quantizeFloat16 } from "../math/rounding";
import { createSession, ort } from "./ort-runtime";

const CONTEXT = 8000;
const HOP = 320;
const CONV_STRIDE = 320;
const FIRST_CENTER = 199.5;

export class AudioFeatures {
  private silence?: Float32Array;

  private constructor(private readonly session: ort.InferenceSession) {}

  static async load(model: string | Uint8Array) {
    // ORT WebGPU session creation can hang indefinitely for this small encoder
    // instead of rejecting, which prevents provider fallback. Threaded WASM is
    // fast enough for Feather and leaves WebGPU available for the renderer.
    return new AudioFeatures(await createSession(
      model, ["wasm"], "AudioFeatures",
    ));
  }

  async extract(pcm16k: Float32Array, frameCount: number, shift = 2): Promise<Float32Array> {
    const alignedEnd = frameCount * 640;
    const windowStart = -CONTEXT;
    const windowEnd = alignedEnd + CONTEXT;
    const window = new Float32Array(windowEnd - windowStart);
    window.set(pcm16k.subarray(0, Math.min(pcm16k.length, alignedEnd)), CONTEXT);
    let mean = 0;
    for (let index = 0; index < window.length; index += 1) mean += window[index];
    mean /= window.length;
    let variance = 0;
    for (let index = 0; index < window.length; index += 1) {
      const centered = window[index] - mean;
      variance += centered * centered;
    }
    variance /= window.length;
    const inverseStd = 1 / Math.sqrt(variance + 1e-7);
    for (let index = 0; index < window.length; index += 1) {
      window[index] = (window[index] - mean) * inverseStd;
    }

    const input = new ort.Tensor("float32", window, [1, window.length]);
    let tensor: ort.Tensor | undefined;
    try {
      const result = await this.session.run({ audio: input });
      tensor = result.hidden;
      if (!tensor || tensor.dims.length !== 3 || tensor.dims[2] !== 1024) {
        throw new Error(`bad AudioFeatures output ${tensor?.dims}`);
      }
      const hidden = tensor.data as Float32Array;
      const encoderFrames = tensor.dims[1];
      const rows = new Float32Array(frameCount * 1024);
      for (let frame = 0; frame < frameCount; frame += 1) {
        const target = (2 * frame + 1 + shift) * HOP;
        const position = (target - windowStart - FIRST_CENTER) / CONV_STRIDE;
        if (position < 0 || position > encoderFrames - 1) {
          throw new Error(`AudioFeatures frame ${frame} outside encoder support`);
        }
        const left = Math.floor(position);
        const right = Math.min(left + 1, encoderFrames - 1);
        const weight = position - left;
        for (let channel = 0; channel < 1024; channel += 1) {
          const value = hidden[left * 1024 + channel] * (1 - weight)
            + hidden[right * 1024 + channel] * weight;
          rows[frame * 1024 + channel] = quantizeFloat16(value);
        }
      }
      return rows;
    } finally {
      tensor?.dispose();
      input.dispose();
    }
  }

  async silenceRows(): Promise<Float32Array> {
    if (!this.silence) this.silence = await this.extract(new Float32Array(25 * 640), 25, 2);
    return this.silence;
  }
}
