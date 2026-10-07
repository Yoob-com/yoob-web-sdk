// The FeatherTalk engine's worker: pack load, lip pipeline (encoder + renderer), host video, GPU compose and display on
// an OffscreenCanvas at the audible clock. The page sends audio and the audible position; nothing else crosses threads.
import { ChunkStore } from "../../cdn";
import { setOrtWasmUrl } from "../inference/ort-runtime";
import { IdleBlinkSchedule } from "./blink";
import { FrameCompositor, type BlinkTexture, type HostPlanes } from "./compositor";
import { LipCrossfade, LipFade, SAMPLES_PER_FRAME } from "./fade";
import { HostVideoDecoder, pickVideo } from "./host-video";
import { mouthMatte, teethRegion, whiteBars } from "./image-ops";
import { FeatherTalkModels } from "./models";
import { type CheckedPack, PackError, checkPack } from "./pack";
import type { FTMainToWorker, FTStats, FTWorkerToMain, FeatherTalkOptions, PackSource } from "./protocol";
import { StreamingResampler24To16 } from "./resample";
import { CancelledError, type FrameJob, StreamingAvatar, speechBlinkSet } from "./streaming";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: FTWorkerToMain, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

/** Model milliseconds a 40 ms frame may take before frames are drawn in pairs (`watchCost`). */
const FRAME_BUDGET_MS = 27;
/** How far ahead of the display frames are composed. */
const COMPOSE_AHEAD = 6;
/** The first lip frame of a reply over the still idle face (the app's 0.22 s crossfade to speech). */
const ENTER_SAMPLES = 5_280;
/** Into the still idle face after a reply (LipHandover.settleSamples, 160 ms). */
const SETTLE_SAMPLES = 3_840;

interface Composed { frame: number; texture: GPUTexture; host: number; raw: number; holdsSpeech: boolean }

class FileSource {
  private readonly store?: ChunkStore;
  constructor(private readonly source: PackSource) {
    if (source.kind === "cdn") this.store = new ChunkStore({ cdnBase: source.cdnBase, downloadToken: source.downloadToken }, source.manifest);
  }
  grant(token: string): void { if (this.source.kind === "cdn") (this.store as unknown as { access: { downloadToken: string } }).access.downloadToken = token; }
  async bytes(path: string, onBytes?: (n: number) => void): Promise<Uint8Array> {
    if (this.store) return new Uint8Array(await this.store.bytes(path, (n) => onBytes?.(n)));
    const base = (this.source as { base: string }).base.replace(/\/?$/, "/");
    const response = await fetch(base + path);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    onBytes?.(data.length);
    return data;
  }
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

class Runtime {
  private checked!: CheckedPack;
  private files!: FileSource;
  private models!: FeatherTalkModels;
  private compositor!: FrameCompositor;
  private decoder!: HostVideoDecoder;
  private pipeline!: StreamingAvatar;
  private device!: GPUDevice;
  private bars: [number, number][] = [];
  private planes!: HostPlanes;
  private stillTexture!: GPUTexture;
  private blinkTextures: BlinkTexture[] = [];
  private idleSchedule!: IdleBlinkSchedule;
  private idleTexture!: GPUTexture;
  private idlePicture: number | undefined | null = null;
  /** Every composed-frame texture made; one is free when nothing on screen, fading or composed ahead holds it. */
  private textures: GPUTexture[] = [];
  private inFlight = new Set<GPUTexture>();
  private composed = new Map<number, Composed>();
  private loadedAt = performance.now();
  private videoName = "";
  private adapterName = "";

  // Speech state.
  private utterance = -1;
  private chain: Promise<unknown> = Promise.resolve();
  private resampler = new StreamingResampler24To16();
  private ended = false;
  private drained = false;
  private nextCompose = 0;
  private pumping = false;
  private anchors: { samples: number; at: number }[] = [];
  private clockStarted = false;
  private mode: "idle" | "speech" | "stall" | "settle" = "idle";
  private shown?: Composed;
  private from?: GPUTexture;
  private weight = 1;
  private fade = new LipFade();
  private enterFrame?: number;
  private settleStart = 0;
  private stallBusy = false;
  private lastStallAt = 0;
  private stallPosition = 0;
  private lastHost?: number;
  private callFrameAtBegin = 0;
  /** Frames of this utterance shown, and shown more than half a frame after their audio was due. */
  private utteranceShown = 0;
  private utteranceLate = 0;
  private offline?: { faceWindow: number; dump?: number[] };
  private cadence: "blend" | "step" = "blend";
  readonly stats: FTStats = { frames: 0, renders: 0, encodes: 0, standInEncodes: 0, encodeMs: 0, renderMs: 0, composeMs: 0,
    composed: 0, shown: 0, skipped: 0, late: 0, hostDecodeMs: 0, hostGroups: 0, syncSamples: [], video: "" };

  /** Where the load's time went (ms), for diagnostics. */
  readonly loadTimings: Record<string, number> = {};

  async load(source: PackSource, canvas: OffscreenCanvas | undefined, options: FeatherTalkOptions): Promise<void> {
    let mark = performance.now();
    const lap = (name: string) => {
      const now = performance.now(); this.loadTimings[name] = Math.round(now - mark); mark = now;
      console.debug(`feathertalk: ${name} ${this.loadTimings[name]} ms`);
    };
    this.offline = options.offline; this.cadence = options.cadence;
    if (options.ortWasmUrl) setOrtWasmUrl(options.ortWasmUrl);
    this.files = new FileSource(source);
    const packPath = source.kind === "cdn" ? source.pack : "pack.json";
    const packBytes = await this.files.bytes(packPath);
    this.checked = checkPack(JSON.parse(new TextDecoder().decode(packBytes)));
    const { pack, geometry } = this.checked;
    let loaded = 0;
    const video = options.preferH264 ? pack.hosts.videos.find((v) => v.codec.startsWith("avc1")) : await pickVideo(pack.hosts.videos, pack.hosts.width, pack.hosts.height);
    if (!video) throw new PackError("this browser decodes none of the host videos");
    // What this browser downloads: the models, the closed-mouth window, the stills and the one host video it decodes.
    const needed = [pack.models.encoder.file, pack.models.renderer.file, pack.models.closedAudio, video.file, pack.still.base, ...pack.still.blinks];
    const totalBytes = needed.reduce((sum, path) => sum + (pack.files[path]?.bytes ?? 0), 0);
    const count = (n: number) => { loaded += n; post({ type: "progress", loadedBytes: loaded, totalBytes }); };
    const file = async (path: string) => {
      const data = await this.files.bytes(path, count);
      const receipt = pack.files[path];
      if (!receipt || receipt.bytes !== data.length || await sha256(data) !== receipt.sha256) throw new PackError(`${path} failed verification`);
      return data;
    };
    this.videoName = `${video.file} (${video.codec})`; this.stats.video = this.videoName;
    const [encoderModel, rendererModel, closedBytes, videoBytes] = await Promise.all([
      file(pack.models.encoder.file), file(pack.models.renderer.file), file(pack.models.closedAudio), file(video.file),
    ]);
    lap("download");
    const closedAudio = new Float32Array(closedBytes.buffer.slice(closedBytes.byteOffset, closedBytes.byteOffset + closedBytes.byteLength));
    if (closedAudio.length !== 40 * 1024 || !closedAudio.every(Number.isFinite)) throw new PackError("closed audio");
    this.decoder = new HostVideoDecoder(video, videoBytes, pack.hosts.width, pack.hosts.height);

    this.models = await FeatherTalkModels.load(pack, geometry, encoderModel, rendererModel);
    lap("sessions");
    const device = await FeatherTalkModels.device();
    if (!device) throw new Error("WebGPU is unavailable for the face compositor");
    this.device = device;
    const info = (device as GPUDevice & { adapterInfo?: GPUAdapterInfo }).adapterInfo;
    this.adapterName = info ? `${info.vendor} ${info.architecture} ${info.description}`.trim() : "";
    this.stats.adapter = this.adapterName;
    let context: GPUCanvasContext | undefined, format: GPUTextureFormat | undefined;
    if (canvas) {
      canvas.width = pack.hosts.width; canvas.height = pack.hosts.height;
      context = canvas.getContext("webgpu") as GPUCanvasContext;
      format = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ device, format, alphaMode: "opaque" });
    }
    const lip = pack.lipPicture;
    const mattes = new Map<number, Uint8Array>();
    if (lip?.mouth) {
      for (const side of new Set(pack.hosts.boxes.map(([x0, , x1]) => x1 - x0))) {
        mattes.set(side, mouthMatte(lip.mouth, { outer: geometry.outer, output: geometry.output, margin: geometry.margin, paste: geometry.paste }, side));
      }
    }
    this.compositor = new FrameCompositor(device, geometry, { width: pack.hosts.width, height: pack.hosts.height },
      lip ? { sharpen: lip.sharpen, teeth: lip.teeth, region: lip.teeth ? teethRegion(lip.mouth, geometry.output) : undefined, mattes } : null,
      context, format);
    // The renderer's inner crops of every host from the decoded footage (iOS DerivedCrops: the face box area-resized to
    // the face size, its centred inner square), and each host's white bars.
    const first = await this.decoder.frame(0, [1]);
    this.planes = this.compositor.createHostPlanes(first.interleaved === true);
    const inner = new Uint8Array(pack.hosts.count * geometry.innerBytes);
    const border = (geometry.face - geometry.inner) / 2;
    for (let host = 0; host < pack.hosts.count; host += 1) {
      const planes = await this.decoder.frame(host, [host + 1]);
      this.compositor.uploadHost(this.planes, planes);
      const [x0, y0, x1] = pack.hosts.boxes[host];
      const face = await this.compositor.deriveCrop(this.planes, x0, y0, x1 - x0, geometry.face);
      for (let row = 0; row < geometry.inner; row += 1) {
        const from = ((row + border) * geometry.face + border) * 3;
        inner.set(face.subarray(from, from + geometry.inner * 3), host * geometry.innerBytes + row * geometry.inner * 3);
      }
      this.bars.push(whiteBars(planes));
    }
    this.models.setInnerCrops(inner);
    lap("hostCrops");

    // The still idle face and its blink pictures.
    const still = pack.still;
    this.stillTexture = await this.imageTexture(await file(still.base));
    for (const name of still.blinks) {
      const texture = await this.imageTexture(await file(name));
      this.blinkTextures.push({ texture, x: still.rect[0], y: still.rect[1], width: still.rect[2], height: still.rect[3] });
    }
    this.idleSchedule = new IdleBlinkSchedule(still.sequence);
    this.idleTexture = this.compositor.createFrameTexture();

    const early = { lookaheadFrames: pack.instantLips.lookaheadFrames, batchFrames: pack.instantLips.batchFrames, standIn: pack.instantLips.standIn };
    this.pipeline = new StreamingAvatar(this.models, this.checked.windows, this.checked.calm, closedAudio, speechBlinkSet(still.sequence),
      geometry.outputBytes, early);
    this.pipeline.articulationGain = pack.face.articulationGain;
    this.pipeline.silenceGateShiftFrames = Math.round(pack.face.lipLeadMilliseconds / 40);
    lap("stills");
    await this.models.warmUp(closedAudio);
    lap("warmUp");
    this.drawIdle(true);
    post({ type: "ready", name: pack.name, width: pack.hosts.width, height: pack.hosts.height,
      voiceDelayMs: pack.instantLips.voiceDelayMilliseconds, leadMs: pack.face.lipLeadMilliseconds, video: this.videoName, adapter: this.adapterName });
    if (!this.offline) this.loop();
  }

  private async imageTexture(bytes: Uint8Array): Promise<GPUTexture> {
    const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
      { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const texture = this.device.createTexture({ size: [bitmap.width, bitmap.height], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    this.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height]);
    bitmap.close();
    return texture;
  }

  grant(token: string): void { this.files?.grant(token); }
  get isOffline(): boolean { return this.offline !== undefined; }

  // --- Speech -------------------------------------------------------------------------------------------------------

  begin(utterance: number): void {
    this.utterance = utterance;
    this.ended = false; this.drained = false; this.anchors = []; this.clockStarted = false;
    this.resampler = new StreamingResampler24To16();
    this.releaseComposed();
    this.nextCompose = 0;
    // The call frame the utterance starts on (the speech blinks are scheduled on it); offline runs start at 0, as the probe.
    this.callFrameAtBegin = this.offline ? 0 : Math.floor((performance.now() - this.loadedAt) / 40);
    const startHost = this.mode === "idle" ? this.lastHost : this.shown?.host ?? this.lastHost;
    this.chain = this.chain.catch(() => undefined).then(() => {
      this.pipeline.restart(utterance, this.callFrameAtBegin, startHost);
    });
    this.enterFrame = undefined;
    if (this.mode !== "idle") { this.from = this.shownTexture(); }
    this.mode = "speech"; this.shown = undefined; this.fade.end();
    this.utteranceShown = 0; this.utteranceLate = 0;
  }

  audio(utterance: number, samples: Float32Array): void {
    if (utterance !== this.utterance) return;
    const sixteen = this.resampler.push(samples);
    this.append(utterance, sixteen);
  }

  end(utterance: number): void {
    if (utterance !== this.utterance || this.ended) return;
    this.ended = true;
    this.append(utterance, this.resampler.flush());
    this.chain = this.chain.then(async () => {
      if (utterance !== this.utterance) return;
      await this.pipeline.flushTail();
      this.pump();
    }).catch((error) => this.fail(error));
  }

  private append(utterance: number, samples: Float32Array): void {
    if (samples.length === 0) return;
    this.chain = this.chain.then(async () => {
      if (utterance !== this.utterance) return;
      for (let start = 0; start < samples.length; start += 32000) await this.pipeline.append(samples.subarray(start, start + 32000));
      this.watchCost();
      this.pump();
    }).catch((error) => this.fail(error));
  }

  /** Model time per frame over the last 2 s of frames (encoder and renderer, ms), and where that window began. */
  private costMark = { frames: 0, ms: 0 };
  /**
   * When the encoder and renderer take more of each 40 ms frame than leaves room for the compose and the display (the
   * 288 px faces on a laptop GPU), frames are drawn two at a time (the app's `earlyBatchFrames` 2: the stand-in windows
   * are encoded once for both, half the encoder work) and the page gives the voice a step more delay.
   */
  private watchCost(): void {
    if (this.offline || this.pipeline.early.batchFrames > 1) return;
    const s = this.pipeline.stats, frames = this.pipeline.stats.samplesIn / 640, ms = s.encodeMs + s.renderMs;
    if (frames - this.costMark.frames < 50) return;
    const perFrame = (ms - this.costMark.ms) / (frames - this.costMark.frames);
    this.costMark = { frames, ms };
    if (perFrame > FRAME_BUDGET_MS) {
      this.pipeline.early = { ...this.pipeline.early, batchFrames: 2 };
      post({ type: "slow", msPerFrame: perFrame });
    }
  }

  clock(utterance: number, samples: number, at: number, started: boolean): void {
    if (utterance !== this.utterance || !started) return;
    this.clockStarted = true;
    this.anchors.push({ samples, at });
    if (this.anchors.length > 12) this.anchors.shift();
  }

  drainedAudio(utterance: number): void {
    if (utterance !== this.utterance) return;
    this.drained = true;
  }

  cancel(): void {
    this.utterance += 0.5; // no utterance id matches until the next begin
    this.chain = Promise.resolve();
    this.releaseComposed(true);
    if (this.mode === "speech") this.startStall();
  }

  /** The face clock now: the utterance's audible sample less the lip lead (24 kHz), or undefined before it plays. */
  private position(now = performance.timeOrigin + performance.now()): number | undefined {
    if (!this.clockStarted || this.anchors.length === 0) return undefined;
    let best = -Infinity;
    for (const anchor of this.anchors) best = Math.max(best, anchor.samples + Math.min(60, now - anchor.at) * 24);
    return best - this.checked.pack.face.lipLeadMilliseconds * 24;
  }

  // --- Compose ------------------------------------------------------------------------------------------------------

  private pump(): void {
    // Offline runs compose from `offlineFlush` alone, after each packet, in order.
    if (this.pumping || this.offline) return;
    this.pumping = true;
    void this.pumpNow().catch((error) => this.fail(error)).finally(() => { this.pumping = false; });
  }

  private async pumpNow(): Promise<void> {
    const utterance = this.utterance;
    while (utterance === this.utterance && this.mode === "speech") {
      const produced = this.pipeline.producedThrough;
      if (this.nextCompose >= produced) break;
      if (!this.offline && this.composed.size >= COMPOSE_AHEAD) break;
      let frame = this.nextCompose;
      if (!this.offline) {
        // Behind the clock: the newest frame already due is composed, the ones before it are skipped.
        const position = this.position();
        if (position !== undefined) {
          const due = Math.floor(position / SAMPLES_PER_FRAME);
          if (due > frame && produced > due) { this.stats.skipped += due - frame; frame = due; }
        }
      }
      const job = this.pipeline.take(frame);
      this.nextCompose = frame + 1;
      if (!job) continue;
      const composed = await this.composeJob(job);
      if (utterance !== this.utterance) return;
      this.composed.set(frame, composed);
      if (this.offline) { await this.capture(composed, job); this.composed.delete(frame); }
    }
  }

  private async composeJob(job: FrameJob): Promise<Composed> {
    const started = performance.now();
    const { pack } = this.checked;
    const planes = await this.decoder.frame(job.host, job.prefetch);
    this.compositor.uploadHost(this.planes, planes);
    const [x0, y0, x1] = pack.hosts.boxes[job.host], side = x1 - x0;
    const face = job.raw < 1 ? { crop: job.crop, x: x0, y: y0, side, mix: job.raw } : undefined;
    const blink = job.blink !== undefined ? this.blinkTextures[job.blink] : undefined;
    const texture = this.freeTexture();
    this.inFlight.add(texture);
    queueMicrotask(() => this.inFlight.delete(texture));
    this.compositor.compose(texture, { planes: this.planes }, face, blink, this.bars[job.host]);
    this.stats.composeMs += performance.now() - started; this.stats.composed += 1;
    this.stats.frames = this.pipeline.stats.renders;
    return { frame: job.frame, texture, host: job.host, raw: job.raw, holdsSpeech: job.holdsSpeech };
  }

  /** The probe's face window (PROBE_FACE_DUMP): `side` square centred on the host's face box, clamped to the frame. */
  private async capture(composed: Composed, job: FrameJob): Promise<void> {
    const { pack } = this.checked, side = this.offline!.faceWindow;
    const [x0, y0, x1, y1] = pack.hosts.boxes[composed.host];
    const x = Math.max(0, Math.min(pack.hosts.width - side, Math.floor((x0 + x1) / 2) - side / 2));
    const y = Math.max(0, Math.min(pack.hosts.height - side, Math.floor((y0 + y1) / 2) - side / 2));
    const pixels = await this.compositor.read(composed.texture, { x, y, width: side, height: side });
    const dump = this.offline!.dump?.includes(composed.frame);
    const crop = dump && job.crop.length ? job.crop.slice() : undefined;
    const window = dump ? this.pipeline.windowOf(composed.frame)?.slice() : undefined;
    post({ type: "capture", frame: composed.frame, host: composed.host, x, y, side, pixels, raw: job.raw, blink: job.blink ?? null,
      seal: job.seal, crop, window }, [pixels.buffer, ...(crop ? [crop.buffer] : []), ...(window ? [window.buffer] : [])]);
  }

  private releaseComposed(all = false): void {
    for (const [frame, composed] of this.composed) {
      if (all || composed !== this.shown) this.composed.delete(frame);
    }
  }

  /** A composed-frame texture nothing holds (made when all are in use). */
  private freeTexture(): GPUTexture {
    const held = new Set<GPUTexture>([this.idleTexture, ...this.inFlight]);
    if (this.from) held.add(this.from);
    if (this.shown) held.add(this.shown.texture);
    for (const composed of this.composed.values()) held.add(composed.texture);
    const free = this.textures.find((t) => !held.has(t));
    if (free) return free;
    const made = this.compositor.createFrameTexture();
    this.textures.push(made);
    return made;
  }

  private shownTexture(): GPUTexture { return this.shown?.texture ?? this.idleTexture; }

  // --- Display ------------------------------------------------------------------------------------------------------

  private loop(): void {
    // The display refresh drives presentation; when the page is hidden rAF stops, so a timer keeps the face on its clock
    // (the lips and their bookkeeping move on; nothing is visible).
    let last = 0;
    const tick = () => {
      last = performance.now();
      try { this.refresh(); } catch (error) { this.fail(error); }
    };
    const frame = () => { tick(); scope.requestAnimationFrame(frame); };
    scope.requestAnimationFrame(frame);
    setInterval(() => { if (performance.now() - last > 50) tick(); }, 16);
  }

  private refresh(): void {
    const now = performance.timeOrigin + performance.now();
    if (this.mode === "idle") { this.drawIdle(); this.compositor.present(this.idleTexture, this.idleTexture, 1); return; }
    if (this.mode === "settle") {
      const weight = Math.min(1, (now - this.settleStart) * 24 / SETTLE_SAMPLES);
      this.drawIdle();
      this.compositor.present(this.from ?? this.idleTexture, this.idleTexture, weight);
      if (weight >= 1) { this.mode = "idle"; this.from = undefined; this.releaseComposed(true); this.shown = undefined; post({ type: "idle" }); }
      return;
    }
    if (this.mode === "stall") { this.stallStep(now); return; }
    // Speech.
    this.pump();
    const position = this.position(now);
    if (position === undefined) { this.drawIdle(); this.compositor.present(this.idleTexture, this.idleTexture, 1); return; }
    const crossfade = this.fade.crossfade;
    const wanted = this.cadence === "blend" ? crossfade.newestFrame(position) : Math.floor(position / SAMPLES_PER_FRAME);
    let candidate: Composed | undefined;
    for (const composed of this.composed.values()) {
      if (composed.frame <= wanted && composed.frame > (this.shown?.frame ?? -1) && (!candidate || composed.frame > candidate.frame)) candidate = composed;
    }
    if (candidate) {
      if (!this.shown) {
        // The reply's first frame over the still idle face, centred on its due time.
        this.from = this.from ?? this.idleTexture; this.enterFrame = candidate.frame;
        this.weight = new LipCrossfade(ENTER_SAMPLES).weight(candidate.frame, position);
      } else if (this.cadence === "blend") {
        const previous = this.shown;
        this.weight = this.fade.show(candidate.frame, previous.frame, previous.host, candidate.host, position, candidate.raw >= 1, previous.raw >= 1);
        this.enterFrame = undefined;
        if (!this.fade.keepsFrom) this.from = previous.texture;
      } else { this.weight = 1; this.enterFrame = undefined; }
      // Older composed frames are done with (the one faded from stays until the fade ends).
      for (const [frame, composed] of this.composed) {
        if (frame < candidate.frame && composed.texture !== this.from) this.composed.delete(frame);
      }
      this.stats.shown += 1;
      this.stats.syncSamples.push(position - candidate.frame * SAMPLES_PER_FRAME);
      this.utteranceShown += 1;
      if (position - candidate.frame * SAMPLES_PER_FRAME > SAMPLES_PER_FRAME / 2) this.utteranceLate += 1;
      if (this.stats.syncSamples.length > 4000) this.stats.syncSamples.shift();
      this.shown = candidate; this.lastHost = candidate.host;
      if (candidate.frame === 0) post({ type: "first-frame" });
    } else if (this.shown) {
      if (this.enterFrame !== undefined) this.weight = Math.max(this.weight, new LipCrossfade(ENTER_SAMPLES).weight(this.enterFrame, position));
      else this.weight = this.fade.refresh(position) ?? 1;
      if (wanted > this.shown.frame && this.pipeline.producedThrough <= wanted) this.stats.late += 1;
    }
    if (this.shown) {
      if (this.weight >= 1 && this.from && this.from !== this.idleTexture && this.from !== this.shown.texture) {
        for (const [f, c] of this.composed) if (c.texture === this.from) this.composed.delete(f);
        this.from = undefined;
      }
      this.compositor.present(this.from ?? this.shown.texture, this.shown.texture, this.from ? this.weight : 1);
    } else {
      this.drawIdle(); this.compositor.present(this.idleTexture, this.idleTexture, 1);
    }
    // The reply is over once its audio has played and its last frame is on screen.
    if (this.drained && this.ended && this.shown && this.shown.frame >= this.pipeline.producedThrough - 1 && this.composed.size <= 1) {
      this.startStall();
    }
  }

  private startStall(): void {
    if (this.mode === "speech") post({ type: "utterance", utterance: this.utterance, shown: this.utteranceShown, late: this.utteranceLate });
    this.mode = "stall"; this.lastStallAt = performance.timeOrigin + performance.now();
    this.stallPosition = 0;
    if (!this.shown) { this.mode = "idle"; return; }
    // The stall walk continues from the frame on screen: drop what was rendered past it.
    this.pipeline.rewindTo(this.shown.frame);
  }

  private stallStep(now: number): void {
    const shown = this.shown;
    if (!shown) { this.mode = "idle"; return; }
    const position = (now - this.lastStallAt) * 24;
    if (this.from && this.from !== shown.texture) {
      this.weight = Math.min(1, Math.max(this.weight, position / SAMPLES_PER_FRAME));
    } else this.weight = 1;
    this.compositor.present(this.from ?? shown.texture, shown.texture, this.weight);
    if (this.stallBusy || position < SAMPLES_PER_FRAME) return;
    this.stallBusy = true;
    const utterance = this.utterance;
    void (async () => {
      try {
        const job = await this.pipeline.stallImage(shown.frame);
        if (utterance !== this.utterance || this.mode !== "stall") return;
        if (!job || !job.holdsSpeech) { this.settle(job); return; }
        const composed = await this.composeJob(job);
        this.from = shown.texture; this.shown = { ...composed, frame: shown.frame }; this.lastHost = composed.host;
        this.weight = 0; this.lastStallAt = performance.timeOrigin + performance.now();
      } catch (error) {
        if (!(error instanceof CancelledError)) this.fail(error);
      } finally { this.stallBusy = false; }
    })();
  }

  /** Hand over to the still idle face: fade into it from the picture on screen. */
  private settle(job: FrameJob | undefined): void {
    if (job) this.lastHost = job.host;
    this.from = this.shownTexture(); this.mode = "settle"; this.settleStart = performance.timeOrigin + performance.now();
  }

  /** The still idle face with its blink at this moment (IdleBlinkSchedule on wall time). */
  private drawIdle(force = false): void {
    const picture = this.idleSchedule.picture((performance.now() - this.loadedAt) / 1000);
    if (!force && picture === this.idlePicture) return;
    this.idlePicture = picture;
    const blink = picture !== undefined ? this.blinkTextures[picture] : undefined;
    this.compositor.compose(this.idleTexture, { still: this.stillTexture }, undefined, blink, [0, 0]);
  }

  statsSnapshot(): FTStats {
    const s = this.pipeline?.stats;
    return { ...this.stats, loadTimings: this.loadTimings, renders: s?.renders ?? 0, encodes: s?.encodes ?? 0, standInEncodes: s?.standInEncodes ?? 0,
      encodeMs: s?.encodeMs ?? 0, renderMs: s?.renderMs ?? 0, hostDecodeMs: this.decoder?.decodeMs ?? 0,
      hostGroups: this.decoder?.groupsDecoded ?? 0 };
  }

  // --- Offline (parity) ---------------------------------------------------------------------------------------------

  /** Composes every frame after each append, as the iOS probe does (`AvatarModelProbe --stream`). */
  private offlineQueue: Promise<void> = Promise.resolve();
  offlineFlush(): Promise<void> {
    // One flush at a time, in message order: frames are composed and captured strictly in order.
    this.offlineQueue = this.offlineQueue.then(async () => {
      await this.chain;
      this.pumping = true;
      try { await this.pumpNow(); } finally { this.pumping = false; }
    });
    return this.offlineQueue;
  }

  fail(error: unknown): void {
    if (error instanceof CancelledError) return;
    post({ type: "error", message: error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack}` : ""}` : String(error) });
  }
}

let runtime: Runtime | undefined;
// Messages are handled one after another: the pack loads before any speech, and an offline run's packets are each
// rendered and composed before the next.
let inbox: Promise<void> = Promise.resolve();
scope.onmessage = (event: MessageEvent<FTMainToWorker>) => {
  const message = event.data;
  inbox = inbox.then(() => handle(message));
};

async function handle(message: FTMainToWorker): Promise<void> {
  try {
    switch (message.type) {
      case "init":
        runtime = new Runtime();
        await runtime.load(message.source, message.canvas, message.options);
        break;
      case "begin": runtime?.begin(message.utterance); break;
      case "audio":
        runtime?.audio(message.utterance, message.samples);
        if (runtime?.isOffline) await runtime.offlineFlush();
        break;
      case "end":
        runtime?.end(message.utterance);
        if (runtime?.isOffline) {
          await runtime.offlineFlush();
          post({ type: "offline-done", frames: runtime.statsSnapshot().composed, stats: runtime.statsSnapshot() });
        }
        break;
      case "clock": runtime?.clock(message.utterance, message.samples, message.at, message.started); break;
      case "drained": runtime?.drainedAudio(message.utterance); break;
      case "cancel": runtime?.cancel(); break;
      case "grant": runtime?.grant(message.downloadToken); break;
      case "stats": if (runtime) post({ type: "stats", stats: runtime.statsSnapshot() }); break;
    }
  } catch (error) {
    runtime?.fail(error) ?? post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}
