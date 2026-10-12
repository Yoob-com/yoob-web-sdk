// HostPath (language-companions AvatarRuntime/HostPath.swift): the realistic head's path through the host clip, one host
// frame per call frame, in the silence lanes while the lips are sealed and the speech lanes while they are not.
import { type CalmHostWindow, type Crossing, within } from "./pack";

type Range = [number, number];

export class HostPath {
  /** Whether silence may walk into a silence lane without her real lips closed (an iOS comparison switch; off). */
  static silenceEntersOpenLipLanes = false;
  /** Call frames a frame frozen with closed eyes stays before the blink is finished on it. */
  static readonly openEyesDelayFrames = 3;
  /** The longest stall walk. */
  static readonly stallFramesLimit = 60;
  /** Call frames over which a stall walk closes the lips. */
  static readonly stallCloseFrames = 4;

  host: number;
  speaking: boolean;
  private lane: Range;
  private direction: number;
  private stayed = 0;
  private leaving = false;
  private calmVisit = 0;
  private calmLeg = 0;
  private speechVisit = 0;
  private speechLeg = 0;
  private started: boolean;

  constructor(readonly window: CalmHostWindow, startHost: number, resuming = false, copy?: HostPath) {
    if (copy) {
      this.host = copy.host; this.speaking = copy.speaking; this.lane = copy.lane; this.direction = copy.direction;
      this.stayed = copy.stayed; this.leaving = copy.leaving; this.calmVisit = copy.calmVisit; this.calmLeg = copy.calmLeg;
      this.speechVisit = copy.speechVisit; this.speechLeg = copy.speechLeg; this.started = copy.started;
      return;
    }
    this.started = resuming;
    const all = [...window.lanes, ...window.speechLanes];
    const host = all.some((r) => within(r, startHost)) ? startHost : window.pathStart;
    this.host = host;
    this.speaking = window.isSpeech(host) && !window.isCalm(host);
    this.lane = (this.speaking ? window.speechLanes : window.lanes).find((r) => within(r, host)) ?? [host, host];
    this.direction = host === window.pathStart ? (window.pathStartRising ? 1 : -1)
      : ((this.lane[1] - host) >= (host - this.lane[0]) ? 1 : -1);
    this.calmLeg = HostPath.leg(0, window.isCalm(host) ? this.lane : undefined, window.itinerary, HostPath.silenceAccepts(window));
    if (!this.speaking && !HostPath.silenceEntersOpenLipLanes && !window.isClosedLips(host)) this.leaving = true;
    this.speechLeg = HostPath.leg(0, this.speaking ? this.lane : undefined, window.speechItinerary);
  }

  clone(): HostPath { return new HostPath(this.window, this.host, false, this); }

  /** The host for the next call frame. `voice`: the lips are not sealed on it. `settling`: a stall walk. */
  next(voice: boolean, settling = false): number {
    const w = this.window;
    if (voice !== this.speaking) {
      if (voice ? w.isSpeech(this.host) : w.isCalm(this.host)) {
        this.speaking = voice;
        this.lane = (voice ? w.speechLanes : w.lanes).find((r) => within(r, this.host)) ?? this.lane;
        this.stayed = 0; this.leaving = !voice && !w.isClosedLips(this.host);
        if (voice) this.speechLeg = HostPath.leg(this.speechLeg, this.lane, w.speechItinerary);
        else this.calmLeg = HostPath.leg(this.calmLeg, this.lane, w.itinerary, HostPath.silenceAccepts(w));
      } else {
        const to = (voice ? w.entries : w.exits).get(this.host);
        if (to !== undefined) {
          this.land(to, voice); this.started = true;
          return this.host;
        }
      }
    }
    if (!this.started) { this.started = true; return this.host; }
    if (!this.speaking && !w.isClosedLips(this.host) && (this.leaving || settling)) {
      const to = w.exits.get(this.host);
      if (to !== undefined) {
        this.calmVisit += 1;
        this.land(to, false);
        return this.host;
      }
    }
    const itinerary = this.speaking ? w.speechItinerary : w.itinerary;
    const stays = this.speaking ? w.speechStays : (w.isClosedLips(this.host) ? w.stays : w.openLipStays);
    const leg = this.speaking ? this.speechLeg : this.calmLeg;
    if (this.leaving && leg < itinerary.length && this.host === itinerary[leg].from
        && (this.speaking || HostPath.silenceAccepts(w)(itinerary[leg]))) {
      if (this.speaking) { this.speechVisit += 1; this.speechLeg = (leg + 1) % itinerary.length; }
      else { this.calmVisit += 1; this.calmLeg = (leg + 1) % itinerary.length; }
      this.land(itinerary[leg].to, this.speaking, true);
      return this.host;
    }
    if (!within(this.lane, this.host + this.direction)) this.direction = -this.direction;
    this.host = Math.min(Math.max(this.host + this.direction, this.lane[0]), this.lane[1]);
    this.stayed += 1;
    const visit = this.speaking ? this.speechVisit : this.calmVisit;
    if (stays.length > 0 && this.stayed >= stays[visit % stays.length]) this.leaving = true;
    return this.host;
  }

  private land(to: number, voice: boolean, keepLeg = false): void {
    const w = this.window;
    this.host = to; this.speaking = voice;
    const lanes = voice ? w.speechLanes : w.lanes;
    this.lane = lanes.find((r) => within(r, to)) ?? [to, to];
    this.direction = (this.lane[1] - to) >= (to - this.lane[0]) ? 1 : -1;
    this.stayed = 0; this.leaving = false;
    if (!keepLeg) {
      if (voice) this.speechLeg = HostPath.leg(this.speechLeg, this.lane, w.speechItinerary);
      else this.calmLeg = HostPath.leg(this.calmLeg, this.lane, w.itinerary, HostPath.silenceAccepts(w));
    } else {
      const leg = voice ? this.speechLeg : this.calmLeg;
      const fixed = HostPath.leg(leg, this.lane, voice ? w.speechItinerary : w.itinerary,
        voice ? () => true : HostPath.silenceAccepts(w));
      if (voice) this.speechLeg = fixed; else this.calmLeg = fixed;
    }
  }

  private static leg(index: number, lane: Range | undefined, itinerary: Crossing[], accepts: (c: Crossing) => boolean = () => true): number {
    if (!lane || itinerary.length === 0) return index;
    for (let offset = 0; offset < itinerary.length; offset += 1) {
      const candidate = (index + offset) % itinerary.length;
      if (within(lane, itinerary[candidate].from) && accepts(itinerary[candidate])) return candidate;
    }
    return index;
  }

  static silenceAccepts(window: CalmHostWindow): (c: Crossing) => boolean {
    const open = HostPath.silenceEntersOpenLipLanes;
    return (c) => open || window.isClosedLips(c.to);
  }

  /** The hosts of the next `count` frames if the lips were `flags[i]` on each, without moving this path. */
  ahead(count: number, flags: boolean[]): number[] {
    const copy = this.clone();
    return Array.from({ length: count }, (_, i) => copy.next(i < flags.length ? flags[i] : false));
  }

  static stallLipsClosed(step: number, frozen: number): number {
    const closing = Math.min(1, (Math.max(0, step) + 1) / HostPath.stallCloseFrames);
    return closing + (1 - closing) * Math.min(Math.max(frozen, 0), 1);
  }

  static holdsStalledSpeech(host: number, lipsClosed: number, window: CalmHostWindow): boolean {
    return lipsClosed < 1 || !window.isHome(host);
  }
}
