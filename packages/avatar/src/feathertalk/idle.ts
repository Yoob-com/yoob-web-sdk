/**
 * The resting face of a second-layout pack: its still, blinking.
 *
 * A second-layout pack ships no idle loop. What it ships instead is the iOS app's idle face: `still.base` (the neutral
 * host, `still.host`) and `still.blinks`, pictures of the eyes closing that go over `still.rect`. Without this the
 * character stops dead the moment it stops talking, on whatever speech frame happened to be last.
 *
 * Port of the iOS SDK's `IdleBlinkSchedule` and `SpeechBlink` placement (`Sources/YoobRealistic`), so a character
 * blinks at the same moments on both platforms.
 */

/** `pack.json`'s `still`: the resting face and its blink. */
export interface PackStill {
  base?: string;
  host?: number;
  /** `[x, y, width, height]` of the blink pictures in frame pixels. */
  rect?: [number, number, number, number];
  /** Blink picture for each 40 ms step of one blink (indices into `blinks`). */
  sequence?: number[];
  blinks?: string[];
}

const MASK = (1n << 64n) - 1n;

/**
 * When the still face blinks. Time is cut into 4.5 s cells; each cell holds one blink starting 0.75-2.25 s into it, so
 * consecutive blinks are 3-6 s apart, and about one in seven is a double blink. A pure function of time: the same
 * moment always shows the same picture.
 */
export class IdleBlinkSchedule {
  stepSeconds = 0.04;
  cellSeconds = 4.5;
  earliestStart = 0.75;
  latestStart = 2.25;
  doubleBlinkChance = 0.15;
  /** Open-eye steps between the two blinks of a double blink. */
  doubleBlinkGapSteps = 3;
  seed = 0x5eedb11en;

  constructor(readonly sequence: number[]) {}

  get blinkSeconds(): number { return this.sequence.length * this.stepSeconds; }

  /** Start times of the blinks in cell `index`. */
  starts(index: number): number[] {
    const cellStart = index * this.cellSeconds;
    const first = cellStart + this.earliestStart + (this.latestStart - this.earliestStart) * this.unit(index, 0n);
    if (this.unit(index, 1n) >= this.doubleBlinkChance) return [first];
    return [first, first + this.blinkSeconds + this.doubleBlinkGapSteps * this.stepSeconds];
  }

  /**
   * The blink picture to show at `time` (seconds on any fixed clock), or undefined for the open-eyed face. A blink that
   * began before `resumeAfter` is skipped whole, eyes open: a blink cut short or blended into a crossfade looks wrong.
   */
  picture(time: number, resumeAfter = -Infinity): number | undefined {
    if (!this.sequence.length || !Number.isFinite(time)) return undefined;
    const cell = Math.floor(time / this.cellSeconds);
    for (const start of this.starts(cell)) {
      if (time < start || start < resumeAfter) continue;
      const step = Math.floor((time - start) / this.stepSeconds);
      if (step < this.sequence.length) return this.sequence[step];
    }
    return undefined;
  }

  /** A uniform number in [0, 1) from the cell index (SplitMix64, as iOS). */
  private unit(cell: number, salt: bigint): number {
    let z = (this.seed + BigInt.asUintN(64, BigInt(cell)) * 0x9e3779b97f4a7c15n + salt * 0xd1b54a32d192ed03n) & MASK;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    z ^= z >> 31n;
    return Number(z >> 11n) / 2 ** 53;
  }
}

/** Pixels over which a blink picture's edge blends into the face, so its rectangle never shows (iOS: 12). */
export const BLINK_EDGE_PIXELS = 12;
/** How long the face takes to settle from the last speech frame onto the still. */
export const IDLE_FADE_MS = 250;

type Surface = OffscreenCanvas | HTMLCanvasElement;
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const surface = (width: number, height: number): Surface => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

/** A blink picture whose edges fade to transparent over `edge` pixels. */
function feathered(picture: ImageBitmap, width: number, height: number, edge: number): Surface {
  const out = surface(width, height);
  const context = out.getContext('2d') as Context2D;
  context.drawImage(picture, 0, 0, width, height);
  const image = context.getImageData(0, 0, width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = Math.min(x, y, width - 1 - x, height - 1 - y);
      if (distance >= edge) continue;
      image.data[(y * width + x) * 4 + 3] = Math.round(255 * ((distance + 0.5) / edge));
    }
  }
  context.putImageData(image, 0, 0);
  return out;
}

/**
 * Draws the resting face: the still, with the eyes blinking on schedule, settling from the last speech frame when a
 * reply ends. `render` is called on every animation frame while the character is not speaking and only touches the
 * canvas when the picture changes.
 */
export class IdleStill {
  private readonly schedule: IdleBlinkSchedule;
  /** The picture on the canvas: a blink index, -1 for open eyes, undefined when something else drew over it. */
  private shown?: number;
  private fade?: { from: Surface; start: number };
  /** No blink may begin before this (seconds), so none is blended into the settle. */
  private resumeAfter = -Infinity;

  private constructor(
    private readonly base: ImageBitmap,
    private readonly rect: [number, number, number, number],
    private readonly blinks: Surface[],
    sequence: number[],
  ) {
    this.schedule = new IdleBlinkSchedule(sequence);
  }

  /**
   * The resting face described by a pack's `still`, or undefined when the pack does not describe one completely.
   * `read` returns a pack file's verified bytes; `base` is used when the still names no picture of its own.
   */
  static async load(still: PackStill | undefined, read: (path: string) => Promise<ArrayBuffer>,
    base?: ImageBitmap): Promise<IdleStill | undefined> {
    const rect = still?.rect;
    const blinks = still?.blinks ?? [];
    const sequence = still?.sequence ?? [];
    if (!rect || rect.length !== 4 || !(rect[2] > 0 && rect[3] > 0) || !blinks.length || !sequence.length
      || !sequence.every((index) => Number.isInteger(index) && index >= 0 && index < blinks.length)) {
      return undefined;
    }
    const decode = async (path: string) => createImageBitmap(new Blob([await read(path)], { type: 'image/jpeg' }));
    const [face, ...pictures] = await Promise.all([
      still?.base ? decode(still.base) : Promise.resolve(base),
      ...blinks.map(decode),
    ]);
    if (!face) return undefined;
    const [, , width, height] = rect;
    return new IdleStill(face as ImageBitmap, rect, pictures.map((picture) => {
      const edged = feathered(picture as ImageBitmap, width, height, BLINK_EDGE_PIXELS);
      (picture as ImageBitmap).close();
      return edged;
    }), sequence);
  }

  /**
   * The character stopped talking (or is about to start): settle from what `canvas` shows now onto the still over
   * `fadeMs`, with no blink until the settle is done.
   */
  enter(canvas: HTMLCanvasElement, now: number, fadeMs = IDLE_FADE_MS): void {
    this.shown = undefined;
    if (fadeMs > 0 && canvas.width && canvas.height) {
      const from = surface(canvas.width, canvas.height);
      (from.getContext('2d') as Context2D).drawImage(canvas, 0, 0);
      this.fade = { from, start: now };
    } else {
      this.fade = undefined;
    }
    this.resumeAfter = (now + Math.max(0, fadeMs)) / 1000;
  }

  /** Something else drew on the canvas (a speech frame): repaint on the next render. */
  invalidate(): void { this.shown = undefined; }

  /** Draws the resting face for `now` (ms, `performance.now()`), if it changed. */
  render(context: CanvasRenderingContext2D, now: number): void {
    const { width, height } = context.canvas;
    if (this.fade) {
      const progress = Math.min(1, (now - this.fade.start) / IDLE_FADE_MS);
      context.globalAlpha = 1;
      context.drawImage(this.fade.from, 0, 0, width, height);
      context.globalAlpha = progress;
      context.drawImage(this.base, 0, 0, width, height);
      context.globalAlpha = 1;
      if (progress >= 1) this.fade = undefined;
      this.shown = undefined;
      return;
    }
    const picture = this.schedule.picture(now / 1000, this.resumeAfter) ?? -1;
    if (picture === this.shown) return;
    context.drawImage(this.base, 0, 0, width, height);
    if (picture >= 0) {
      // The rectangle is in host-frame pixels; the canvas is sized to the host frame, but scale in case it is not.
      const sx = width / this.base.width;
      const sy = height / this.base.height;
      const [x, y, w, h] = this.rect;
      context.drawImage(this.blinks[picture], x * sx, y * sy, w * sx, h * sy);
    }
    this.shown = picture;
  }
}
