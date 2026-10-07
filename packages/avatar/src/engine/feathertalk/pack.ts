// The FeatherTalk web pack (packages/avatar/FORMAT.md): its descriptor, checked at load as the iOS runtime checks a pack
// (AvatarPack, CropGeometry, LipWindows, CalmHostWindow.fits).

export interface Rect { x: number; y: number; width: number; height: number }

export interface HostVideo {
  file: string;
  codec: string;
  /** Base64 hvcC / avcC. */
  description: string;
  keyframeInterval: number;
  /** Per host frame, in display order: byte offset and size of its sample in `file`. */
  frames: [number, number][];
}

export interface CalmWindowJSON {
  first: number; count: number; framesPerHost: number;
  twins?: number[][]; blinkHosts?: number[][]; closedEyes?: number[] | number[][];
  lanes?: number[][]; closedLipLanes?: number[][]; itinerary?: number[][]; stays?: number[]; openLipStays?: number[];
  speechLanes?: number[][]; speechItinerary?: number[][]; speechStays?: number[];
  entries?: Record<string, number>; exits?: Record<string, number>; pathStart?: number; pathStartRising?: boolean;
}

export interface MouthRegion {
  centerX: number; centerY: number; radiusX: number; radiusY: number; rotationDegrees: number; softness: number;
}

export interface LipPictureSettings { sharpen: number; teeth: number; mouth: MouthRegion | null }

export interface FeatherTalkPack {
  format: "feathertalk-web";
  schema: 1;
  id: string;
  name: string;
  identity: string;
  audio: {
    sampleRate: number; fps: number; samplesPerFrame: number; encoderTailSamples: number;
    waveformMean: number; waveformStd: number; encoderWindowFrames: number[];
  };
  windows: { lookahead: number; left: number; right: number; bootstrap: number };
  geometry: { inner: number; output: number; outer: number; hole: Rect; featherPixels: number; channelOrder: "BGR" };
  models: {
    encoder: { file: string; input: string; output: string; batch?: boolean };
    renderer: { file: string; image: string; audio: string; output: string; precision: "fp16" | "fp32" };
    closedAudio: string;
  };
  hosts: {
    width: number; height: number; count: number;
    boxes: [number, number, number, number][];
    colour: { matrix: string; primaries: string; transfer: string; range: string };
    videos: HostVideo[];
  };
  calmWindow: CalmWindowJSON;
  still: { base: string; host: number; rect: [number, number, number, number]; sequence: number[]; blinks: string[] };
  face: { voice: string | null; lipLeadMilliseconds: number; articulationGain: number };
  instantLips: { lookaheadFrames: number; batchFrames: number; standIn: "mirror" | "silence"; voiceDelayMilliseconds: number };
  lipPicture: LipPictureSettings | null;
  files: Record<string, { bytes: number; sha256: string }>;
}

export class PackError extends Error {
  constructor(message: string) { super(`FeatherTalk pack rejected: ${message}`); this.name = "PackError"; }
}

/** LipWindows: the lip model's audio windows. */
export class LipWindows {
  static readonly h08 = new LipWindows(9, 16, 4, 8);
  constructor(readonly lookahead: number, readonly left: number, readonly right: number, readonly bootstrap: number) {}

  static from(values: { lookahead: number; left: number; right: number; bootstrap: number }): LipWindows | undefined {
    const { lookahead, left, right, bootstrap } = values;
    if (!(lookahead >= 0 && lookahead <= 9 && right >= 0 && right <= 4)) return undefined;
    if (bootstrap === 8) {
      if (lookahead !== 9 || left !== 16 || right !== 4) return undefined;
    } else if (!(bootstrap === 0 && left >= 16 && left + 1 + right === 21)) return undefined;
    return new LipWindows(lookahead, left, right, bootstrap);
  }

  /** Features before frame m in the renderer's window. */
  get past(): number { return 19 - this.lookahead; }
  get fullLookaheadFrames(): number { return this.lookahead + this.right; }
  get padsBeforeStart(): boolean { return this.bootstrap === 0; }

  /** The encode yielding feature `f`: audio frames [low, high) plus 80 samples, features first..<last. */
  encode(f: number): { low: number; high: number; first: number; last: number } {
    if (this.bootstrap > 0 && f === 0) return { low: 0, high: this.bootstrap, first: 0, last: this.bootstrap };
    return { low: this.padsBeforeStart ? f - this.left : Math.max(0, f - this.left), high: f + 1 + this.right, first: f, last: f + 1 };
  }

  /** Samples of audio frames [low, high) plus 80 from `samples` (sample `base` first); zeros before the segment start. */
  static window(samples: Float32Array, base: number, low: number, high: number): Float32Array {
    const start = low * 640, end = high * 640 + 80;
    if (start >= 0) return samples.slice(start - base, end - base);
    if (base !== 0) throw new Error("a window before the segment's start with its first samples dropped");
    const out = new Float32Array(end - start);
    out.set(samples.subarray(0, end), -start);
    return out;
  }
}

/** CropGeometry. */
export class CropGeometry {
  constructor(readonly inner: number, readonly output: number, readonly outer: number, readonly hole: Rect) {}
  static from(g: FeatherTalkPack["geometry"]): CropGeometry | undefined {
    const { inner, output, outer, hole } = g;
    if (!(inner >= 16 && inner <= 1024 && output >= inner && output % inner === 0 && outer <= 4096 && outer % (output / inner) === 0)) return undefined;
    const face = outer / (output / inner);
    if (!(face >= inner && (face - inner) % 2 === 0 && hole.x >= 0 && hole.y >= 0 && hole.width > 0 && hole.height > 0
      && hole.x + hole.width <= inner && hole.y + hole.height <= inner)) return undefined;
    if (g.featherPixels !== 8 || g.channelOrder !== "BGR") return undefined;
    return new CropGeometry(inner, output, outer, hole);
  }
  get scale(): number { return this.output / this.inner; }
  get face(): number { return this.outer / this.scale; }
  get margin(): number { return (this.outer - this.output) / 2; }
  get paste(): Rect {
    const s = this.scale, h = this.hole;
    return { x: h.x * s, y: h.y * s, width: h.width * s, height: h.height * s };
  }
  get innerBytes(): number { return this.inner * this.inner * 3; }
  get outerBytes(): number { return this.outer * this.outer * 3; }
  get outputBytes(): number { return this.output * this.output * 3; }
}

type Range = [number, number];
export interface Crossing { from: number; to: number }

/** AvatarPack.CalmHostWindow. */
export class CalmHostWindow {
  readonly first: number; readonly count: number; readonly framesPerHost: number;
  readonly twins: Range[]; readonly blinkHosts: Range[]; readonly closedEyeRanges: Range[];
  readonly lanes: Range[]; readonly closedLipLanes: Range[];
  readonly itinerary: Crossing[]; readonly stays: number[]; readonly openLipStays: number[];
  readonly speechLanes: Range[]; readonly speechItinerary: Crossing[]; readonly speechStays: number[];
  readonly entries: Map<number, number>; readonly exits: Map<number, number>;
  readonly pathStart: number; readonly pathStartRising: boolean;

  constructor(json: CalmWindowJSON) {
    const ranges = (values: number[][] | undefined, what: string): Range[] => {
      if (!values) return [];
      if (!values.every((v) => Array.isArray(v) && v.length === 2 && v[0] <= v[1])) throw new PackError(`calm window ${what}`);
      return values.map((v) => [v[0], v[1]] as Range);
    };
    const crossings = (values: number[][] | undefined, what: string): Crossing[] => {
      if (!values) return [];
      if (!values.every((v) => Array.isArray(v) && v.length === 2)) throw new PackError(`calm window ${what}`);
      return values.map((v) => ({ from: v[0], to: v[1] }));
    };
    const hosts = (values: Record<string, number> | undefined): Map<number, number> => {
      const map = new Map<number, number>();
      for (const [key, value] of Object.entries(values ?? {})) {
        const host = Number(key);
        if (!Number.isInteger(host) || !Number.isInteger(value)) throw new PackError("calm window entries/exits");
        map.set(host, value);
      }
      return map;
    };
    if (![json.first, json.count, json.framesPerHost].every(Number.isInteger)) throw new PackError("calm window");
    this.first = json.first; this.count = json.count; this.framesPerHost = Math.max(1, json.framesPerHost);
    this.twins = ranges(json.twins, "twins"); this.blinkHosts = ranges(json.blinkHosts, "blinkHosts");
    const eyes = json.closedEyes;
    this.closedEyeRanges = eyes === undefined ? [] : typeof eyes[0] === "number" ? ranges([eyes as number[]], "closedEyes")
      : ranges(eyes as number[][], "closedEyes");
    this.lanes = ranges(json.lanes, "lanes");
    this.closedLipLanes = json.closedLipLanes ? ranges(json.closedLipLanes, "closedLipLanes") : this.lanes;
    this.itinerary = crossings(json.itinerary, "itinerary"); this.stays = json.stays ?? [];
    this.openLipStays = json.openLipStays ?? this.stays;
    this.speechLanes = ranges(json.speechLanes, "speechLanes");
    this.speechItinerary = crossings(json.speechItinerary, "speechItinerary"); this.speechStays = json.speechStays ?? [];
    this.entries = hosts(json.entries); this.exits = hosts(json.exits);
    this.pathStart = json.pathStart ?? json.first; this.pathStartRising = json.pathStartRising ?? true;
  }

  get calmLast(): number { return this.first + this.count - 1; }
  isHome(host: number): boolean { return (host >= this.first && host <= this.calmLast) || this.twins.some((r) => within(r, host)); }
  closedEyes(host: number): Range | undefined { return this.closedEyeRanges.find((r) => within(r, host)); }
  isBlinkable(host: number): boolean { return this.blinkHosts.some((r) => within(r, host)); }
  get hasPath(): boolean { return this.lanes.length > 0 && this.itinerary.length > 0 && this.stays.length > 0; }
  isCalm(host: number): boolean { return this.lanes.some((r) => within(r, host)); }
  isClosedLips(host: number): boolean { return this.closedLipLanes.some((r) => within(r, host)); }
  isSpeech(host: number): boolean { return this.speechLanes.some((r) => within(r, host)); }

  fits(hostCount: number): boolean {
    const all = [...this.lanes, ...this.speechLanes];
    const inLanes = (host: number) => all.some((r) => within(r, host));
    const inside = (r: Range) => r[0] >= 0 && r[1] < hostCount;
    return this.count >= 1 && this.first >= 0 && this.calmLast < hostCount
      && this.twins.every(inside) && this.closedEyeRanges.every(inside) && all.every(inside)
      && this.closedLipLanes.every((lane) => this.lanes.some((r) => within(r, lane[0]) && within(r, lane[1])))
      && this.itinerary.every((c) => this.isCalm(c.from) && this.isCalm(c.to))
      && this.speechItinerary.every((c) => this.isSpeech(c.from) && this.isSpeech(c.to))
      && [...this.entries].every(([from, to]) => this.isCalm(from) && this.isSpeech(to))
      && [...this.exits].every(([from, to]) => this.isSpeech(from) && this.isClosedLips(to))
      && inLanes(this.pathStart);
  }
}

export function within(range: Range, value: number): boolean { return value >= range[0] && value <= range[1]; }

const WINDOW_FRAMES = [8, 13, 14, 15, 16, 17, 18, 19, 20, 21];

/** The checked pack: its windows, geometry and head path. Throws PackError on anything iOS would refuse. */
export interface CheckedPack {
  pack: FeatherTalkPack;
  windows: LipWindows;
  geometry: CropGeometry;
  calm: CalmHostWindow;
}

export function checkPack(value: unknown): CheckedPack {
  const pack = value as FeatherTalkPack;
  if (!pack || pack.format !== "feathertalk-web") throw new PackError("not a feathertalk-web pack");
  if (pack.schema !== 1) throw new PackError(`schema ${String(pack.schema)} is not supported`);
  const a = pack.audio;
  if (!(a && a.sampleRate === 16000 && a.fps === 25 && a.samplesPerFrame === 640 && a.encoderTailSamples === 80
    && Number.isFinite(a.waveformMean) && Number.isFinite(a.waveformStd) && a.waveformStd > 1e-6
    && JSON.stringify(a.encoderWindowFrames) === JSON.stringify(WINDOW_FRAMES))) throw new PackError("audio contract");
  const windows = pack.windows && LipWindows.from(pack.windows);
  if (!windows) throw new PackError("lip windows");
  const geometry = pack.geometry && CropGeometry.from(pack.geometry);
  if (!geometry) throw new PackError("crop geometry");
  const h = pack.hosts;
  if (!(h && h.count >= 2 && h.count <= 5250 && h.boxes?.length === h.count && h.width > 0 && h.height > 0
    && h.width <= 4096 && h.height <= 4096)) throw new PackError("hosts");
  for (const [x0, y0, x1, y1] of h.boxes) {
    if (!(x0 >= 0 && y0 >= 0 && x1 <= h.width && y1 <= h.height && x1 > x0 && y1 - y0 === x1 - x0)) throw new PackError("host geometry");
  }
  if (!h.videos?.length || !h.videos.every((v) => v.frames?.length === h.count && v.keyframeInterval >= 1)) {
    throw new PackError("host videos");
  }
  const calm = new CalmHostWindow(pack.calmWindow);
  if (!calm.fits(h.count) || !calm.hasPath) throw new PackError("calm window does not fit the hosts");
  if (pack.still?.host !== calm.first) throw new PackError("still host");
  const lips = pack.instantLips;
  if (!(lips && lips.lookaheadFrames >= 0 && lips.lookaheadFrames <= 12 && lips.batchFrames >= 1 && lips.batchFrames <= 6
    && (lips.standIn === "mirror" || lips.standIn === "silence") && lips.voiceDelayMilliseconds >= 0
    && lips.voiceDelayMilliseconds <= 1000)) throw new PackError("instant lips");
  const gain = pack.face?.articulationGain;
  if (!(Number.isFinite(gain) && gain >= 0.5 && gain <= 2)) throw new PackError("articulation gain");
  const lead = pack.face?.lipLeadMilliseconds;
  if (!(Number.isInteger(lead) && lead >= 0 && lead <= 200)) throw new PackError("lip lead");
  return { pack, windows, geometry, calm };
}
