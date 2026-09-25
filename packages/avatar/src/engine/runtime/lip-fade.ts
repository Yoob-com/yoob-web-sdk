/**
 * How the canvas moves between the 25 lip frames a second (the Luna app's `LipCadence`, `LipCrossfade` and
 * `LipHandover`, 2026-09-24/25).
 *
 * `step` is the 0.2 presentation: each lip frame is painted whole when its host frame is presented, and the mouth
 * overlay disappears in one picture at the end of a reply. On a 60 or 120 Hz display that is a 25 fps step, and the
 * end of a reply is a jump from the model's mouth to the idle face's own.
 *
 * `blend` (the default) cross-fades:
 * - Each new lip frame fades in over the one before across one frame's time (40 ms). A host frame is presented half
 *   a frame before its audio (the reply starts from the host at 0.5 / 25 s), so the fade reaches half weight when its
 *   audio is due: on average the lips are exactly as early as the steps' audio clock says.
 * - The first lip frame of a reply fades in over the idle face across 120 ms centred on its audio (a third of the
 *   way in when it is first shown), so the mouth never appears before its sound.
 * - At the end of a reply (or an interruption) the last mouth fades out over the idle face across 160 ms. Nothing is
 *   heard then, so taking longer than a lip frame delays nothing.
 * - More than one skipped lip frame, or a host frame that is not a neighbour of the one before, steps as before.
 *
 * Only the mouth region is faded (the union of the two frames' mouth boxes, with a feathered edge). Outside it the
 * picture is the host frame, which moves by a pixel or two between neighbours.
 */
export type LipCadence = "blend" | "step";

export const LIP_FRAME_MS = 40;
/** A new lip frame replaces the one before over one frame. */
export const LIP_NEIGHBOUR_FADE_MS = LIP_FRAME_MS;
/** The first lip frame of a reply over the idle face: centred on its audio. */
export const LIP_ENTER_FADE_MS = 120;
/** The last lip frame of a reply back to the idle face. */
export const LIP_SETTLE_FADE_MS = 160;
/** How far before its audio a host frame (and its lip frame) is presented: half a frame, see NEUTRAL_HOST_TIME. */
export const HOST_PRESENTATION_LEAD_MS = LIP_FRAME_MS / 2;
/** Inward feather of the faded region's edge, in canvas pixels. */
export const LIP_FADE_FEATHER_PX = 12;

export type LipFadeKind = "neighbour" | "enter" | "settle";

export function resolveLipCadence(value: unknown): LipCadence {
  return value === "step" ? "step" : "blend";
}

/** The next lip frame, or one after a skipped frame (the app's `LipCrossfade.fades(fromFrame:toFrame:)`). */
export function lipFramesAdjacent(from: number, to: number): boolean {
  return from >= 0 && to > from && to - from <= 2;
}

/** Neighbouring host frames of the idle loop (wrapping at its end). A seek to another place is a jump. */
export function hostFramesAdjacent(from: number, to: number, nIdle: number): boolean {
  if (from < 0 || to < 0 || nIdle <= 0) return false;
  const distance = Math.abs(((to - from) % nIdle + nIdle) % nIdle);
  return Math.min(distance, nIdle - distance) <= 2;
}

/**
 * The weight of the new picture over the one before, `elapsedMs` after it was first shown. 0..1; 1 ends the fade.
 */
export function lipFadeWeight(kind: LipFadeKind, elapsedMs: number): number {
  const elapsed = Math.max(0, elapsedMs);
  let weight: number;
  switch (kind) {
    case "neighbour":
      weight = elapsed / LIP_NEIGHBOUR_FADE_MS;
      break;
    case "enter":
      // Half weight when its audio is due, HOST_PRESENTATION_LEAD_MS after it is shown.
      weight = 0.5 + (elapsed - HOST_PRESENTATION_LEAD_MS) / LIP_ENTER_FADE_MS;
      break;
    case "settle":
      weight = elapsed / LIP_SETTLE_FADE_MS;
      break;
  }
  return Math.min(1, Math.max(0, weight));
}

export type Rect = [x0: number, y0: number, x1: number, y1: number];

/**
 * The region a fade covers: the union of the two mouth boxes, grown to a multiple of 16 pixels (so few feather masks
 * are built) and clipped to the canvas.
 */
export function fadeRegion(a: Rect | undefined, b: Rect, width: number, height: number): Rect {
  const x0 = Math.min(a ? a[0] : b[0], b[0]);
  const y0 = Math.min(a ? a[1] : b[1], b[1]);
  const x1 = Math.max(a ? a[2] : b[2], b[2]);
  const y1 = Math.max(a ? a[3] : b[3], b[3]);
  const grow = (low: number, high: number, limit: number): [number, number] => {
    const size = Math.min(limit, Math.ceil((high - low) / 16) * 16);
    let start = Math.floor(low - (size - (high - low)) / 2);
    start = Math.max(0, Math.min(limit - size, start));
    return [start, start + size];
  };
  const [gx0, gx1] = grow(x0, x1, width);
  const [gy0, gy1] = grow(y0, y1, height);
  return [gx0, gy0, gx1, gy1];
}

/** Alpha 0..255 of the feather mask at (x, y) of a w x h region: 255 inside, ramping to 0 at the edge. */
export function featherAlpha(x: number, y: number, w: number, h: number, feather = LIP_FADE_FEATHER_PX): number {
  const edge = Math.min(x + 0.5, y + 0.5, w - x - 0.5, h - y - 0.5);
  return Math.round(255 * Math.min(1, Math.max(0, edge / feather)));
}

export interface LipFadeCounts {
  /** Neighbour cross-fades begun. */
  started: number;
  /** New lip frames shown whole in `blend` (a skip of more than one frame, or a host jump). */
  stepped: number;
  /** Reply starts faded in. */
  enters: number;
  /** Reply ends (and interruptions) faded out. */
  settles: number;
}

/** The running fade: its kind, when its picture was first shown, and its weight (never going back). */
export class LipFadeState {
  kind: LipFadeKind = "neighbour";
  private startMs = 0;
  private weightValue = 1;
  running = false;
  readonly counts: LipFadeCounts = { started: 0, stepped: 0, enters: 0, settles: 0 };

  begin(kind: LipFadeKind, nowMs: number): number {
    this.kind = kind;
    this.startMs = nowMs;
    this.running = true;
    this.weightValue = 0;
    if (kind === "neighbour") this.counts.started += 1;
    else if (kind === "enter") this.counts.enters += 1;
    else this.counts.settles += 1;
    return this.weight(nowMs);
  }

  step(): void {
    this.counts.stepped += 1;
    this.end();
  }

  /** The weight at `nowMs`; a weight of 1 ends the fade. */
  weight(nowMs: number): number {
    if (!this.running) return 1;
    this.weightValue = Math.max(this.weightValue, lipFadeWeight(this.kind, nowMs - this.startMs));
    if (this.weightValue >= 1) this.end();
    return this.weightValue;
  }

  end(): void {
    this.running = false;
    this.weightValue = 1;
  }
}
