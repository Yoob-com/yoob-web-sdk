export interface FeatherFrame {
  bbox: [number, number, number, number];
  width: number; height: number; host: string;
}
export interface FeatherPack {
  fps: number; sampleRate: number; innerSize: number; outerSize: number; outputSize: number;
  width: number; height: number; waveformMean: number; waveformStd: number;
  hole: { x: number; y: number; width: number; height: number };
  featherPixels: number; frames: FeatherFrame[]; encoder: string; renderer: string;
  innerBank: string; referenceFrame: number;
}
export function validatePack(p: FeatherPack): void {
  if (p.fps !== 25 || p.sampleRate !== 16000 || ![144, 288].includes(p.innerSize)
    || p.outputSize !== 2 * p.innerSize || p.outerSize !== p.innerSize * 304 / 144
    || !(p.waveformStd > 0) || !Number.isFinite(p.waveformMean)
    || !p.frames?.length || !Number.isInteger(p.referenceFrame)
    || p.referenceFrame < 0 || p.referenceFrame >= p.frames.length) throw new Error('Unsupported FeatherTalk pack contract');
  const h = p.hole;
  if (![h.x,h.y,h.width,h.height,p.width,p.height,p.featherPixels].every(Number.isFinite)
    || h.x < 0 || h.y < 0 || h.width <= 0 || h.height <= 0
    || h.x+h.width>p.innerSize || h.y+h.height>p.innerSize) throw new Error('Invalid FeatherTalk mouth mask');
  for (const f of p.frames) {
    if (f.bbox.length !== 4 || !f.bbox.every(Number.isFinite) || f.bbox[2] <= f.bbox[0]
      || f.bbox[3] <= f.bbox[1] || f.width <= 0 || f.height <= 0) throw new Error('Invalid FeatherTalk host bounds');
  }
}
/** Forward/backward traversal without a duplicate frame at either end. */
export function hostIndex(frame: number, count: number): number {
  if (count <= 1) return 0;
  const x = frame % (2 * count - 2);
  return x < count ? x : 2 * count - 2 - x;
}
/** ONNX inputs are planar float32 BGR, even when its internal weights are FP16. */
export function imageInput(bank: Uint8Array, host: number, p: FeatherPack): Float32Array {
  const size = p.innerSize, plane = size * size, stride = plane * 3;
  if (bank.length !== p.frames.length * stride) throw new Error('FeatherTalk crop bank length mismatch');
  const out = new Float32Array(plane * 6);
  for (let i=0;i<plane;i++) {
    const x=i%size, y=Math.floor(i/size), h=p.hole;
    const hole=x>=h.x && x<h.x+h.width && y>=h.y && y<h.y+h.height;
    for (let c=0;c<3;c++) {
      out[c*plane+i]=bank[p.referenceFrame*stride+i*3+c]/255;
      out[(c+3)*plane+i]=hole?0:bank[host*stride+i*3+c]/255;
    }
  }
  return out;
}
/** The model consumes 20 frames (40 feature rows), with the target at frame 10. */
export function audioInput(hidden: Float32Array, tokens: number, frame: number, windowStart: number): Float32Array {
  const out = new Float32Array(40*1024);
  for(let row=0;row<40;row++) {
    const token=Math.max(0,Math.min(tokens-1,(frame-10-windowStart)*2+row));
    out.set(hidden.subarray(token*1024,(token+1)*1024),row*1024);
  }
  return out;
}
