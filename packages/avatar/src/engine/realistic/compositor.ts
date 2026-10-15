// The realistic frame composed on the GPU (WebGPU), a port of the iOS Metal compositor (FaceMetalCompositor.swift, whose
// CPU twin AvatarCompositor.swift is the reference): the host picture from the video's YCbCr planes, the face square
// (the model's crop sharpened into the outer crop's paste hole, Lanczos-4 resized with 11-bit integer taps to the face
// box, blended over the 8-pixel feather or the mouth matte, the silence mix), the blink picture and the white bars.
import { VT_601_RGB, areaTable, lanczosTaps, roundHalfEven } from "./image-ops";
import type { CropGeometry } from "./pack";

const GPU_USAGE = { STORAGE: 0x80, COPY_DST: 0x8, COPY_SRC: 0x4, UNIFORM: 0x40, MAP_READ: 0x1 };
const TEXTURE_USAGE = { COPY_DST: 0x2, TEXTURE_BINDING: 0x4, STORAGE_BINDING: 0x8, RENDER_ATTACHMENT: 0x10, COPY_SRC: 0x1 };

/** The host frame's planes at bindings `b`..`b + 2` and its RGB as VideoToolbox gives it (image-ops VT_601_RGB). */
const HOST = (b: number) => /* wgsl */ `
override nv12: bool = false;
@group(0) @binding(${b}) var yPlane: texture_2d<u32>;
@group(0) @binding(${b + 1}) var uPlane: texture_2d<u32>;
@group(0) @binding(${b + 2}) var vPlane: texture_2d<u32>;
fn chromaSample(cx: i32, cy: i32, which: i32) -> f32 {
  if (nv12) { let uv = textureLoad(uPlane, vec2<i32>(cx, cy), 0); return f32(select(uv.r, uv.g, which == 1)); }
  if (which == 0) { return f32(textureLoad(uPlane, vec2<i32>(cx, cy), 0).r); }
  return f32(textureLoad(vPlane, vec2<i32>(cx, cy), 0).r);
}
fn chroma(x: i32, y: i32, which: i32) -> f32 {
  let size = vec2<i32>(textureDimensions(uPlane));
  let cx = x >> 1u; let cy = y >> 1u;
  let cx1 = min(cx + 1, size.x - 1); let cy1 = min(cy + 1, size.y - 1);
  var top = chromaSample(cx, cy, which);
  var bottom = chromaSample(cx, cy1, which);
  if ((x & 1) == 1) {
    top = (top + chromaSample(cx1, cy, which)) / 2.0;
    bottom = (bottom + chromaSample(cx1, cy1, which)) / 2.0;
  }
  if ((y & 1) == 0) { return top; }
  return (top + bottom) / 2.0;
}
fn hostRgb(x: i32, y: i32) -> vec3<f32> {
  let yv = f32(textureLoad(yPlane, vec2<i32>(x, y), 0).r);
  let u = chroma(x, y, 0); let v = chroma(x, y, 1);
  let rgb = vec3<f32>(
    ${VT_601_RGB[0][0]} * yv + ${VT_601_RGB[0][1]} * u + ${VT_601_RGB[0][2]} * v + ${VT_601_RGB[0][3]},
    ${VT_601_RGB[1][0]} * yv + ${VT_601_RGB[1][1]} * u + ${VT_601_RGB[1][2]} * v + ${VT_601_RGB[1][3]},
    ${VT_601_RGB[2][0]} * yv + ${VT_601_RGB[2][1]} * u + ${VT_601_RGB[2][2]} * v + ${VT_601_RGB[2][3]});
  return clamp(round(rgb), vec3<f32>(0.0), vec3<f32>(255.0));
}
`;

/**
 * The face box's crops (DerivedCrops / tools/face_utils.py): OpenCV INTER_AREA from the box to `size`, downscale with the
 * float area table (rounded half up), upscale with OpenCV's integer kernel; BGR bytes, one u32 each, into `dst`.
 */
const CROP = /* wgsl */ `
${HOST(0)}
struct CropParams { x0: i32, y0: i32, side: i32, size: i32, maxTaps: i32, dstOffset: i32, pad0: i32, pad1: i32 };
@group(0) @binding(3) var<uniform> p: CropParams;
@group(0) @binding(4) var<storage, read> tapIndex: array<i32>;
@group(0) @binding(5) var<storage, read> tapWeight: array<f32>;
@group(0) @binding(6) var<storage, read_write> h: array<f32>;
@group(0) @binding(7) var<storage, read_write> dst: array<u32>;
// Every entry point binds every resource (one bind group layout for all four).
fn touch() {
  _ = textureDimensions(yPlane); _ = textureDimensions(uPlane); _ = textureDimensions(vPlane);
  _ = p.x0; _ = tapIndex[0]; _ = tapWeight[0]; _ = h[0]; _ = dst[0];
}
fn bgr(x: i32, y: i32) -> vec3<f32> { let rgb = hostRgb(p.x0 + x, p.y0 + y); return vec3<f32>(rgb.b, rgb.g, rgb.r); }
@compute @workgroup_size(16, 16)
fn area_h(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let d = i32(gid.x); let row = i32(gid.y);
  if (d >= p.size || row >= p.side) { return; }
  var acc = vec3<f32>(0.0);
  for (var k = 0; k < p.maxTaps; k++) {
    let s = tapIndex[d * p.maxTaps + k];
    if (s < 0) { break; }
    acc = bgr(s, row) * tapWeight[d * p.maxTaps + k] + acc;
  }
  let o = (row * p.size + d) * 3;
  h[o] = acc.x; h[o + 1] = acc.y; h[o + 2] = acc.z;
}
@compute @workgroup_size(16, 16)
fn area_v(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let d = i32(gid.x); let r = i32(gid.y);
  if (d >= p.size || r >= p.size) { return; }
  for (var c = 0; c < 3; c++) {
    var acc = 0.0;
    for (var k = 0; k < p.maxTaps; k++) {
      let s = tapIndex[r * p.maxTaps + k];
      if (s < 0) { break; }
      acc = h[(s * p.size + d) * 3 + c] * tapWeight[r * p.maxTaps + k] + acc;
    }
    let v = acc + 0.5;
    dst[p.dstOffset + (r * p.size + d) * 3 + c] = u32(clamp(trunc(v), 0.0, 255.0));
  }
}
// Upscale: taps per output pixel are (cell, next, w0, w1) in tapIndex.
@compute @workgroup_size(16, 16)
fn up_h(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let d = i32(gid.x); let row = i32(gid.y);
  if (d >= p.size || row >= p.side) { return; }
  let a = bgr(tapIndex[d * 4], row); let b = bgr(tapIndex[d * 4 + 1], row);
  let w0 = tapIndex[d * 4 + 2]; let w1 = tapIndex[d * 4 + 3];
  let o = (row * p.size + d) * 3;
  for (var c = 0; c < 3; c++) { h[o + c] = f32((i32(a[c]) * w0 + i32(b[c]) * w1) >> 4u); }
}
@compute @workgroup_size(16, 16)
fn up_v(@builtin(global_invocation_id) gid: vec3<u32>) {
  touch();
  let d = i32(gid.x); let r = i32(gid.y);
  if (d >= p.size || r >= p.size) { return; }
  let cell = tapIndex[r * 4]; let next = tapIndex[r * 4 + 1]; let w0 = tapIndex[r * 4 + 2]; let w1 = tapIndex[r * 4 + 3];
  for (var c = 0; c < 3; c++) {
    let q0 = i32(h[(cell * p.size + d) * 3 + c]); let q1 = i32(h[(next * p.size + d) * 3 + c]);
    let t = ((q0 * w0) >> 16u) + ((q1 * w1) >> 16u);
    dst[p.dstOffset + (r * p.size + d) * 3 + c] = u32(clamp((t + 2) >> 2u, 0, 255));
  }
}
`;

const SHARPEN = /* wgsl */ `
struct SharpenParams { output: i32, outerSide: i32, margin: i32, pasteX: i32, pasteY: i32, pasteWidth: i32, pasteHeight: i32,
  amount: f32, teeth: f32, sharpen: i32, pad0: i32, pad1: i32 };
@group(0) @binding(0) var<storage, read> crop: array<u32>;
@group(0) @binding(1) var<storage, read_write> outer: array<u32>;
@group(0) @binding(2) var<uniform> p: SharpenParams;
@group(0) @binding(3) var<storage, read> region: array<f32>;

fn teethStep(low: f32, high: f32, value: f32) -> f32 {
  let t = min(max((value - low) / (high - low), 0.0), 1.0); return t * t * (3.0 - 2.0 * t);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let hx = i32(gid.x); let hy = i32(gid.y);
  if (hx >= p.pasteWidth || hy >= p.pasteHeight) { return; }
  let x = p.pasteX + hx; let y = p.pasteY + hy; let n = p.output;
  let dst = ((y + p.margin) * p.outerSide + p.margin + x) * 3;
  if (p.sharpen == 0) {
    for (var c = 0; c < 3; c++) { outer[dst + c] = crop[(y * n + x) * 3 + c]; }
    return;
  }
  var taps = array<i32, 5>(1, 4, 6, 4, 1);
  var amount = p.amount;
  if (p.teeth != 0.0) {
    let q = (y * n + x) * 3;
    let blue = f32(crop[q]); let green = f32(crop[q + 1]); let red = f32(crop[q + 2]);
    let luma = 0.299 * red + 0.587 * green + 0.114 * blue;
    let cb = (blue - luma) * 0.564; let cr = (red - luma) * 0.713;
    let weight = teethStep(120.0, 165.0, luma) * (1.0 - teethStep(10.0, 20.0, sqrt(cb * cb + cr * cr)));
    amount = p.amount + p.teeth * weight * region[y * n + x];
  }
  for (var c = 0; c < 3; c++) {
    var sum = 0;
    for (var j = 0; j < 5; j++) {
      let row = clamp(y + j - 2, 0, n - 1) * n;
      var line = 0;
      for (var i = 0; i < 5; i++) { line += taps[i] * i32(crop[(row + clamp(x + i - 2, 0, n - 1)) * 3 + c]); }
      sum += taps[j] * line;
    }
    let value = f32(crop[(y * n + x) * 3 + c]); let blur = f32(sum) * 0.00390625;
    let sharp = value + amount * (value - blur);
    outer[dst + c] = u32(clamp(round(sharp), 0.0, 255.0));
  }
}
`;

const HORIZONTAL = /* wgsl */ `
struct HParams { side: i32, outerSide: i32, pad0: i32, pad1: i32 };
@group(0) @binding(0) var<storage, read> outer: array<u32>;
@group(0) @binding(1) var<storage, read> offsets: array<i32>;
@group(0) @binding(2) var<storage, read> weights: array<i32>;
@group(0) @binding(3) var<storage, read_write> sums: array<i32>;
@group(0) @binding(4) var<uniform> p: HParams;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x); let row = i32(gid.y);
  if (x >= p.side || row >= p.outerSide) { return; }
  let base = row * p.outerSide * 3;
  for (var c = 0; c < 3; c++) {
    var value = 0;
    for (var k = 0; k < 8; k++) { value += i32(outer[base + offsets[x * 8 + k] * 3 + c]) * weights[x * 8 + k]; }
    sums[(row * p.side + x) * 3 + c] = value;
  }
}
`;

const FRAME = /* wgsl */ `
struct FrameParams {
  width: i32, height: i32, faceX: i32, faceY: i32, faceSide: i32, hasFace: i32, mix: f32, hasMatte: i32,
  blinkX: i32, blinkY: i32, blinkWidth: i32, blinkHeight: i32, hasBlink: i32, barLeft: i32, barRight: i32, source: i32,
};
@group(0) @binding(3) var still: texture_2d<f32>;
@group(0) @binding(4) var frame: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(5) var<storage, read> sums: array<i32>;
@group(0) @binding(6) var<storage, read> rows: array<i32>;
@group(0) @binding(7) var<storage, read> weights: array<i32>;
@group(0) @binding(8) var blink: texture_2d<f32>;
@group(0) @binding(9) var<uniform> p: FrameParams;
@group(0) @binding(10) var<storage, read> matte: array<u32>;
${HOST(0)}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= p.width || y >= p.height) { return; }
  var pixel: vec3<f32>;
  if (p.source == 0) {
    pixel = hostRgb(x, y);
  } else {
    pixel = round(textureLoad(still, vec2<i32>(x, y), 0).rgb * 255.0);
  }
  if (x < p.barLeft || x >= p.width - p.barRight) {
    textureStore(frame, vec2<i32>(x, y), vec4<f32>(0.0, 0.0, 0.0, 1.0)); return;
  }
  let side = p.faceSide; let fx = x - p.faceX; let fy = y - p.faceY;
  let inFace = p.hasFace != 0 && fx >= 0 && fy >= 0 && fx < side && fy < side;
  var matted = 255u;
  if (inFace && p.hasMatte != 0) { matted = matte[fy * side + fx]; }
  if (inFace && matted != 0u) {
    let edge = min(min(fx + 1, side - fx), min(fy + 1, side - fy));
    var replace: bool; var alpha: f32;
    if (p.hasMatte != 0) { replace = matted == 255u && p.mix == 0.0; alpha = (f32(matted) / 255.0) * (1.0 - p.mix); }
    else { replace = edge >= 8 && p.mix == 0.0; alpha = min(1.0, f32(edge) * 0.125) * (1.0 - p.mix); }
    // BGR face square; pixel is RGB.
    for (var c = 0; c < 3; c++) {
      var high = 0; var low = 0;
      for (var k = 0; k < 8; k++) {
        let h = sums[(rows[fy * 8 + k] * side + fx) * 3 + c]; let w = weights[fy * 8 + k];
        high += (h >> 11u) * w; low += (h & 2047) * w;
      }
      let up = f32(clamp((high + ((low + (1 << 21u)) >> 11u)) >> 11u, 0, 255));
      let channel = 2 - c;
      if (replace) { pixel[channel] = up; continue; }
      pixel[channel] = clamp(round(alpha * up + (1.0 - alpha) * pixel[channel]), 0.0, 255.0);
    }
  }
  let bx = x - p.blinkX; let by = y - p.blinkY;
  if (p.hasBlink != 0 && bx >= 0 && by >= 0 && bx < p.blinkWidth && by < p.blinkHeight) {
    let inset = min(min(bx + 1, p.blinkWidth - bx), min(by + 1, p.blinkHeight - by));
    let source = round(textureLoad(blink, vec2<i32>(bx, by), 0).rgb * 255.0);
    if (inset >= 12) { pixel = source; }
    else {
      let weight = f32(inset) / 12.0;
      pixel = clamp(round(weight * source + (1.0 - weight) * pixel), vec3<f32>(0.0), vec3<f32>(255.0));
    }
  }
  textureStore(frame, vec2<i32>(x, y), vec4<f32>(pixel / 255.0, 1.0));
}
`;

const PRESENT = /* wgsl */ `
struct Mix { weight: f32, pad0: f32, pad1: f32, pad2: f32 };
@group(0) @binding(0) var texFrom: texture_2d<f32>;
@group(0) @binding(1) var texTo: texture_2d<f32>;
@group(0) @binding(2) var<uniform> m: Mix;
@group(0) @binding(3) var samp: sampler;
struct Out { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  var xy = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var out: Out; out.position = vec4<f32>(xy[i], 0.0, 1.0); out.uv = vec2<f32>((xy[i].x + 1.0) / 2.0, (1.0 - xy[i].y) / 2.0);
  return out;
}
@fragment fn fs(vin: Out) -> @location(0) vec4<f32> {
  let a = textureSampleLevel(texFrom, samp, vin.uv, 0.0);
  let b = textureSampleLevel(texTo, samp, vin.uv, 0.0);
  return vec4<f32>(mix(a.rgb, b.rgb, m.weight), 1.0);
}
`;

export interface FaceInput {
  /** The model's crop, BGR, output x output; empty in silence on a closed-lip lane. */
  crop: Uint8Array;
  x: number; y: number; side: number;
  mix: number;
}

export interface BlinkTexture { texture: GPUTexture; x: number; y: number; width: number; height: number }

export interface HostPlanes { y: GPUTexture; u: GPUTexture; v: GPUTexture; nv12: boolean }

/** WebGPU compositor of one pack's frames into `rgba8unorm` textures, and their presentation on a canvas. */
export class FrameCompositor {
  private readonly sharpenPipeline: GPUComputePipeline;
  private readonly horizontalPipeline: GPUComputePipeline;
  private readonly framePipelines = new Map<boolean, GPUComputePipeline>();
  private readonly cropPipelines = new Map<string, GPUComputePipeline>();
  private readonly cropTables = new Map<string, { index: GPUBuffer; weight: GPUBuffer; maxTaps: number; up: boolean }>();
  private readonly cropParams: GPUBuffer[];
  private hBuffer?: GPUBuffer;
  private faceBuffer?: GPUBuffer;
  private readonly presentPipeline?: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly cropBuffer: GPUBuffer;
  private readonly outerBuffer: GPUBuffer;
  private readonly regionBuffer: GPUBuffer;
  private readonly sharpenParams: GPUBuffer;
  private readonly hParams: GPUBuffer;
  private readonly frameParams: GPUBuffer;
  private readonly mixParams: GPUBuffer;
  private readonly sumsBuffer: GPUBuffer;
  private readonly empty: GPUBuffer;
  private readonly placeholder2D: GPUTexture;
  private readonly placeholderU32: GPUTexture;
  private readonly tables = new Map<number, { rows: GPUBuffer; offsets: GPUBuffer; weights: GPUBuffer }>();
  private readonly mattes = new Map<number, GPUBuffer>();
  readonly width: number;
  readonly height: number;

  constructor(
    private readonly device: GPUDevice,
    private readonly geometry: CropGeometry,
    size: { width: number; height: number },
    private readonly lipPicture: { sharpen: number; teeth: number; region?: Float32Array; mattes?: Map<number, Uint8Array> } | null,
    private readonly context?: GPUCanvasContext,
    presentFormat?: GPUTextureFormat,
  ) {
    this.width = size.width; this.height = size.height;
    const compute = (code: string) => device.createComputePipeline({
      layout: "auto", compute: { module: device.createShaderModule({ code }), entryPoint: "main" },
    });
    this.sharpenPipeline = compute(SHARPEN);
    this.horizontalPipeline = compute(HORIZONTAL);
    for (const nv12 of [false, true]) {
      const frame = device.createShaderModule({ code: FRAME }), crop = device.createShaderModule({ code: CROP });
      this.framePipelines.set(nv12, device.createComputePipeline({ layout: "auto", compute: { module: frame, entryPoint: "main", constants: { nv12: nv12 ? 1 : 0 } } }));
      for (const entry of ["area_h", "area_v", "up_h", "up_v"]) {
        this.cropPipelines.set(`${entry}:${nv12}`, device.createComputePipeline({ layout: "auto", compute: { module: crop, entryPoint: entry, constants: { nv12: nv12 ? 1 : 0 } } }));
      }
    }
    const buffer = (size: number, usage: number) => device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage });
    const g = geometry;
    this.cropBuffer = buffer(g.outputBytes * 4, GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST);
    this.outerBuffer = buffer(g.outerBytes * 4, GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST);
    this.regionBuffer = buffer(g.output * g.output * 4, GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST);
    if (lipPicture?.region) device.queue.writeBuffer(this.regionBuffer, 0, lipPicture.region as Float32Array<ArrayBuffer>);
    this.sharpenParams = buffer(48, GPU_USAGE.UNIFORM | GPU_USAGE.COPY_DST);
    this.hParams = buffer(16, GPU_USAGE.UNIFORM | GPU_USAGE.COPY_DST);
    this.frameParams = buffer(64, GPU_USAGE.UNIFORM | GPU_USAGE.COPY_DST);
    this.mixParams = buffer(16, GPU_USAGE.UNIFORM | GPU_USAGE.COPY_DST);
    this.cropParams = [0, 1].map(() => buffer(32, GPU_USAGE.UNIFORM | GPU_USAGE.COPY_DST));
    // Face sides reach ~1.3 x the outer crop's face size; size the sums for the largest side the frame allows.
    this.sumsBuffer = buffer(g.outer * Math.min(this.width, this.height) * 3 * 4, GPU_USAGE.STORAGE);
    this.empty = buffer(16, GPU_USAGE.STORAGE);
    this.placeholder2D = device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST });
    this.placeholderU32 = device.createTexture({ size: [1, 1], format: "r8uint", usage: TEXTURE_USAGE.TEXTURE_BINDING });
    this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    if (context && presentFormat) {
      const module = device.createShaderModule({ code: PRESENT });
      this.presentPipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: presentFormat }] },
        primitive: { topology: "triangle-list" },
      });
    }
  }

  /** A composed frame's texture. */
  createFrameTexture(): GPUTexture {
    return this.device.createTexture({
      size: [this.width, this.height], format: "rgba8unorm",
      usage: TEXTURE_USAGE.STORAGE_BINDING | TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_SRC,
    });
  }

  /** Textures for one host frame: Y full size; Cb and Cr half size (one two-channel texture for NV12). */
  createHostPlanes(nv12: boolean): HostPlanes {
    const plane = (w: number, h: number, format: GPUTextureFormat) =>
      this.device.createTexture({ size: [w, h], format, usage: TEXTURE_USAGE.TEXTURE_BINDING | TEXTURE_USAGE.COPY_DST });
    const cw = (this.width + 1) >> 1, ch = (this.height + 1) >> 1;
    return nv12
      ? { y: plane(this.width, this.height, "r8uint"), u: plane(cw, ch, "rg8uint"), v: this.placeholderU32, nv12 }
      : { y: plane(this.width, this.height, "r8uint"), u: plane(cw, ch, "r8uint"), v: plane(cw, ch, "r8uint"), nv12 };
  }

  uploadHost(planes: HostPlanes, frame: { y: Uint8Array; u: Uint8Array; v: Uint8Array; yStride: number; uvStride: number; interleaved?: boolean }): void {
    const cw = (this.width + 1) >> 1, ch = (this.height + 1) >> 1;
    const q = this.device.queue;
    if (planes.nv12 !== (frame.interleaved === true)) throw new Error("host frame layout changed");
    q.writeTexture({ texture: planes.y }, frame.y as Uint8Array<ArrayBuffer>, { bytesPerRow: frame.yStride }, [this.width, this.height]);
    q.writeTexture({ texture: planes.u }, frame.u as Uint8Array<ArrayBuffer>, { bytesPerRow: frame.uvStride }, [cw, ch]);
    if (!planes.nv12) q.writeTexture({ texture: planes.v }, frame.v as Uint8Array<ArrayBuffer>, { bytesPerRow: frame.uvStride }, [cw, ch]);
  }

  private cropTable(side: number, size: number) {
    const key = `${side}:${size}`;
    let table = this.cropTables.get(key);
    if (!table) {
      const make = (data: Int32Array | Float32Array) => {
        const b = this.device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST });
        this.device.queue.writeBuffer(b, 0, data as Int32Array<ArrayBuffer>);
        return b;
      };
      if (size > side) {
        // DerivedCrops.areaUpscale's taps.
        const inverse = size / side, scale = 1 / inverse, index = new Int32Array(size * 4);
        for (let d = 0; d < size; d += 1) {
          const cell = Math.min(side - 1, Math.floor(d * scale));
          let fraction = Math.fround((d + 1) - (cell + 1) * inverse);
          fraction = fraction <= 0 ? 0 : Math.fround(fraction - Math.floor(fraction));
          index.set([cell, Math.min(cell + 1, side - 1), roundHalfEven(Math.fround(Math.fround(1 - fraction) * 2048)),
            roundHalfEven(Math.fround(fraction * 2048))], d * 4);
        }
        table = { index: make(index), weight: make(new Float32Array(4)), maxTaps: 4, up: true };
      } else {
        const taps = areaTable(side, size), maxTaps = Math.max(...taps.map((t) => t.length));
        const index = new Int32Array(size * maxTaps).fill(-1), weight = new Float32Array(size * maxTaps);
        taps.forEach((list, d) => list.forEach(([source, w], k) => { index[d * maxTaps + k] = source; weight[d * maxTaps + k] = w; }));
        table = { index: make(index), weight: make(weight), maxTaps, up: false };
      }
      this.cropTables.set(key, table);
    }
    return table;
  }

  /** Encodes the face box (`x0`, `y0`, `side`) of `planes` area-resized to `size` into `dst` (BGR, a u32 a byte). */
  private encodeCrop(encoder: GPUCommandEncoder, planes: HostPlanes, x0: number, y0: number, side: number, size: number, dst: GPUBuffer, slot: number): void {
    const device = this.device, table = this.cropTable(side, size);
    const needed = side * size * 3 * 4;
    if (!this.hBuffer || this.hBuffer.size < needed) { this.hBuffer?.destroy(); this.hBuffer = device.createBuffer({ size: needed, usage: GPU_USAGE.STORAGE }); }
    device.queue.writeBuffer(this.cropParams[slot], 0, new Int32Array([x0, y0, side, size, table.maxTaps, 0, 0, 0]));
    for (const [entry, rows] of table.up ? [["up_h", side], ["up_v", size]] as const : [["area_h", side], ["area_v", size]] as const) {
      const pipeline = this.cropPipelines.get(`${entry}:${planes.nv12}`)!;
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: planes.y.createView() }, { binding: 1, resource: planes.u.createView() },
        { binding: 2, resource: planes.v.createView() }, { binding: 3, resource: { buffer: this.cropParams[slot] } },
        { binding: 4, resource: { buffer: table.index } }, { binding: 5, resource: { buffer: table.weight } },
        { binding: 6, resource: { buffer: this.hBuffer } }, { binding: 7, resource: { buffer: dst } },
      ] }));
      pass.dispatchWorkgroups(Math.ceil(size / 16), Math.ceil(rows / 16));
      pass.end();
    }
  }

  /** The face box area-resized to `size` (BGR bytes), read back: the renderer's crops, derived once at load. */
  async deriveCrop(planes: HostPlanes, x0: number, y0: number, side: number, size: number): Promise<Uint8Array> {
    const bytes = size * size * 3 * 4;
    if (!this.faceBuffer || this.faceBuffer.size < bytes) {
      this.faceBuffer?.destroy();
      this.faceBuffer = this.device.createBuffer({ size: bytes, usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_SRC });
    }
    const read = this.device.createBuffer({ size: bytes, usage: GPU_USAGE.COPY_DST | GPU_USAGE.MAP_READ });
    const encoder = this.device.createCommandEncoder();
    this.encodeCrop(encoder, planes, x0, y0, side, size, this.faceBuffer, 1);
    encoder.copyBufferToBuffer(this.faceBuffer, 0, read, 0, bytes);
    this.device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPU_USAGE.MAP_READ);
    const out = Uint8Array.from(new Uint32Array(read.getMappedRange()));
    read.unmap(); read.destroy();
    return out;
  }

  private table(side: number) {
    let table = this.tables.get(side);
    if (!table) {
      const taps = lanczosTaps(this.geometry.outer, side);
      const make = (data: Int32Array) => {
        const b = this.device.createBuffer({ size: data.byteLength, usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST });
        this.device.queue.writeBuffer(b, 0, data as Int32Array<ArrayBuffer>);
        return b;
      };
      table = { rows: make(taps.indices), offsets: make(taps.indices), weights: make(taps.weights) };
      this.tables.set(side, table);
    }
    return table;
  }

  private matte(side: number): GPUBuffer | undefined {
    const bytes = this.lipPicture?.mattes?.get(side);
    if (!bytes) return undefined;
    let buffer = this.mattes.get(side);
    if (!buffer) {
      buffer = this.device.createBuffer({ size: bytes.length * 4, usage: GPU_USAGE.STORAGE | GPU_USAGE.COPY_DST });
      this.device.queue.writeBuffer(buffer, 0, Uint32Array.from(bytes));
      this.mattes.set(side, buffer);
    }
    return buffer;
  }

  /**
   * Composes one frame into `target`: the host (`planes`, or the still face texture), the face square, the blink and
   * the bars.
   */
  compose(target: GPUTexture, host: { planes?: HostPlanes; still?: GPUTexture }, face: FaceInput | undefined,
    blink: BlinkTexture | undefined, bars: [number, number]): void {
    const device = this.device, g = this.geometry;
    const encoder = device.createCommandEncoder();
    const nv12 = host.planes?.nv12 ?? false;
    let table = { rows: this.empty, offsets: this.empty, weights: this.empty };
    let matte = this.empty, hasMatte = 0;
    const hasFace = face !== undefined && face.mix < 1;
    if (face && hasFace) {
      table = this.table(face.side);
      if (!host.planes) throw new Error("a face square needs the host frame");
      // The host's outer crop, derived from the frame on the GPU (iOS derives it once per host on the CPU, same values).
      this.encodeCrop(encoder, host.planes, face.x, face.y, face.side, g.outer, this.outerBuffer, 0);
      const paste = g.paste;
      if (face.crop.length) {
        device.queue.writeBuffer(this.cropBuffer, 0, Uint32Array.from(face.crop));
        const sharpen = this.lipPicture && (this.lipPicture.sharpen !== 0 || this.lipPicture.teeth !== 0) ? 1 : 0;
        const params = new ArrayBuffer(48), ints = new Int32Array(params), floats = new Float32Array(params);
        ints.set([g.output, g.outer, g.margin, paste.x, paste.y, paste.width, paste.height]);
        floats[7] = this.lipPicture?.sharpen ?? 0; floats[8] = this.lipPicture?.teeth ?? 0; ints[9] = sharpen;
        device.queue.writeBuffer(this.sharpenParams, 0, params);
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.sharpenPipeline);
        pass.setBindGroup(0, device.createBindGroup({ layout: this.sharpenPipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: { buffer: this.cropBuffer } }, { binding: 1, resource: { buffer: this.outerBuffer } },
          { binding: 2, resource: { buffer: this.sharpenParams } }, { binding: 3, resource: { buffer: this.regionBuffer } },
        ] }));
        pass.dispatchWorkgroups(Math.ceil(paste.width / 16), Math.ceil(paste.height / 16));
        pass.end();
      }
      device.queue.writeBuffer(this.hParams, 0, new Int32Array([face.side, g.outer, 0, 0]));
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.horizontalPipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: this.horizontalPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.outerBuffer } }, { binding: 1, resource: { buffer: table.offsets } },
        { binding: 2, resource: { buffer: table.weights } }, { binding: 3, resource: { buffer: this.sumsBuffer } },
        { binding: 4, resource: { buffer: this.hParams } },
      ] }));
      pass.dispatchWorkgroups(Math.ceil(face.side / 16), Math.ceil(g.outer / 16));
      pass.end();
      const m = this.matte(face.side);
      if (m) { matte = m; hasMatte = 1; }
    }
    const params = new ArrayBuffer(64), ints = new Int32Array(params), floats = new Float32Array(params);
    ints.set([this.width, this.height, face?.x ?? 0, face?.y ?? 0, face?.side ?? 0, hasFace ? 1 : 0]);
    floats[6] = face ? Math.min(Math.max(face.mix, 0), 1) : 0; ints[7] = hasMatte;
    ints.set([blink?.x ?? 0, blink?.y ?? 0, blink?.width ?? 0, blink?.height ?? 0, blink ? 1 : 0, bars[0], bars[1], host.planes ? 0 : 1], 8);
    device.queue.writeBuffer(this.frameParams, 0, params);
    const pass = encoder.beginComputePass();
    const framePipeline = this.framePipelines.get(nv12)!;
    pass.setPipeline(framePipeline);
    const planes = host.planes;
    pass.setBindGroup(0, device.createBindGroup({ layout: framePipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: (planes?.y ?? this.placeholderU32).createView() },
      { binding: 1, resource: (planes?.u ?? this.placeholderU32).createView() },
      { binding: 2, resource: (planes?.v ?? this.placeholderU32).createView() },
      { binding: 3, resource: (host.still ?? this.placeholder2D).createView() },
      { binding: 4, resource: target.createView() },
      { binding: 5, resource: { buffer: hasFace ? this.sumsBuffer : this.empty } },
      { binding: 6, resource: { buffer: table.rows } }, { binding: 7, resource: { buffer: table.weights } },
      { binding: 8, resource: (blink?.texture ?? this.placeholder2D).createView() },
      { binding: 9, resource: { buffer: this.frameParams } }, { binding: 10, resource: { buffer: matte } },
    ] }));
    pass.dispatchWorkgroups(Math.ceil(this.width / 16), Math.ceil(this.height / 16));
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /** Draws `to` over `from` with `weight` (1: `to` alone) on the canvas. */
  present(from: GPUTexture, to: GPUTexture, weight: number): void {
    if (!this.context || !this.presentPipeline) return;
    const device = this.device;
    device.queue.writeBuffer(this.mixParams, 0, new Float32Array([Math.min(1, Math.max(0, weight)), 0, 0, 0]));
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{
      view: this.context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }] });
    pass.setPipeline(this.presentPipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: this.presentPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: from.createView() }, { binding: 1, resource: to.createView() },
      { binding: 2, resource: { buffer: this.mixParams } }, { binding: 3, resource: this.sampler },
    ] }));
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  /** Reads a composed frame back as RGBA bytes (diagnostics and parity). */
  async read(texture: GPUTexture, region?: { x: number; y: number; width: number; height: number }): Promise<Uint8Array> {
    const r = region ?? { x: 0, y: 0, width: this.width, height: this.height };
    const bytesPerRow = Math.ceil(r.width * 4 / 256) * 256;
    const buffer = this.device.createBuffer({ size: bytesPerRow * r.height, usage: GPU_USAGE.COPY_DST | GPU_USAGE.MAP_READ });
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture, origin: [r.x, r.y] }, { buffer, bytesPerRow }, [r.width, r.height]);
    this.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPU_USAGE.MAP_READ);
    const mapped = new Uint8Array(buffer.getMappedRange());
    const out = new Uint8Array(r.width * r.height * 4);
    for (let y = 0; y < r.height; y += 1) out.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + r.width * 4), y * r.width * 4);
    buffer.unmap(); buffer.destroy();
    return out;
  }
}
