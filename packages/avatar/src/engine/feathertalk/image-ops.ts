// The pixel operations of the iOS runtime that the web runtime reproduces on the CPU: the host video's YCbCr to RGB as
// VideoToolbox gives it, the renderer's crops (DerivedCrops: OpenCV INTER_AREA down and up), the compositor's Lanczos taps
// (AvatarCompositor.LanczosTaps), white side bars, and LipPicture's mouth matte and teeth region.
import type { MouthRegion } from "./pack";

const f32 = Math.fround;

/** Banker's rounding (Swift `.toNearestOrEven`). */
export function roundHalfEven(value: number): number {
  const floor = Math.floor(value), diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * YCbCr (8-bit, video range, the hosts' smpte170m tag) to RGB as VideoToolbox's 32BGRA output of these clips gives it,
 * fitted on the iOS decode of three host frames (exact on 91.5% of channel values, never more than 2 levels off): rows
 * R, G, B over (Y, Cb, Cr, 1); chroma co-sited with the even column and the even row, linear between them.
 */
export const VT_601_RGB: readonly number[][] = [
  [1.165439, -0.004124, 1.57445, -219.925007],
  [1.16252, -0.38975, -0.79723, 133.58311],
  [1.166452, 2.016199, -0.006857, -276.328849],
];

export interface YuvPlanes {
  width: number; height: number;
  y: Uint8Array; u: Uint8Array; v: Uint8Array;
  /** Bytes per row of each plane. */
  yStride: number; uvStride: number;
  /** NV12: `u` holds Cb and Cr interleaved (`v` unused). */
  interleaved?: boolean;
}

/**
 * The chroma value at full-resolution (x, y), upsampled as VideoToolbox does for these clips. `step` 2 and `offset` 0 or
 * 1 read Cb or Cr from an interleaved (NV12) plane.
 */
function chromaAt(plane: Uint8Array, stride: number, cw: number, ch: number, x: number, y: number, step = 1, offset = 0): number {
  const cx = x >> 1, cy = y >> 1;
  const row = (r: number) => {
    const at = r * stride + offset;
    if ((x & 1) === 0) return plane[at + cx * step];
    return (plane[at + cx * step] + plane[at + Math.min(cx + 1, cw - 1) * step]) / 2;
  };
  if ((y & 1) === 0) return row(cy);
  return (row(cy) + row(Math.min(cy + 1, ch - 1))) / 2;
}

/** RGB (unrounded) of frame pixel (x, y). */
export function pixelRgb(frame: YuvPlanes, x: number, y: number, out: Float64Array): void {
  const cw = (frame.width + 1) >> 1, ch = (frame.height + 1) >> 1;
  const yv = frame.y[y * frame.yStride + x];
  if (frame.interleaved) {
    yuvToRgb(yv, chromaAt(frame.u, frame.uvStride, cw, ch, x, y, 2, 0), chromaAt(frame.u, frame.uvStride, cw, ch, x, y, 2, 1), out);
  } else {
    yuvToRgb(yv, chromaAt(frame.u, frame.uvStride, cw, ch, x, y), chromaAt(frame.v, frame.uvStride, cw, ch, x, y), out);
  }
}

export function yuvToRgb(yv: number, u: number, v: number, out: Float64Array): void {
  for (let c = 0; c < 3; c += 1) {
    const m = VT_601_RGB[c];
    out[c] = m[0] * yv + m[1] * u + m[2] * v + m[3];
  }
}

/** The square box [x0, y0, x0 + side) of a frame as packed BGR bytes. */
export function boxBGR(frame: YuvPlanes, x0: number, y0: number, side: number): Uint8Array {
  const out = new Uint8Array(side * side * 3);
  const rgb = new Float64Array(3);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      pixelRgb(frame, x0 + x, y0 + y, rgb);
      const o = (y * side + x) * 3;
      out[o] = clampByte(roundHalfEven(rgb[2])); out[o + 1] = clampByte(roundHalfEven(rgb[1])); out[o + 2] = clampByte(roundHalfEven(rgb[0]));
    }
  }
  return out;
}

function clampByte(value: number): number { return value < 0 ? 0 : value > 255 ? 255 : value; }

/** White side bars (columns from each side, at most 40, whose mean channel is above 240). */
/** White side bars (columns from each side, at most 40, whose mean channel is above 240). */
export function whiteBars(frame: YuvPlanes): [number, number] {
  const width = frame.width, height = frame.height, scan = Math.min(40, width);
  const rgb = new Float64Array(3);
  const white = (x: number) => {
    let sum = 0;
    for (let y = 0; y < height; y += 1) {
      pixelRgb(frame, x, y, rgb);
      for (let c = 0; c < 3; c += 1) sum += clampByte(roundHalfEven(rgb[c]));
    }
    return sum / (height * 3) > 240;
  };
  let left = 0, right = 0;
  while (left < scan && white(left)) left += 1;
  while (right < scan && white(width - 1 - right)) right += 1;
  return [left, right];
}

/** One axis of OpenCV's INTER_AREA table (DerivedCrops.areaTable). */
export function areaTable(source: number, destination: number): [number, number][][] {
  const scale = source / destination;
  return Array.from({ length: destination }, (_, d) => {
    const from = d * scale, to = from + scale;
    const first = Math.ceil(from), last = Math.floor(to);
    const cell = Math.min(scale, source - from);
    const taps: [number, number][] = [];
    if (first - from > 1e-3 && first - 1 >= 0) taps.push([first - 1, f32((first - from) / cell)]);
    for (let s = first; s < Math.min(last, source); s += 1) taps.push([s, f32(1 / cell)]);
    if (to - last > 1e-3 && last < source) taps.push([last, f32(Math.min(Math.min(to - last, 1), cell) / cell)]);
    return taps;
  });
}

/** cv2.resize INTER_AREA of a packed square BGR image (DerivedCrops.areaResize, upscale included). */
export function areaResize(pixels: Uint8Array, side: number, size: number): Uint8Array {
  if (size > side) return areaUpscale(pixels, side, size);
  const table = areaTable(side, size);
  const horizontal = new Float32Array(side * size * 3);
  for (let x = 0; x < size; x += 1) {
    for (const [s, w] of table[x]) {
      for (let y = 0; y < side; y += 1) {
        const src = (y * side + s) * 3, dst = (y * size + x) * 3;
        for (let c = 0; c < 3; c += 1) horizontal[dst + c] = f32(f32(pixels[src + c] * w) + horizontal[dst + c]);
      }
    }
  }
  const result = new Float32Array(size * size * 3);
  const row = size * 3;
  for (let y = 0; y < size; y += 1) {
    for (const [s, w] of table[y]) {
      const src = s * row, dst = y * row;
      for (let i = 0; i < row; i += 1) result[dst + i] = f32(f32(horizontal[src + i] * w) + result[dst + i]);
    }
  }
  const out = new Uint8Array(result.length);
  for (let i = 0; i < result.length; i += 1) {
    const v = f32(result[i] + 0.5);
    out[i] = v <= 0 ? 0 : v >= 255 ? 255 : Math.trunc(v);
  }
  return out;
}

/** cv2.resize INTER_AREA to a larger size, as OpenCV's integer kernel computes it (DerivedCrops.areaUpscale). */
export function areaUpscale(pixels: Uint8Array, side: number, size: number): Uint8Array {
  const inverse = size / side, scale = 1 / inverse;
  const taps = Array.from({ length: size }, (_, d) => {
    const cell = Math.min(side - 1, Math.floor(d * scale));
    let fraction = f32((d + 1) - (cell + 1) * inverse);
    fraction = fraction <= 0 ? 0 : f32(fraction - Math.floor(fraction));
    return { cell, next: Math.min(cell + 1, side - 1), w0: roundHalfEven(f32(f32(1 - fraction) * 2048)), w1: roundHalfEven(f32(fraction * 2048)) };
  });
  const rowWidth = size * 3;
  const shifted = new Float64Array(side * rowWidth);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const t = taps[x];
      for (let c = 0; c < 3; c += 1) {
        const h = pixels[(y * side + t.cell) * 3 + c] * t.w0 + pixels[(y * side + t.next) * 3 + c] * t.w1;
        shifted[y * rowWidth + x * 3 + c] = Math.floor(h / 16);
      }
    }
  }
  const out = new Uint8Array(size * rowWidth);
  for (let y = 0; y < size; y += 1) {
    const t = taps[y], a = t.cell * rowWidth, b = t.next * rowWidth, s0 = t.w0 / 65536, s1 = t.w1 / 65536;
    for (let i = 0; i < rowWidth; i += 1) {
      const sum = Math.floor(shifted[a + i] * s0) + Math.floor(shifted[b + i] * s1);
      const v = Math.floor((sum + 2) / 4);
      out[y * rowWidth + i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return out;
}

/** The renderer's inner crop and the compositor's outer crop of one face box (tools/face_utils.py, DerivedCrops.derive). */
export function deriveCrops(box: Uint8Array, side: number, inner: number, face: number, outer: number): { inner: Uint8Array; outer: Uint8Array } {
  const outerCrop = areaResize(box, side, outer);
  const faceCrop = areaResize(box, side, face);
  const border = (face - inner) / 2;
  const innerCrop = new Uint8Array(inner * inner * 3);
  for (let row = 0; row < inner; row += 1) {
    const from = ((row + border) * face + border) * 3;
    innerCrop.set(faceCrop.subarray(from, from + inner * 3), row * inner * 3);
  }
  return { inner: innerCrop, outer: outerCrop };
}

/** Lanczos-4 taps, 11-bit (AvatarCompositor.LanczosTaps): per target pixel 8 source indices and weights. */
export function lanczosTaps(sourceSide: number, targetSide: number): { indices: Int32Array; weights: Int32Array } {
  const indices = new Int32Array(targetSide * 8), weights = new Int32Array(targetSide * 8);
  for (let d = 0; d < targetSide; d += 1) {
    const coordinate = f32((d + 0.5) * sourceSide / targetSide - 0.5);
    const center = Math.floor(coordinate), fraction = f32(coordinate - center);
    let row = Array.from({ length: 8 }, (_, i) => {
      const x = fraction - (i - 3);
      if (Math.abs(x) < 1e-12) return 1;
      if (Math.abs(x) >= 4) return 0;
      return Math.sin(Math.PI * x) * Math.sin(Math.PI * x / 4) / (Math.PI * Math.PI * x * x / 4);
    });
    const sum = row.reduce((a, b) => a + b, 0);
    row = row.map((v) => v / sum);
    for (let i = 0; i < 8; i += 1) {
      indices[d * 8 + i] = Math.min(sourceSide - 1, Math.max(0, center + i - 3));
      weights[d * 8 + i] = roundHalfEven(row[i] * 2048);
    }
  }
  return { indices, weights };
}

/** LipPicture.MouthRegion.weight at crop pixel (x, y) of a crop `side` wide. */
export function mouthWeight(region: MouthRegion, x: number, y: number, side: number): number {
  const angle = region.rotationDegrees * Math.PI / 180, dx = x - region.centerX * side, dy = y - region.centerY * side;
  const along = dx * Math.cos(angle) + dy * Math.sin(angle), across = -dx * Math.sin(angle) + dy * Math.cos(angle);
  const rx = region.radiusX * side, ry = region.radiusY * side;
  const r = Math.sqrt((along / rx) * (along / rx) + (across / ry) * (across / ry));
  return Math.min(1, Math.max(0, 1 - (r - 1) * Math.min(rx, ry) / (region.softness * side)));
}

/** LipPicture.teethRegion: the region's weight at each pixel centre of the output crop. */
export function teethRegion(region: MouthRegion | null, side: number): Float32Array {
  const weights = new Float32Array(side * side);
  if (!region) return weights.fill(1);
  for (let y = 0; y < side; y += 1) for (let x = 0; x < side; x += 1) weights[y * side + x] = mouthWeight(region, x + 0.5, y + 0.5, side);
  return weights;
}

/** LipPicture.matte: the mouth region laid on the outer crop, bilinearly resized to the face side, times the 8 px feather. */
export function mouthMatte(region: MouthRegion, geometry: { outer: number; output: number; margin: number;
  paste: { x: number; y: number; width: number; height: number } }, side: number): Uint8Array {
  const outer = geometry.outer, margin = geometry.margin, paste = geometry.paste, output = geometry.output;
  const laid = new Float64Array(outer * outer);
  for (let y = paste.y; y < paste.y + paste.height; y += 1) {
    for (let x = paste.x; x < paste.x + paste.width; x += 1) laid[(y + margin) * outer + x + margin] = mouthWeight(region, x, y, output);
  }
  const bytes = new Uint8Array(side * side);
  const scale = outer / side;
  const sample = (d: number): [number, number, number] => {
    const s = Math.min(Math.max((d + 0.5) * scale - 0.5, 0), outer - 1);
    const low = Math.floor(s);
    return [low, Math.min(low + 1, outer - 1), s - low];
  };
  for (let y = 0; y < side; y += 1) {
    const [y0, y1, fy] = sample(y);
    for (let x = 0; x < side; x += 1) {
      const [x0, x1, fx] = sample(x);
      const top = laid[y0 * outer + x0] * (1 - fx) + laid[y0 * outer + x1] * fx;
      const bottom = laid[y1 * outer + x0] * (1 - fx) + laid[y1 * outer + x1] * fx;
      const edge = Math.min(x + 1, side - x, y + 1, side - y);
      const alpha = (top * (1 - fy) + bottom * fy) * Math.min(1, edge / 8);
      bytes[y * side + x] = Math.max(0, Math.min(255, Math.round(alpha * 255)));
    }
  }
  return bytes;
}
