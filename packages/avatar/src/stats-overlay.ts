import type { YoobStats } from "./stats";

/**
 * The numbers, on top of the character.
 *
 * Styled inline like everything else the SDK builds — there is no stylesheet in this package and adding one would
 * mean every integrator has to import it. The class is there so a page can restyle or hide it, the same affordance
 * `yoob-avatar` already gives.
 */
export class StatsOverlay {
  readonly element: HTMLDivElement;

  constructor() {
    this.element = document.createElement("div");
    this.element.className = "yoob-avatar-stats";
    // Decorative: the root is a `role="img"` and this must not be read as part of the character.
    this.element.setAttribute("aria-hidden", "true");
    Object.assign(this.element.style, {
      position: "absolute",
      top: "8px",
      left: "8px",
      zIndex: "2",
      // Never eat a click the integrator put on the container.
      pointerEvents: "none",
      padding: "10px 12px",
      borderRadius: "8px",
      // Opaque, not translucent: these numbers are read against a moving face, and a character with a light
      // background washed the text out exactly when something was going wrong.
      background: "#000",
      color: "#ffffff",
      font: "15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
      // A number that changes every second must not move the columns under it.
      fontVariantNumeric: "tabular-nums",
      whiteSpace: "pre",
      textShadow: "0 1px 2px rgba(0,0,0,0.8)",
    });
  }

  update(stats: YoobStats): void {
    this.element.textContent = lines(stats).join("\n");
  }

  remove(): void {
    this.element.remove();
  }
}

const ms = (value: number) => `${value.toFixed(1)}ms`;
const n = (value: number) => String(Math.round(value));

/**
 * What to show, in the order you would read it when something looks wrong.
 *
 * Rates first, because they say whether there is a problem; then where the time went; then the two latencies, which
 * say whether anyone would notice.
 */
function lines(s: YoobStats): string[] {
  const out = [
    `draw ${n(s.drawFps)}fps   frames ${n(s.frameFps)}/s   lips ${n(s.lipFps)}fps   queue ${n(s.queued)}`,
  ];

  // Only when there is something to say: a quiet HUD means a healthy one.
  const trouble: string[] = [];
  if (s.heldFrames) trouble.push(`held ${n(s.heldFrames)}`);
  if (s.droppedFrames) trouble.push(`dropped ${n(s.droppedFrames)}`);
  if (s.waitingBatches) trouble.push(`starved ${n(s.waitingBatches)}`);
  if (s.underruns) trouble.push(`underrun ${n(s.underruns)} (${ms(s.underrunMs)})`);
  if (trouble.length) out.push(trouble.join("   "));

  out.push(`enc ${ms(s.encoderMs)}   rend ${ms(s.rendererMs)}   host ${ms(s.hostMs)}`);
  // The JavaScript either side of the renderer. Shown next to the models because the question is always which of the
  // four is the expensive one, and for a long time two of them could not be seen at all.
  out.push(`tensor ${ms(s.tensorMs)}   composite ${ms(s.compositeMs)}`);
  out.push(`audio ${n(s.audioBufferedMs)}ms   lead ${s.renderLead > 0 ? "+" : ""}${n(s.renderLead)}f`);

  const latency: string[] = [];
  if (s.lipLatencyMs !== undefined) latency.push(`lip ${n(s.lipLatencyMs)}ms`);
  if (s.replyLatencyMs !== undefined) latency.push(`reply ${n(s.replyLatencyMs)}ms`);
  if (s.startGate) latency.push(`waited on ${s.startGate}`);
  if (latency.length) out.push(latency.join("   "));

  const about = [s.backend, s.character, s.version, s.size].filter(Boolean);
  if (about.length) out.push(about.join(" · "));
  return out;
}
