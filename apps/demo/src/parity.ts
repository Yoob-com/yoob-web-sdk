// Development page: the FeatherTalk engine against the Luna app's reference renders, and its speed in this browser.
// offline: every frame composed in order from the WAV in 20 ms packets, as `AvatarModelProbe --stream` does, each
//          frame's 448 px face window saved through the dev server (POST /__parity/<run>/faces.bgr) with its metadata.
// live:    the WAV spoken at 1x in 20 ms packets through YoobAvatar (instant lips, audible clock), then the engine's
//          counters: frames rendered, shown, skipped and late, model and compose times, and when each frame was shown.
import { YoobAvatar } from "@yoob/avatar";
import { ConversationAudio } from "../../../packages/avatar/src/engine/audio/conversation-audio";
import { FeatherTalkCoordinator } from "../../../packages/avatar/src/engine/feathertalk/coordinator";
import type { FTStats } from "../../../packages/avatar/src/engine/feathertalk/protocol";

const params = new URLSearchParams(location.search);
let pack = params.get("pack") ?? "/packs/astrid/";
const wav = params.get("wav") ?? "/ref/tutor-mix-30.wav";
const mode = params.get("mode") ?? "offline";
let run = params.get("run") ?? `${pack.split("/").filter(Boolean).pop()}-${mode}`;
const seconds = Number(params.get("seconds") ?? "0");
const log = document.querySelector("#log")!;
const say = (line: string) => { log.textContent += `${line}\n`; console.log(line); };
const save = (file: string, body: BodyInit, append = false) =>
  fetch(`/__parity/${run}/${file}${append ? "?append=1" : ""}`, { method: "POST", body });

async function pcm24k(): Promise<Int16Array> {
  const bytes = new Uint8Array(await (await fetch(wav)).arrayBuffer());
  const view = new DataView(bytes.buffer);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4)), size = view.getUint32(offset + 4, true);
    if (id === "data") {
      const pcm = new Int16Array(bytes.buffer.slice(offset + 8, offset + 8 + size));
      return seconds > 0 ? pcm.slice(0, Math.round(seconds * 24_000)) : pcm;
    }
    offset += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}

function summary(stats: FTStats, wallMs: number, audioMs: number): Record<string, unknown> {
  const sync = stats.syncSamples.map((s) => s / 24).sort((a, b) => a - b);
  const pct = (p: number) => sync.length ? sync[Math.min(sync.length - 1, Math.floor((sync.length - 1) * p))] : NaN;
  return {
    adapter: stats.adapter, video: stats.video, loadTimings: stats.loadTimings, audioSeconds: audioMs / 1000, wallSeconds: wallMs / 1000,
    rendered: stats.renders, composed: stats.composed, shown: stats.shown, skipped: stats.skipped, lateRefreshes: stats.late,
    renderedPerSecond: stats.renders / (audioMs / 1000),
    encodeCalls: stats.encodes, standInEncodes: stats.standInEncodes,
    encodeMsPerFrame: stats.encodeMs / Math.max(1, stats.renders), renderMsPerFrame: stats.renderMs / Math.max(1, stats.renders),
    composeMsPerFrame: stats.composeMs / Math.max(1, stats.composed), hostDecodeMs: stats.hostDecodeMs, hostGroups: stats.hostGroups,
    shownAfterDueMs: { p05: pct(0.05), p50: pct(0.5), p95: pct(0.95), min: sync[0], max: sync[sync.length - 1] },
  };
}

async function offline(): Promise<void> {
  const pcm = await pcm24k();
  const metas: unknown[] = [];
  let pending: Uint8Array[] = [], pendingBytes = 0;
  const flush = async () => {
    if (!pendingBytes) return;
    const joined = new Uint8Array(pendingBytes);
    let at = 0;
    for (const part of pending) { joined.set(part, at); at += part.length; }
    pending = []; pendingBytes = 0;
    await save("faces.bgr", joined, true);
  };
  await save("faces.bgr", new Uint8Array(0));
  let written: Promise<void> = Promise.resolve();
  const writes: Promise<unknown>[] = [];
  const coordinator = new FeatherTalkCoordinator(undefined, new ConversationAudio(), {
    onError: (message) => say(`error: ${message}`),
    onCapture: (capture) => {
      const bgr = new Uint8Array(capture.side * capture.side * 3);
      for (let i = 0, j = 0; i < capture.pixels.length; i += 4, j += 3) {
        bgr[j] = capture.pixels[i + 2]; bgr[j + 1] = capture.pixels[i + 1]; bgr[j + 2] = capture.pixels[i];
      }
      pending.push(bgr); pendingBytes += bgr.length;
      metas.push({ frame: capture.frame, host: capture.host, x: capture.x, y: capture.y, raw: capture.raw, blink: capture.blink, seal: capture.seal });
      if (capture.crop) writes.push(save(`dump/${capture.frame}.crop`, capture.crop as Uint8Array<ArrayBuffer>));
      if (capture.window) writes.push(save(`dump/${capture.frame}.window`, capture.window as Float32Array<ArrayBuffer>));
      // Appends go out one at a time, in capture order (two POSTs in flight can land out of order).
      if (pendingBytes > 16 << 20) { written = written.then(flush); writes.push(written); }
    },
  });
  const started = performance.now();
  await coordinator.initialize({ kind: "url", base: new URL(pack, location.href).href }, { cadence: "step", offline: { faceWindow: 448, dump: (params.get("dump") ?? "").split(",").filter(Boolean).map(Number) } });
  say(`loaded in ${Math.round(performance.now() - started)} ms`);
  const t0 = performance.now();
  const result = await coordinator.runOffline(pcm, 480);
  await Promise.all(writes); await written; await flush();
  const report = { run, pack, wav, frames: result.frames, ...summary(result.stats, performance.now() - t0, pcm.length / 24), metas };
  await save("report.json", JSON.stringify(report, null, 1));
  coordinator.destroy();
  say(JSON.stringify({ ...report, metas: undefined }, null, 1));
  say("DONE");
}

/** `batch=a,b,c`: the offline run for each pack /packs/<id>/, one after another (run name `<id>-offline`). */
async function batch(ids: string[]): Promise<void> {
  for (const id of ids) {
    pack = `/packs/${id}/`; run = `${id}-offline`;
    say(`== ${id}`);
    await offline();
  }
  say("BATCH DONE");
}

async function live(): Promise<void> {
  const pcm = await pcm24k();
  const avatar = new YoobAvatar({ container: document.querySelector("#character")!, character: "local", packUrl: pack,
    onError: (error) => say(`error: ${error.message}`) });
  // Sound must be unlocked inside the click, before the load's awaits.
  const unlocked = avatar.unlockAudio();
  const started = performance.now();
  await avatar.prepare();
  say(`loaded in ${Math.round(performance.now() - started)} ms`);
  await unlocked;
  if (params.get("mute") !== "0") {
    // Measurements stay silent: the voice plays through a zero gain (the playback clock runs as usual).
    const audio = (avatar as unknown as { audioOut: { context: AudioContext; playback: AudioWorkletNode } }).audioOut;
    const silent = audio.context.createGain(); silent.gain.value = 0;
    audio.playback.disconnect(); audio.playback.connect(silent); silent.connect(audio.context.destination);
  }
  // The reply is over when the avatar is back to ready (its audio played out).
  const ended = () => new Promise<void>((resolve) => {
    const check = () => (avatar.phase === "ready" ? resolve() : setTimeout(check, 50));
    setTimeout(check, 500);
  });
  const coordinator = (avatar as unknown as { coordinator: FeatherTalkCoordinator }).coordinator;
  const t0 = performance.now();
  const repeats = Number(params.get("repeat") ?? "1");
  const delays: number[] = [];
  for (let round = 0; round < repeats; round += 1) {
    delays.push(coordinator.voiceDelay);
    const start = performance.now();
    for (let offset = 0, packet = 0; offset < pcm.length; offset += 480, packet += 1) {
      const wait = start + packet * 20 - performance.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      avatar.speak(pcm.subarray(offset, offset + 480));
    }
    avatar.endSpeech();
    await ended();
    if (round + 1 < repeats) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const stats = await coordinator.stats();
  const report = { run, pack, wav, repeats, voiceDelays: delays, ...summary(stats, performance.now() - t0, repeats * pcm.length / 24) };
  await save("live.json", JSON.stringify(report, null, 1));
  say(JSON.stringify(report, null, 1));
  say("DONE");
}

document.querySelector<HTMLButtonElement>("#go")!.addEventListener("click", () => {
  const ids = (params.get("batch") ?? "").split(",").filter(Boolean);
  void (ids.length ? batch(ids) : mode === "live" ? live() : offline()).catch((error: unknown) => say(`FAILED: ${error instanceof Error ? error.stack : String(error)}`));
});
if (params.get("autorun") === "1" && mode === "offline") document.querySelector<HTMLButtonElement>("#go")!.click();
