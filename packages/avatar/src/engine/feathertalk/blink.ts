// IdleBlinkSchedule and SpeechBlinkGate (language-companions AvatarRuntime/IdleBlink.swift, SpeechBlink.swift).
import type { CalmHostWindow } from "./pack";

const MASK = (1n << 64n) - 1n;

/**
 * When the still idle face blinks: 4.5 s cells (3.6 s on speaking frames), one blink 0.75-2.25 s into each, about one in
 * seven doubled. A pure function of time, the same SplitMix64 draw as the app.
 */
export class IdleBlinkSchedule {
  stepSeconds = 0.04;
  cellSeconds = 4.5;
  earliestStart = 0.75;
  latestStart = 2.25;
  doubleBlinkChance = 0.15;
  doubleBlinkGapSteps = 3;
  seed = 0x5EEDB11En;

  constructor(readonly sequence: number[]) {}

  get blinkSeconds(): number { return this.sequence.length * this.stepSeconds; }

  starts(cell: number): number[] {
    const cellStart = cell * this.cellSeconds;
    const first = cellStart + this.earliestStart + (this.latestStart - this.earliestStart) * this.unit(cell, 0n);
    if (!(this.unit(cell, 1n) < this.doubleBlinkChance)) return [first];
    return [first, first + this.blinkSeconds + this.doubleBlinkGapSteps * this.stepSeconds];
  }

  /** The blink picture at `time`, or undefined for open eyes; a blink begun before `resumeAfter` is skipped. */
  picture(time: number, resumeAfter = -Infinity): number | undefined {
    if (this.sequence.length === 0 || !Number.isFinite(time)) return undefined;
    const cell = Math.floor(time / this.cellSeconds);
    for (const start of this.starts(cell)) {
      if (time >= start && !(start < resumeAfter)) {
        const step = Math.floor((time - start) / this.stepSeconds);
        if (step < this.sequence.length) return this.sequence[step];
      }
    }
    return undefined;
  }

  blinkStarts(time: number, step: number): boolean {
    if (this.sequence.length === 0 || !Number.isFinite(time) || !(step > 0)) return false;
    const cell = Math.floor(time / this.cellSeconds);
    return this.starts(cell).some((start) => time >= start && time - start < step);
  }

  private unit(cell: number, salt: bigint): number {
    let z = (this.seed + (BigInt.asUintN(64, BigInt(cell)) * 0x9E3779B97F4A7C15n) + salt * 0xD1B54A32D192ED03n) & MASK;
    z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK;
    z ^= z >> 31n;
    return Number(z >> 11n) / 2 ** 53;
  }
}

/** The blink of the still idle face on speaking frames (`SpeechBlink`): its schedule cell is 3.6 s. */
export const SPEECH_BLINK_CELL_SECONDS = 3.6;
export const BLINK_EDGE_PIXELS = 12;

export const SpeechBlinkGate = {
  holdFrames: 8,
  allows(heldFrames: number, hostsThroughBlink: number[], window: CalmHostWindow, blinkFrames: number): boolean {
    return heldFrames >= SpeechBlinkGate.holdFrames && hostsThroughBlink.length >= blinkFrames
      && hostsThroughBlink.slice(0, blinkFrames).every((host) => window.isBlinkable(host));
  },
};
