import {
  LipFadeState,
  fadeRegion,
  featherAlpha,
  type LipFadeKind,
  type Rect,
} from "./lip-fade";

type Context2D = CanvasRenderingContext2D;

function scratchCanvas(): { canvas: HTMLCanvasElement; context: Context2D } {
  const canvas = document.createElement("canvas");
  // Same backing as the main canvas (willReadFrequently keeps it in CPU memory), so region copies between them
  // never cross the GPU.
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas2D is unavailable");
  return { canvas, context };
}

/**
 * Draws the running lip fade onto the character's canvas (see lip-fade.ts). It works on the mouth region only:
 *
 * - `from`: the region as it was on screen just before the new picture, with a feathered alpha edge.
 * - `base`: the region of the newest clean picture (host, or host and mouth) the coordinator painted.
 *
 * Each display refresh while a fade runs: the base is put back (or saved again when the coordinator repainted), and
 * `from` is drawn over it at 1 - weight. Two region-sized drawImage calls; no per-pixel work in script.
 */
export class LipFadeLayer {
  readonly state = new LipFadeState();
  private readonly from = scratchCanvas();
  private readonly base = scratchCanvas();
  private readonly masks = new Map<string, HTMLCanvasElement>();
  private region?: Rect;
  /** A fade that starts at the coordinator's next repaint (`begin(..., painted = false)`). */
  private pendingKind?: LipFadeKind;

  constructor(private readonly target: Context2D) {}

  get running(): boolean {
    return this.state.running;
  }

  /**
   * A new picture is about to be painted: keep what the screen shows now in `region` (the union of the old and new
   * mouth boxes) as the picture to fade from. Call before painting.
   */
  capture(previousBox: Rect | undefined, nextBox: Rect): void {
    const { width, height } = this.target.canvas;
    const region = fadeRegion(previousBox, nextBox, width, height);
    const [x0, y0, x1, y1] = region;
    const w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return;
    const from = this.from;
    if (from.canvas.width !== w || from.canvas.height !== h) {
      from.canvas.width = w;
      from.canvas.height = h;
    }
    from.context.globalCompositeOperation = "copy";
    from.context.drawImage(this.target.canvas, x0, y0, w, h, 0, 0, w, h);
    from.context.globalCompositeOperation = "destination-in";
    from.context.drawImage(this.mask(w, h), 0, 0);
    from.context.globalCompositeOperation = "source-over";
    this.region = region;
  }

  /**
   * Start a fade of `kind` from the captured picture. `painted`: the new picture is already on the canvas (it is
   * saved as the base and the fade drawn at once); otherwise the fade waits for the coordinator's next repaint, and
   * its clock starts there.
   */
  begin(kind: LipFadeKind, nowMs: number, painted = true): void {
    if (!this.region) {
      this.state.step();
      return;
    }
    if (!painted) {
      this.pendingKind = kind;
      this.state.end();
      return;
    }
    this.pendingKind = undefined;
    this.state.begin(kind, nowMs);
    this.refresh(nowMs, true);
  }

  /** A new lip frame is shown whole (a skip or a host jump in `blend`). */
  step(): void {
    this.state.step();
    this.pendingKind = undefined;
    this.region = undefined;
  }

  /**
   * A display refresh. `repainted`: the coordinator painted a clean picture into the region this refresh (save it
   * as the base); otherwise the base is put back before the fade is drawn over it.
   */
  refresh(nowMs: number, repainted: boolean): void {
    if (this.pendingKind && repainted && this.region) {
      const kind = this.pendingKind;
      this.pendingKind = undefined;
      this.state.begin(kind, nowMs);
    }
    if (!this.state.running || !this.region) return;
    const [x0, y0, x1, y1] = this.region;
    const w = x1 - x0, h = y1 - y0;
    const base = this.base;
    if (repainted) {
      if (base.canvas.width !== w || base.canvas.height !== h) {
        base.canvas.width = w;
        base.canvas.height = h;
      }
      base.context.globalCompositeOperation = "copy";
      base.context.drawImage(this.target.canvas, x0, y0, w, h, 0, 0, w, h);
      base.context.globalCompositeOperation = "source-over";
    } else {
      this.target.drawImage(base.canvas, x0, y0);
    }
    const weight = this.state.weight(nowMs);
    if (weight >= 1) {
      this.region = undefined;
      return;
    }
    const alpha = this.target.globalAlpha;
    this.target.globalAlpha = 1 - weight;
    this.target.drawImage(this.from.canvas, x0, y0);
    this.target.globalAlpha = alpha;
  }

  /** Drop the fade without drawing (the canvas is repainted whole next). */
  end(): void {
    this.state.end();
    this.pendingKind = undefined;
    this.region = undefined;
  }

  private mask(w: number, h: number): HTMLCanvasElement {
    const key = `${w}x${h}`;
    let mask = this.masks.get(key);
    if (mask) return mask;
    const { canvas, context } = scratchCanvas();
    canvas.width = w;
    canvas.height = h;
    const image = context.createImageData(w, h);
    for (let y = 0, o = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1, o += 4) {
        image.data[o + 3] = featherAlpha(x, y, w, h);
      }
    }
    context.putImageData(image, 0, 0);
    mask = canvas;
    if (this.masks.size > 16) this.masks.clear();
    this.masks.set(key, mask);
    return mask;
  }
}
