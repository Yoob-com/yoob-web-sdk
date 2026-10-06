/// <reference lib="webworker" />
import {
  RES, SERVE320_BUNDLE_ASSET_PATHS, Serve320Bundle,
} from "../assets/serve320-bundle";
import {
  RuntimeAssetStore, type RuntimeAssetConfig, type RuntimeAssetEvent,
} from "../assets/runtime-store";
import {
  chinWarp, finishFrame, resizeBilinearU8Hwc3,
} from "../compositor/serve320-compositor";
import { resizeBilinearFloat } from "../compositor/image-ops";
import { RendererRuntime } from "../inference/renderer";
import { setOrtWasmUrl } from "../inference/ort-runtime";
import {
  apertureFromGeometry,
  centerPointsX,
  decodePointsFromGeometry,
  r2bBlend,
  r2bGate,
  reconstructGeometry,
  type Point,
} from "../math/geometry";
import {
  APPEARANCE_HYSTERESIS_MARGIN,
  alignReference, appearanceCodebookRow, planarBgrToRgb01,
} from "../math/reference";
import {
  FrameScratch,
  planarBgrToHwcInto,
  restoreHeldPrediction,
} from "./frame-scratch";
import {
  CompositePool, OrderedCompositeFinalizer, resolvedCompositorWorkerCount,
} from "./composite-pool";
import { AudioGeometryClient } from "./audio-geometry-client";
import type { PreparedAudioGeometry } from "./audio-geometry-protocol";
import type { MainToWorker, WorkerToMain } from "./protocol";
import {
  RENDERER_STEADY_STATE_PASSES,
  interruptsRendererPrewarm,
  remainingRendererPrewarmPasses,
} from "./render-prewarm";
import type {
  RendererInputType, RendererPreferredLayout, RendererSpatialContract,
} from "./generated/runtime-tier-contract";
import {
  NEURAL_MOUTH_RENDER_STRIDE, neuralMouthRenderStride, shouldRunNeuralMouth,
  type NeuralMouthRenderStride,
} from "./render-cadence";
import {
  FULL320_RENDERER_SPATIAL_CONTRACT,
  isFull320RendererContract,
  resolveRendererSpatialContract,
} from "./renderer-contract";
import {
  buildRendererInput,
  expandRendererOutputToFullBgrInto,
  rendererSupportMultiplier,
} from "./renderer-spatial";
import {
  NativeRoiPostprocessor,
  resolveRendererTemporalContract,
  type RendererTemporalContract,
} from "./renderer-temporal";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let bundle: Serve320Bundle | undefined;
let audioGeometry: AudioGeometryClient | undefined;
let renderer: RendererRuntime | undefined;
let compositePool: CompositePool | undefined;
let compositorWorkerOverride: number | undefined;
let runtimeConfig: RuntimeAssetConfig | undefined;
let runtimeNeuralMouthStride: NeuralMouthRenderStride = NEURAL_MOUTH_RENDER_STRIDE;
let runtimeRendererInputType: RendererInputType = "float32";
let runtimeRendererPreferredLayout: RendererPreferredLayout = "NCHW";
let runtimeRendererSpatialContract: RendererSpatialContract =
  FULL320_RENDERER_SPATIAL_CONTRACT;
let runtimeRendererSupportMultiplier: Float32Array | undefined;
let runtimeRendererTemporalContract: RendererTemporalContract | undefined;
let runtimeNativeRoiPostprocessor: NativeRoiPostprocessor | undefined;
let currentEpoch = 0;
// Retrieval hysteresis state. MODULE scope, not a local: prepareWindow() runs
// once per audio CHUNK, so a local would reset the exemplar at every chunk
// boundary and hand back most of the switching the margin removes — and it is
// the module-scope configuration the windowed seam arm was measured under. The
// epoch guard drops it per turn so a new reply never inherits the last one's
// mouth, which is what serve does (switch rates are counted within-reply).
let previousCodebookRow = -1;
let previousCodebookEpoch = -1;
let referenceRgb: Float32Array[] = [];
let scratch: FrameScratch | undefined;
const MODEL_ASSET_PATHS = [
  "models/featherhubert1024_fp16.onnx",
  "models/serve320_geometry_dynamic_fp16.onnx",
  "models/serve320_renderer_c32_fp16.onnx",
] as const;
const WORKER_ASSET_PATHS = [...SERVE320_BUNDLE_ASSET_PATHS, ...MODEL_ASSET_PATHS];

function post(message: WorkerToMain, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer);
}

async function packedCompositeBitmap(
  predBgr: Uint8Array,
  support: Float32Array,
  jawProtected: Uint8Array,
  width: number,
  height: number,
): Promise<ImageBitmap | undefined> {
  try {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let pixel = 0, out = 0, bgr = 0;
      pixel < support.length; pixel += 1, out += 4, bgr += 3) {
      const weight = jawProtected[pixel] ? 0 : support[pixel];
      rgba[out] = predBgr[bgr + 2];
      rgba[out + 1] = predBgr[bgr + 1];
      rgba[out + 2] = predBgr[bgr];
      rgba[out + 3] = weight <= 0 ? 0 : (weight >= 1 ? 255 : (weight * 255) | 0);
    }
    return await createImageBitmap(new ImageData(rgba, width, height));
  } catch {
    return undefined;
  }
}

function ensureCurrent(epoch: number): void {
  if (epoch !== currentEpoch) throw new DOMException("stale render generation", "AbortError");
}

async function supervised<T>(
  label: string,
  stage: string,
  operation: () => Promise<T>,
  timeoutMs = 120_000,
): Promise<T> {
  const started = performance.now();
  const heartbeat = setInterval(() => {
    post({
      type: "status",
      message: `${label} · ${Math.round((performance.now() - started) / 1000)}s elapsed`,
      stage,
    });
  }, 5_000);
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)),
        timeoutMs,
      )),
    ]);
  } finally {
    clearInterval(heartbeat);
  }
}

async function initialize(): Promise<void> {
  if (bundle && audioGeometry && renderer) {
    post({ type: "initialized", nIdle: bundle.nIdle });
    return;
  }
  if (!runtimeConfig) throw new Error("runtime configuration was not supplied");
  const started = performance.now();
  let runtimeBytes = 0;
  const assetEvent = (event: RuntimeAssetEvent) => post({
    type: "status",
    message: event.message,
    level: event.level,
    stage: "download",
    path: event.path,
    progress: runtimeBytes > 0 && event.aggregateLoaded !== undefined
      ? Math.min(1, event.aggregateLoaded / runtimeBytes) : undefined,
    loadedBytes: event.aggregateLoaded,
    totalBytes: runtimeBytes || event.aggregateTotal,
    cached: event.cached,
    elapsedMs: event.elapsedMs,
  });
  const store = new RuntimeAssetStore(runtimeConfig, assetEvent);
  const manifest = await store.initialize();
  // Prefer packed bank siblings when present (compact runtime); fall back to
  // the classic raw bins. Progress total only counts files that exist.
  const progressPaths = [
    ...WORKER_ASSET_PATHS.filter((path) => manifest.files[path]),
    ...[
      "bundle/idle_contours320.scntz",
      "bundle/idle_crops320.scpk",
      "bundle/ref_crops320.scntz",
    ].filter((path) => manifest.files[path]),
  ];
  runtimeBytes = progressPaths.reduce(
    (sum, path) => sum + (manifest.files[path]?.bytes ?? 0), 0,
  );
  post({ type: "status", message: "Downloading and verifying avatar runtime…",
    stage: "download", progress: 0 });
  const featherBytes = store.bytes("models/featherhubert1024_fp16.onnx");
  const geometryBytes = store.bytes("models/serve320_geometry_dynamic_fp16.onnx");
  const rendererBytes = store.bytes("models/serve320_renderer_c32_fp16.onnx");
  // Overlap avatar table download with model session open. Bundle tables are
  // only required for warmup compositing and the first prepare — ORT sessions
  // need only their weight bytes.
  const bundleLoading = Serve320Bundle.load(store);
  post({ type: "status", message: "Opening isolated audio + geometry worker…",
    stage: "opening" });
  const [featherModel, geometryModel] = await Promise.all([featherBytes, geometryBytes]);
  // The store has handed them over; it must not keep a copy. These two are transferred to the audio+geometry worker
  // below, which detaches them here, so there is nothing left to overwrite on this side.
  for (const path of MODEL_ASSET_PATHS.slice(0, 2)) store.release(path);
  audioGeometry = await supervised(
    "Opening audio + geometry worker",
    "opening",
    () => AudioGeometryClient.create(
      featherModel,
      geometryModel,
      (message, stage) => post({ type: "status", message, stage }),
      runtimeConfig?.ortWasmUrl,
    ),
  );
  post({
    type: "status",
    message: "Audio + geometry worker open · isolated WASM lane",
    level: "success",
    stage: "opening",
  });
  scratch = new FrameScratch(runtimeRendererSpatialContract);
  const warning = (message: string) => post({
    type: "status", message, level: "warning", stage: "opening",
  });
  const rendererLabel = isFull320RendererContract(runtimeRendererSpatialContract)
    ? "full-canvas 320x320 renderer"
    : `${runtimeRendererSpatialContract.inputWidth}x`
      + `${runtimeRendererSpatialContract.inputHeight} ROI renderer @ `
      + `${runtimeRendererSpatialContract.originX},${runtimeRendererSpatialContract.originY}`;
  post({ type: "status", message: `Opening ${rendererLabel} · WebGPU-first…`,
    stage: "opening" });
  const rendererModel = new Uint8Array(await rendererBytes);
  renderer = await supervised(
    `Opening ${rendererLabel}`,
    "opening",
    () => RendererRuntime.load(
      rendererModel,
      warning,
      (message) => post({ type: "status", message, stage: "opening" }),
      runtimeRendererInputType,
      runtimeRendererPreferredLayout,
      runtimeRendererSpatialContract,
    ),
  );
  // ORT holds its own copy now. Drop ours and overwrite it: the weights stay in the runtime's memory for the session
  // either way, but there is no reason to leave a second readable copy on the JS heap.
  store.release("models/serve320_renderer_c32_fp16.onnx");
  rendererModel.fill(0);
  post({
    type: "status",
    message: `Renderer open${renderer.graphCaptureEnabled ? " · graph capture" : ""}`
      + ` · ${runtimeRendererInputType} input · ${renderer.activeLayout} layout`
      + (isFull320RendererContract(runtimeRendererSpatialContract) ? ""
        : ` · ${runtimeRendererSpatialContract.inputWidth}x`
          + `${runtimeRendererSpatialContract.inputHeight} ROI @ `
          + `${runtimeRendererSpatialContract.originX},${runtimeRendererSpatialContract.originY}`),
    level: "success",
    stage: "opening",
  });
  // Model warmups do not need host tables; run them while the remaining
  // idle_crops / contours download finishes.
  post({ type: "status", message: "Warming renderer…", stage: "warming" });
  // The renderer warmup records WebGPU graph capture in this worker. The WASM
  // sessions are already warm in their own worker and cannot contend with the
  // renderer's ORT-Web global device/JSEP state.
  const warming = supervised(
    "Warming renderer", "warming", () => renderer!.warmup(scratch!.rendererInput),
  ).then(() => {
    // Once graph capture is safely recorded, grind its steady-state passes in
    // parallel with the WASM warmups, remaining bundle download, and compositor
    // worker startup. This absorbs cold GPU work before the controls become
    // clickable without adding it to the critical loading path.
    void prewarmRendererSteadyState();
  });
  bundle = await bundleLoading;
  post({ type: "status", message: "All runtime downloads verified",
    level: "success", stage: "download", progress: 1,
    loadedBytes: runtimeBytes, totalBytes: runtimeBytes });
  referenceRgb = Array.from({ length: 30 }, (_, row) => planarBgrToRgb01(bundle!.refCrop(row)));
  await warming;
  // Fan the CPU QA9 compositor (the pipeline's dominant per-frame cost) across a
  // pool of workers so it overlaps the serial WebGPU renderer. Output is
  // byte-identical; failure falls back to the inline single-thread path.
  try {
    const cores = (self.navigator?.hardwareConcurrency ?? 4);
    const requestedPoolSize = compositorWorkerOverride ?? Math.max(1, Math.min(8, cores - 2));
    // QA9 remains parallel even when temporal correction is enabled. Stateful
    // ROI finalization is chained in frame order after each worker result.
    const poolSize = resolvedCompositorWorkerCount(
      requestedPoolSize,
      runtimeRendererTemporalContract !== undefined,
    );
    if (poolSize >= 1) {
      post({ type: "status", message: `Starting ${poolSize} compositor workers…`, stage: "warming" });
      compositePool = await CompositePool.create(
        poolSize,
        bundle.support,
        bundle.hole,
        runtimeRendererSupportMultiplier,
        runtimeRendererSpatialContract,
        runtimeRendererTemporalContract,
      );
      post({
        type: "status", message: `Compositor pool ready · ${poolSize} workers`,
        level: "success", stage: "warming",
      });
    } else {
      compositePool = undefined;
      post({
        type: "status", message: "Compositor pool disabled; inline single-thread path",
        level: "warning", stage: "warming",
      });
    }
  } catch (error) {
    compositePool = undefined;
    post({
      type: "status",
      message: `Compositor pool unavailable; inline path · ${
        error instanceof Error ? error.message : String(error)}`,
      level: "warning", stage: "warming",
    });
  }
  post({ type: "status", message: `Runtime ready in ${((performance.now() - started) / 1000)
    .toFixed(1)}s`, level: "success", stage: "ready", progress: 1 });
  post({ type: "initialized", nIdle: bundle.nIdle });
  void prewarmRendererSteadyState();
}

/**
 * Absorb the renderer's warm-up cliff while the page is idle.
 *
 * Measured: the first ~250 passes run at 34.2-44.3 ms (whole pipeline 8-13 fps);
 * every run afterwards holds 23.9-24.2 ms and 30.1-30.6 fps. That cliff is
 * ORT-Web WebGPU pipeline compilation plus GPU clock ramp, and it lasts about
 * one conversational turn, so it lands squarely on the user's first reply.
 *
 * Deliberately started AFTER `initialized`: paying it before would move ~10 s of
 * wait onto the loading screen instead of removing it. Renderer work yields it;
 * unfinished passes resume after a complete render/stream, not in the short
 * gaps between live PCM buckets. Epoch-only cancellation (for example VAD
 * opening while the user speaks) does not touch the GPU and therefore must not
 * throw away the remaining warm-up.
 */
let prewarmActive = false;
let prewarmStopRequested = false;
let prewarmResumeScheduled = false;
let prewarmFailed = false;
let rendererPasses = 0;
let queuedRenderTasks = 0;
let geometryPreparationsInFlight = 0;
let streamingRenderActive = false;
let rendererSteadyReported = false;

function reportRendererSteadyState(meanMs?: number): void {
  if (rendererSteadyReported
      || rendererPasses < RENDERER_STEADY_STATE_PASSES) return;
  rendererSteadyReported = true;
  post({
    type: "status",
    message: `Renderer steady · ${rendererPasses} passes`
      + (meanMs === undefined ? "" : ` · ${meanMs.toFixed(1)} ms/prewarm frame`),
    level: "success",
    stage: "ready",
  });
}

function scheduleRendererPrewarm(): void {
  if (prewarmResumeScheduled || prewarmActive || prewarmFailed
      || queuedRenderTasks > 0 || streamingRenderActive
      || remainingRendererPrewarmPasses(rendererPasses) === 0) return;
  prewarmResumeScheduled = true;
  setTimeout(() => {
    prewarmResumeScheduled = false;
    if (queuedRenderTasks > 0 || streamingRenderActive || prewarmFailed
        || remainingRendererPrewarmPasses(rendererPasses) === 0) return;
    prewarmStopRequested = false;
    void prewarmRendererSteadyState();
  }, 0);
}

async function prewarmRendererSteadyState(): Promise<void> {
  if (!renderer || !scratch || prewarmActive || prewarmFailed) return;
  const remaining = remainingRendererPrewarmPasses(rendererPasses);
  if (remaining === 0) {
    reportRendererSteadyState();
    return;
  }
  prewarmActive = true;
  try {
    const started = performance.now();
    const done = await renderer.prewarmSteadyState(
      scratch.rendererInput,
      remaining,
      () => prewarmStopRequested,
    );
    rendererPasses += done;
    if (done > 0) {
      const each = (performance.now() - started) / done;
      reportRendererSteadyState(each);
    } else if (!prewarmStopRequested) {
      prewarmFailed = true;
    }
  } catch {
    // A prewarm failure must never affect the session — it is pure optimisation.
    prewarmFailed = true;
  } finally {
    prewarmActive = false;
    scheduleRendererPrewarm();
  }
}

interface PrepareWindow {
  epoch: number;
  pcmBuffer: ArrayBuffer;
  frameOffset: number;
  discardFrames: number;
  outputFrames?: number;
  chunkIndex?: number;
  final: boolean;
  /** BiGRU silence-tail padding; defaults to `final`. */
  geometryFinal?: boolean;
  bootstrap?: boolean;
}

interface PreparedWindow {
  options: PrepareWindow;
  geometry: PreparedAudioGeometry;
}

interface RenderWindowPressure {
  compositorCapacity: number;
  maxCompositorInFlight: number;
}

async function prepareGeometry(options: PrepareWindow): Promise<PreparedWindow> {
  if (!audioGeometry) {
    throw new Error("avatar runtime is not initialized");
  }
  const {
    epoch, pcmBuffer, frameOffset, discardFrames, chunkIndex, final,
  } = options;
  ensureCurrent(epoch);
  const prepared = await audioGeometry.prepare({
    epoch,
    pcmBuffer,
    discardFrames,
    outputFrames: options.outputFrames,
    geometryFinal: options.geometryFinal ?? final,
    bootstrap: options.bootstrap ?? false,
  });
  ensureCurrent(epoch);
  if (chunkIndex === undefined) {
    post({
      type: "geometry-ready",
      epoch,
      frameCount: prepared.outputFrames,
      audioSamples: prepared.audioSamples,
    });
  } else {
    post({
      type: "chunk-geometry-ready",
      epoch,
      chunkIndex,
      frameOffset,
      frameCount: prepared.outputFrames,
      final,
    });
  }
  return { options, geometry: prepared };
}

async function renderPreparedWindow(prepared: PreparedWindow): Promise<RenderWindowPressure> {
  if (!bundle || !renderer || !scratch) {
    throw new Error("avatar runtime is not initialized");
  }
  const B = bundle!, R = renderer!, S = scratch!;
  const { options, geometry: preparedGeometry } = prepared;
  const {
    epoch, frameOffset, discardFrames, chunkIndex, final,
  } = options;
  const {
    pred6, contactLogit, outputFrames, featherMs, geometryMs,
  } = preparedGeometry;
  const predicted = { pred6, contactLogit };
  ensureCurrent(epoch);
  const renderPhaseStarted = performance.now();
  const neuralAt = (localIndex: number) =>
    shouldRunNeuralMouth(frameOffset + localIndex, runtimeNeuralMouthStride);
  let pendingRun: Promise<Float32Array> | undefined;
  let pendingNeuralFrame = -1;
  let pendingRunStarted = 0;
  let snapshotHostIndex = -1;
  let snapshotOpen = 0;
  let fillMs = 0;
  let waitMs = 0;
  let runMs = 0;
  let compositorMs = 0;
  let neuralRuns = 0;
  const pool = compositePool;
  const inflight = new Set<Promise<void>>();
  const temporalFinalizer = new OrderedCompositeFinalizer();
  const temporalFullSupport = runtimeRendererTemporalContract
    ? new Float32Array(
      runtimeRendererSpatialContract.baseWidth * runtimeRendererSpatialContract.baseHeight,
    ) : undefined;
  const temporalRoiPrediction = runtimeRendererTemporalContract
    ? new Uint8Array(
      runtimeRendererSpatialContract.inputWidth * runtimeRendererSpatialContract.inputHeight * 3,
    ) : undefined;
  const capacity = pool ? Math.max(4, pool.size * 4) : 1;
  let maxCompositorInFlight = 0;
  const track = (task: Promise<void>): void => {
    const wrapped = task.finally(() => { inflight.delete(wrapped); });
    inflight.add(wrapped);
    maxCompositorInFlight = Math.max(maxCompositorInFlight, inflight.size);
  };

  const dispatchNeural = (localIndex: number): void => {
    const started = performance.now();
    const modelIndex = discardFrames + localIndex;
    const globalIndex = frameOffset + localIndex;
    const hostIndex = globalIndex % B.nIdle;
    const scores = predicted.pred6.subarray(modelIndex * 6, modelIndex * 6 + 6);
    reconstructGeometry(scores, B.pca, S.geom40);
    const open = apertureFromGeometry(S.geom40);
    planarBgrToHwcInto(B.idleCrop(hostIndex), S.hostHwc);
    const contour = B.contour(hostIndex);
    const warpedHost = chinWarp(S.hostHwc, contour, open, 198, S.warpedHost);
    const anchor = B.anchor(hostIndex);
    decodePointsFromGeometry(S.geom40, anchor, S.pointsA);
    r2bBlend(S.pointsA, r2bGate(predicted.contactLogit[modelIndex]), 0.9, S.pointsB);
    const hostCenter = B.mouthCenter(hostIndex) as Point;
    const points = centerPointsX(S.pointsB, hostCenter[0], S.pointsC);
    if (previousCodebookEpoch !== currentEpoch) {
      previousCodebookEpoch = currentEpoch;
      previousCodebookRow = -1;
    }
    // Hysteresis is DISABLED under reduced cadence, and the sign of the effect
    // is why. temporal_ratio is two-sided. At stride 1 the candidate moves MORE
    // than ground truth (+0.08168 pooled log), so removing motion moves it
    // toward GT: 0.95240x, an improvement. Under stride 2 the pixel hold has
    // already removed real mouth motion, so the candidate moves LESS than GT
    // (-0.17967); removing more moves it AWAY: 1.07229x, a significant 7.2%
    // regression (paired cboot +0.01399, CI [+0.00517, +0.02531], better on
    // only 11/54 clips). mouth_lowpass_mae also regresses significantly. Every
    // gate still passes -- 1.07229 is inside the 1.10 tolerance -- so this is
    // net harm rather than a gate failure, and it would have gone unnoticed.
    //
    // Isolated: with the stride-2 RETRIEVAL stream but full presentation,
    // temporal is 0.95310x, indistinguishable from stride 1. The halved
    // retrieval rate is near-harmless; the PIXEL HOLD flips the sign. So the
    // right condition is the presentation stride, not the retrieval rate.
    //
    // Margin 0 is bit-identical to memoryless selection (contract test, 22,456
    // triples), so the fast tier returns to exactly the behaviour it shipped
    // with. cbhyst-fast-20260730, prereg sha256 1d87a9aa.
    const row = appearanceCodebookRow(
      scores, open, B, previousCodebookRow,
      runtimeNeuralMouthStride > 1 ? 0 : APPEARANCE_HYSTERESIS_MARGIN,
    );
    previousCodebookRow = row;
    reconstructGeometry(B.refGeometry(row), B.pca, S.geom40Ref);
    decodePointsFromGeometry(S.geom40Ref, B.refAnchor(row), S.refPoints);
    const aligned = alignReference(
      referenceRgb[row], S.refPoints, points, S.alignedReference,
    );
    buildRendererInput(
      warpedHost,
      aligned,
      points,
      B.hole,
      S.rendererInput,
      S,
      runtimeRendererSpatialContract,
    );
    S.neuralHostSnapshot.set(S.hostHwc);
    S.neuralRendererHostSnapshot?.set(warpedHost);
    for (let point = 0; point < points.length; point += 1) {
      S.neuralPointSnapshot[point][0] = points[point][0];
      S.neuralPointSnapshot[point][1] = points[point][1];
    }
    snapshotHostIndex = hostIndex;
    snapshotOpen = open;
    fillMs += performance.now() - started;
    pendingRunStarted = performance.now();
    pendingRun = R.run(S.rendererInput, S.rendererOutput);
    pendingRun.catch(() => undefined);
    pendingNeuralFrame = localIndex;
  };

  let firstNeural = -1;
  for (let index = 0; index < outputFrames; index += 1) {
    if (neuralAt(index)) {
      firstNeural = index;
      break;
    }
  }
  if (firstNeural >= 0) dispatchNeural(firstNeural);

  try {
    for (let localIndex = 0; localIndex < outputFrames; localIndex += 1) {
      ensureCurrent(epoch);
      const started = localIndex === 0 ? renderPhaseStarted : performance.now();
      const modelIndex = discardFrames + localIndex;
      const globalIndex = frameOffset + localIndex;
      const isPendingNeural = localIndex === pendingNeuralFrame;
      let hostIndex: number;
      let host: Uint8Array;
      let open: number;
      let points: Point[];
      if (isPendingNeural) {
        const waitStarted = performance.now();
        await pendingRun;
        waitMs += performance.now() - waitStarted;
        runMs += performance.now() - pendingRunStarted;
        neuralRuns += 1;
        rendererPasses += 1;
        reportRendererSteadyState();
        pendingRun = undefined;
        pendingNeuralFrame = -1;
        ensureCurrent(epoch);
        expandRendererOutputToFullBgrInto(
          S.rendererOutput,
          S.neuralRendererHostSnapshot ?? S.neuralHostSnapshot,
          S.heldPredictionBgr,
          runtimeRendererSpatialContract,
        );
        hostIndex = snapshotHostIndex;
        host = S.neuralHostSnapshot;
        open = snapshotOpen;
        points = S.neuralPointSnapshot;
      } else {
        hostIndex = globalIndex % B.nIdle;
        const scores = predicted.pred6.subarray(modelIndex * 6, modelIndex * 6 + 6);
        reconstructGeometry(scores, B.pca, S.geom40);
        open = apertureFromGeometry(S.geom40);
        planarBgrToHwcInto(B.idleCrop(hostIndex), S.hostHwc);
        host = S.hostHwc;
        const anchor = B.anchor(hostIndex);
        decodePointsFromGeometry(S.geom40, anchor, S.pointsA);
        r2bBlend(
          S.pointsA, r2bGate(predicted.contactLogit[modelIndex]), 0.9, S.pointsB,
        );
        const hostCenter = B.mouthCenter(hostIndex) as Point;
        points = centerPointsX(S.pointsB, hostCenter[0], S.pointsC);
      }
      const contour = B.contour(hostIndex);
      const anchor = B.anchor(hostIndex);
      const hostCenter = B.mouthCenter(hostIndex) as Point;
      const boxView = B.box(hostIndex);
      const box: [number, number, number, number] = [
        boxView[0], boxView[1], boxView[2], boxView[3],
      ];
      const width = box[2] - box[0], height = box[3] - box[1];

      if (pool) {
        // Per-job copies of the reused scratch/bundle views. The prediction is
        // copied from the immutable held neural crop, so each pool worker's
        // in-place tone correction acts on its own frame only — held frames can
        // never accumulate shifts. Copies must complete before the next neural
        // dispatch below overwrites the snapshot buffers.
        const predCopy = new Uint8Array(S.heldPredictionBgr);
        const hostCopy = new Uint8Array(host);
        const rendererHostSource = S.neuralRendererHostSnapshot;
        const workerRendererHost = !runtimeRendererTemporalContract && rendererHostSource
          ? new Uint8Array(rendererHostSource) : undefined;
        let temporalRendererHost: Uint8Array | undefined;
        if (runtimeRendererTemporalContract && rendererHostSource) {
          const spatial = runtimeRendererSpatialContract;
          temporalRendererHost = new Uint8Array(
            spatial.inputWidth * spatial.inputHeight * 3,
          );
          for (let y = 0; y < spatial.inputHeight; y += 1) {
            const global = ((spatial.originY + y) * spatial.baseWidth + spatial.originX) * 3;
            const local = y * spatial.inputWidth * 3;
            temporalRendererHost.set(
              rendererHostSource.subarray(global, global + spatial.inputWidth * 3),
              local,
            );
          }
        }
        const temporalPoints: Point[] | undefined = runtimeRendererTemporalContract
          ? points.map(([x, y]) => [x, y] as Point) : undefined;
        const contourCopy = new Uint8Array(contour);
        const flatPoints = new Float64Array(40);
        for (let p = 0; p < 20; p += 1) {
          flatPoints[p * 2] = points[p][0];
          flatPoints[p * 2 + 1] = points[p][1];
        }
        const renderMs = performance.now() - started;
        const compositeResult = pool.submit(
          {
            epoch,
            index: globalIndex,
            predBgr: predCopy.buffer as ArrayBuffer,
            host: hostCopy.buffer as ArrayBuffer,
            ...(workerRendererHost
              ? { rendererHost: workerRendererHost.buffer as ArrayBuffer }
              : {}),
            contour: contourCopy.buffer as ArrayBuffer,
            points: flatPoints,
            aperture: open,
            hostCenterX: hostCenter[0],
            hostCenterY: hostCenter[1],
            anchorWidth: anchor[2],
            hostLipY: B.hostLipY[hostIndex],
            box,
            renderMs,
          },
          [
            predCopy.buffer,
            hostCopy.buffer,
            contourCopy.buffer,
            flatPoints.buffer,
            ...(workerRendererHost ? [workerRendererHost.buffer] : []),
          ],
        );
        if (runtimeRendererTemporalContract) {
          const finalize = temporalFinalizer.enqueue(compositeResult, async (result) => {
            const temporalStarted = performance.now();
            compositorMs += result.compositorMs;
            if (epoch !== currentEpoch) return;
            if (!result.preparedPrediction || !result.roiSupport
                || !temporalRendererHost || !temporalPoints || !runtimeNativeRoiPostprocessor
                || !temporalFullSupport || !temporalRoiPrediction) {
              throw new Error("temporal compositor result is incomplete");
            }
            const spatial = runtimeRendererSpatialContract;
            const fullPrediction = new Uint8Array(result.preparedPrediction);
            for (let y = 0; y < spatial.inputHeight; y += 1) {
              const global = ((spatial.originY + y) * spatial.baseWidth + spatial.originX) * 3;
              const local = y * spatial.inputWidth * 3;
              temporalRoiPrediction.set(
                fullPrediction.subarray(global, global + spatial.inputWidth * 3),
                local,
              );
            }
            const finalized = runtimeNativeRoiPostprocessor.applyPacked(
              temporalRoiPrediction,
              temporalRendererHost,
              new Float32Array(result.roiSupport),
              temporalPoints,
              epoch,
              result.index,
            );
            temporalFullSupport.fill(0);
            for (let y = 0; y < spatial.inputHeight; y += 1) {
              const globalPixel = (spatial.originY + y) * spatial.baseWidth + spatial.originX;
              const localPixel = y * spatial.inputWidth;
              fullPrediction.set(
                finalized.prediction.subarray(
                  localPixel * 3,
                  (localPixel + spatial.inputWidth) * 3,
                ),
                globalPixel * 3,
              );
              temporalFullSupport.set(
                finalized.support.subarray(localPixel, localPixel + spatial.inputWidth),
                globalPixel,
              );
            }
            const targetPixels = result.width * result.height;
            const predOut = new Uint8Array(targetPixels * 3);
            const supportOut = new Float32Array(targetPixels);
            resizeBilinearU8Hwc3(
              fullPrediction, RES, RES, result.width, result.height, predOut,
            );
            resizeBilinearFloat(
              temporalFullSupport, RES, RES, result.width, result.height, supportOut,
            );
            const jawProtected = new Uint8Array(result.jawProtected);
            const bitmap = await packedCompositeBitmap(
              predOut, supportOut, jawProtected, result.width, result.height,
            );
            const predBuffer = predOut.buffer as ArrayBuffer;
            const supportBuffer = supportOut.buffer as ArrayBuffer;
            const jawBuffer = jawProtected.buffer as ArrayBuffer;
            const frameTransfer: Transferable[] = [predBuffer, supportBuffer, jawBuffer];
            if (bitmap) frameTransfer.push(bitmap);
            post({
              type: "frame", epoch, index: result.index, box: result.box,
              width: result.width, height: result.height,
              predBgr: predBuffer, support: supportBuffer,
              jawProtected: jawBuffer, bitmap,
              renderMs: result.renderMs + performance.now() - temporalStarted,
            }, frameTransfer);
            compositorMs += performance.now() - temporalStarted;
          });
          track(finalize);
        } else {
          track(compositeResult.then((result) => {
            compositorMs += result.compositorMs;
            if (epoch !== currentEpoch) return;
            const frameTransfer: Transferable[] = [
              result.predBgr, result.support, result.jawProtected,
            ];
            if (result.bitmap) frameTransfer.push(result.bitmap);
            post({
              type: "frame", epoch, index: result.index, box: result.box,
              width: result.width, height: result.height,
              predBgr: result.predBgr, support: result.support,
              jawProtected: result.jawProtected, bitmap: result.bitmap,
              renderMs: result.renderMs,
            }, frameTransfer);
          }));
        }
        if (isPendingNeural) {
          for (let next = localIndex + 1; next < outputFrames; next += 1) {
            if (neuralAt(next)) {
              // Dispatch now so WebGPU overlaps the pool's CPU compositing.
              dispatchNeural(next);
              break;
            }
          }
        }
        if (inflight.size >= capacity) await Promise.race(inflight);
        continue;
      }

      const targets = S.ensureTarget(width, height);
      // finishFrame performs in-place tone correction. Always restore from the
      // immutable held neural crop so stride frames cannot accumulate shifts.
      restoreHeldPrediction(S.heldPredictionBgr, S.predictionBgr);
      const compositorStarted = performance.now();
      const finished = finishFrame(
        S.predictionBgr, host, contour, points, open, hostCenter,
        anchor[2], B.hostLipY[hostIndex], B, width, height,
        {
          predBgr: targets.predBgr,
          support: targets.support,
          supportMultiplier: runtimeRendererSupportMultiplier,
          nativeRoiPostprocess: runtimeNativeRoiPostprocessor
            ? (prediction, support) => {
              const rendererHost = S.neuralRendererHostSnapshot;
              if (!rendererHost) throw new Error("native ROI frame is missing its renderer host");
              runtimeNativeRoiPostprocessor!.apply(
                prediction, rendererHost, support, points, epoch, globalIndex,
              );
            }
            : undefined,
          supportResize: targets.supportResize,
          jawProtected: targets.jawProtected,
          plane: S.resizePlane,
          pool: S,
        },
        S.inkShifted,
      );
      compositorMs += performance.now() - compositorStarted;

      if (isPendingNeural) {
        for (let next = localIndex + 1; next < outputFrames; next += 1) {
          if (neuralAt(next)) {
            // Dispatch now so WebGPU overlaps transfer plus the held CPU frames.
            dispatchNeural(next);
            break;
          }
        }
      }

      // Fresh transfer copies: postMessage transfer detaches the ArrayBuffer,
      // so pooled scratch buffers must not be moved.
      const predTransfer = new Uint8Array(finished.predBgr);
      const supportTransfer = new Float32Array(finished.support);
      const jawProtectedTransfer = new Uint8Array(finished.jawProtected);
      const renderMs = performance.now() - started;
      const predBuffer = predTransfer.buffer as ArrayBuffer;
      const supportBuffer = supportTransfer.buffer as ArrayBuffer;
      const jawProtectedBuffer = jawProtectedTransfer.buffer as ArrayBuffer;
      post({
        type: "frame", epoch, index: globalIndex, box, width, height,
        predBgr: predBuffer,
        support: supportBuffer,
        jawProtected: jawProtectedBuffer,
        renderMs,
      }, [predBuffer, supportBuffer, jawProtectedBuffer]);
    }
  } finally {
    // ORT sessions are stateful. If cancellation arrives with a renderer run
    // in flight, drain that run before the serialized queue starts a new turn.
    if (pendingRun) await pendingRun.catch(() => undefined);
  }
  if (pool) await Promise.all(inflight);
  const meanRenderMs = (performance.now() - renderPhaseStarted)
    / Math.max(outputFrames, 1);
  post({
    type: "status",
    message: `Render stages · ${neuralRuns} neural · `
      + `${(runMs / Math.max(neuralRuns, 1)).toFixed(1)} ms/run · `
      + `${(waitMs / Math.max(neuralRuns, 1)).toFixed(1)} ms blocked · `
      + `${(fillMs / Math.max(neuralRuns, 1)).toFixed(1)} ms fill · `
      + `${(compositorMs / Math.max(outputFrames, 1)).toFixed(1)} ms compositor/frame`,
  });
  if (chunkIndex === undefined) {
    post({
      type: "render-complete", epoch, frameCount: outputFrames, meanRenderMs,
      featherMs, geometryMs,
      rendererMsMean: neuralRuns > 0 ? runMs / neuralRuns : 0,
      neuralFrames: neuralRuns,
      compositorMsMean: compositorMs / Math.max(outputFrames, 1),
    });
  } else {
    post({
      type: "chunk-render-complete",
      epoch,
      chunkIndex,
      frameOffset,
      frameCount: outputFrames,
      final,
      meanRenderMs,
    });
  }
  return { compositorCapacity: capacity, maxCompositorInFlight };
}

let queue: Promise<void> = Promise.resolve();

scope.onmessage = (event: MessageEvent<MainToWorker>) => {
  const message = event.data;
  const receivedAt = performance.now();
  const renderTask = interruptsRendererPrewarm(message.type);
  // Renderer work outranks the background prewarm. Set before the queue so the
  // in-flight prewarm loop sees it at its next yield rather than after a whole
  // remaining batch of passes.
  if (renderTask) {
    prewarmStopRequested = true;
    queuedRenderTasks += 1;
  }
  const queueDepthAtEnqueue = queuedRenderTasks;
  if (message.type === "grant") {
    // The asset store reads the token from this object before every request.
    if (runtimeConfig) runtimeConfig.downloadToken = message.downloadToken;
    return;
  }
  if (message.type === "cancel") {
    currentEpoch = message.epoch;
    audioGeometry?.cancel(message.epoch);
    streamingRenderActive = false;
    scheduleRendererPrewarm();
    return;
  }
  if (message.type === "prepare") streamingRenderActive = false;
  if (message.type === "prepare-chunk") streamingRenderActive = !message.final;
  if (message.type === "prepare" || message.type === "prepare-chunk") {
    currentEpoch = message.epoch;
  }
  if (message.type === "initialize") {
    runtimeConfig = message.assets;
    setOrtWasmUrl(message.assets.ortWasmUrl);
    runtimeNeuralMouthStride = neuralMouthRenderStride(message.neuralMouthStride);
    if (message.rendererInputType !== undefined
        && message.rendererInputType !== "float32" && message.rendererInputType !== "float16") {
      throw new Error(`unsupported renderer input type ${message.rendererInputType}`);
    }
    runtimeRendererInputType = message.rendererInputType ?? "float32";
    if (message.rendererPreferredLayout !== undefined
        && message.rendererPreferredLayout !== "NCHW"
        && message.rendererPreferredLayout !== "NHWC") {
      throw new Error(`unsupported renderer layout ${message.rendererPreferredLayout}`);
    }
    runtimeRendererPreferredLayout = message.rendererPreferredLayout ?? "NCHW";
    runtimeRendererSpatialContract = resolveRendererSpatialContract(
      message.rendererSpatialContract,
    );
    runtimeRendererSupportMultiplier = rendererSupportMultiplier(
      runtimeRendererSpatialContract,
    );
    runtimeRendererTemporalContract = resolveRendererTemporalContract(
      message.rendererTemporalContract,
      runtimeRendererSpatialContract,
    );
    if (runtimeRendererTemporalContract && runtimeNeuralMouthStride !== 1) {
      throw new Error("renderer temporal contract requires neuralMouthStride=1");
    }
    runtimeNativeRoiPostprocessor = !isFull320RendererContract(runtimeRendererSpatialContract)
      ? new NativeRoiPostprocessor(
        runtimeRendererSpatialContract,
        runtimeRendererSupportMultiplier!,
        runtimeRendererTemporalContract,
      )
      : undefined;
    compositorWorkerOverride = message.compositorWorkers;
  }
  let task: Promise<void>;
  if (message.type === "initialize") {
    task = queue.then(() => initialize());
  } else {
    const options: PrepareWindow = message.type === "prepare"
      ? {
        epoch: message.epoch,
        pcmBuffer: message.pcm16le24k,
        frameOffset: 0,
        discardFrames: 0,
        final: true,
      }
      : {
        epoch: message.epoch,
        pcmBuffer: message.pcm16le24k,
        frameOffset: message.frameOffset,
        discardFrames: message.discardFrames,
        outputFrames: message.outputFrames,
        chunkIndex: message.chunkIndex,
        final: message.final,
        geometryFinal: message.geometryFinal,
        bootstrap: message.bootstrap,
      };
    // Dispatch immediately to the isolated serial WASM worker. The renderer
    // queue consumes results in message order, so preparation for bucket N+1
    // can overlap bucket N's graph-captured WebGPU work without concurrent
    // entry into any individual ORT runtime.
    const geometryStartedAt = performance.now();
    geometryPreparationsInFlight += 1;
    const geometryParallelAtEnqueue = geometryPreparationsInFlight;
    let geometryReadyAt = geometryStartedAt;
    const preparation = prepareGeometry(options).then((prepared) => {
      geometryReadyAt = performance.now();
      return prepared;
    }).finally(() => {
      geometryPreparationsInFlight = Math.max(0, geometryPreparationsInFlight - 1);
    });
    preparation.catch(() => undefined);
    task = queue.then(async () => {
      const prepared = await preparation;
      const renderStartedAt = performance.now();
      const pressure = await renderPreparedWindow(prepared);
      const completedAt = performance.now();
      post({
        type: "runtime-pressure",
        epoch: options.epoch,
        chunkIndex: options.chunkIndex,
        final: options.final,
        queueDepthAtEnqueue,
        geometryParallelAtEnqueue,
        geometryMs: geometryReadyAt - geometryStartedAt,
        rendererQueueWaitMs: renderStartedAt - geometryReadyAt,
        renderMs: completedAt - renderStartedAt,
        totalMs: completedAt - receivedAt,
        compositorWorkers: compositePool?.size ?? 0,
        compositorCapacity: pressure.compositorCapacity,
        maxCompositorInFlight: pressure.maxCompositorInFlight,
      });
    });
  }
  task = task.finally(() => {
    if (!renderTask) return;
    queuedRenderTasks = Math.max(0, queuedRenderTasks - 1);
    scheduleRendererPrewarm();
  });
  // Keep graph-captured renderer consumption serial. A newer epoch makes the
  // queued/running older chain abort at its next deterministic checkpoint.
  queue = task.catch(() => undefined);
  task.catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError") return;
    const value = error instanceof Error ? error : new Error(String(error));
    post({ type: "error", epoch: message.type === "initialize" ? undefined : message.epoch,
      message: value.message, stack: value.stack });
  });
};
