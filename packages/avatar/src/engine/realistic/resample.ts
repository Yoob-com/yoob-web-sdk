// 24 kHz to 16 kHz for the lip pipeline, streaming: the SDK's resample24kTo16k (scipy resample_poly(x, 2, 3), Kaiser 5)
// computed packet by packet, so a reply's samples come out the same however its audio was cut into packets.
import { RESAMPLE_FILTER } from "../audio/resample-24k-16k";

const PRE_REMOVE = 11;

export class StreamingResampler24To16 {
  private input = new Float32Array(0);
  /** Index of `input[0]` in the stream. */
  private base = 0;
  private received = 0;
  private next = 0;

  push(pcm: Float32Array): Float32Array {
    const joined = new Float32Array(this.input.length + pcm.length);
    joined.set(this.input); joined.set(pcm, this.input.length);
    this.input = joined; this.received += pcm.length;
    return this.drain(false);
  }

  /** The rest of the stream (the missing input after it as zeros), as the one-shot resampler ends it. */
  flush(): Float32Array { return this.drain(true); }

  private drain(final: boolean): Float32Array {
    const total = final ? Math.floor((this.received * 2 + 2) / 3) : Number.POSITIVE_INFINITY;
    const out: number[] = [];
    for (;;) {
      const j = this.next;
      if (j >= total) break;
      const time = (j + PRE_REMOVE) * 3;
      const last = Math.floor(time / 2);
      if (!final && last > this.received - 1) break;
      const first = Math.max(0, Math.ceil((time - (RESAMPLE_FILTER.length - 1)) / 2));
      const end = Math.min(this.received - 1, last);
      let sum = 0;
      for (let k = first; k <= end; k += 1) sum += RESAMPLE_FILTER[time - k * 2] * this.input[k - this.base];
      out.push(sum);
      this.next += 1;
    }
    // Keep only the input the next outputs read.
    const keepFrom = Math.max(0, Math.ceil(((this.next + PRE_REMOVE) * 3 - (RESAMPLE_FILTER.length - 1)) / 2));
    if (keepFrom > this.base) { this.input = this.input.slice(keepFrom - this.base); this.base = keepFrom; }
    return Float32Array.from(out);
  }
}
