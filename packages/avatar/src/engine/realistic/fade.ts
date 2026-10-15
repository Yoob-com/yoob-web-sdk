// The display cadence between lip frames (iOS Core/LipCadence.swift: LipCrossfade, LipHandover, LipFade). Positions are
// on the face's clock: the audible 24 kHz sample less the lip lead, counted from the segment's first frame.

export const SAMPLES_PER_FRAME = 960;

export class LipCrossfade {
  constructor(readonly windowSamples = SAMPLES_PER_FRAME) {}
  get advanceSamples(): number { return Math.trunc(this.windowSamples / 2); }
  newestFrame(position: number): number { return Math.floor((position + this.advanceSamples) / SAMPLES_PER_FRAME); }
  weight(frame: number, position: number): number {
    return Math.min(1, Math.max(0, (position + this.advanceSamples - frame * SAMPLES_PER_FRAME) / this.windowSamples));
  }
  static fadesHosts(from: number | undefined, to: number | undefined): boolean {
    return from !== undefined && to !== undefined && Math.abs(to - from) <= 2;
  }
  static fadesFrames(from: number, to: number): boolean { return from >= 0 && to > from && to - from <= 2; }
}

export const HANDOVER = { settleSamples: 3_840, jumpSamples: 2_880 };

type Kind = { kind: "neighbour" } | { kind: "settle"; start: number } | { kind: "jump"; due: number };

/** The running cross-fade: which frame fades in over the picture before it, and its weight. */
export class LipFade {
  frame: number | undefined;
  weight = 1;
  keepsFrom = false;
  started = 0; startedLate = 0; stepped = 0; settles = 0; jumps = 0;
  private kind: Kind = { kind: "neighbour" };
  constructor(readonly crossfade = new LipCrossfade()) {}

  /** Frame `frame` replaces `previous` at `position` (undefined before the first refresh); the weight to draw it with. */
  show(frame: number, previous: number, fromHost: number | undefined, toHost: number | undefined, position: number | undefined,
    toFootage = false, fromFootage = false): number {
    this.keepsFrom = false;
    if (position === undefined || !LipCrossfade.fadesFrames(previous, frame) || fromHost === undefined || toHost === undefined) return this.step();
    if (this.frame !== undefined && this.kind.kind !== "neighbour" && this.weight < 1) {
      this.frame = frame;
      this.weight = Math.max(this.weight, this.kindWeight(position));
      if (this.weight >= 1) return this.step();
      this.keepsFrom = true;
      return this.weight;
    }
    if (LipCrossfade.fadesHosts(fromHost, toHost)) {
      this.kind = { kind: "neighbour" };
      const weight = this.crossfade.weight(frame, position);
      if (weight >= 1) return this.step();
      this.started += 1;
      if (weight > 0.5) this.startedLate += 1;
      this.frame = frame; this.weight = weight;
      return weight;
    }
    if (toFootage && !fromFootage) {
      this.kind = { kind: "settle", start: position }; this.settles += 1;
    } else {
      this.kind = { kind: "jump", due: frame };
      if (new LipCrossfade(HANDOVER.jumpSamples).weight(frame, position) >= 1) return this.step();
      this.jumps += 1;
    }
    this.frame = frame; this.weight = this.kindWeight(position);
    return this.weight;
  }

  refresh(position: number): number | undefined {
    if (this.frame === undefined) return undefined;
    this.weight = Math.max(this.weight, this.kindWeight(position));
    if (this.weight >= 1) { this.frame = undefined; this.weight = 1; this.kind = { kind: "neighbour" }; }
    return this.weight;
  }

  end(): void { this.frame = undefined; this.weight = 1; this.kind = { kind: "neighbour" }; this.keepsFrom = false; }

  private kindWeight(position: number): number {
    switch (this.kind.kind) {
      case "neighbour": return this.frame === undefined ? 1 : this.crossfade.weight(this.frame, position);
      case "settle": return Math.min(1, Math.max(0, (position - this.kind.start) / HANDOVER.settleSamples));
      case "jump": return new LipCrossfade(HANDOVER.jumpSamples).weight(this.kind.due, position);
    }
  }

  private step(): number {
    this.stepped += 1; this.frame = undefined; this.weight = 1; this.kind = { kind: "neighbour" }; this.keepsFrom = false;
    return 1;
  }
}
