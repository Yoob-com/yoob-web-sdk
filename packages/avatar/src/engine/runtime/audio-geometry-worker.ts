/// <reference lib="webworker" />

import { fallbackPhoneTimeline, frameRms } from "../audio/phoneme-activity";
import { pcm16ToFloat32, resample24kTo16k } from "../audio/resample-24k-16k";
import { AudioFeatures } from "../inference/audio-features";
import { GeometryRuntime } from "../inference/geometry";
import { setOrtWasmUrl } from "../inference/ort-runtime";
import type {
  AudioGeometryMainToWorker, AudioGeometryWorkerToMain,
} from "./audio-geometry-protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let feather: AudioFeatures | undefined;
let geometry: GeometryRuntime | undefined;
let currentEpoch = 0;
let queue: Promise<void> = Promise.resolve();

function post(message: AudioGeometryWorkerToMain, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function ensureCurrent(epoch: number): void {
  if (epoch !== currentEpoch) throw new DOMException("stale geometry generation", "AbortError");
}

async function initialize(
  encoderModel: ArrayBuffer,
  geometryModel: ArrayBuffer,
): Promise<void> {
  post({ type: "status", message: "Opening AudioFeatures in audio worker…", stage: "opening" });
  feather = await AudioFeatures.load(new Uint8Array(encoderModel));
  post({ type: "status", message: "Opening geometry in audio worker…", stage: "opening" });
  geometry = await GeometryRuntime.load(new Uint8Array(geometryModel));
  post({ type: "status", message: "Warming audio + geometry worker…", stage: "warming" });
  await Promise.all([feather.silenceRows(), geometry.warmup()]);
  post({ type: "initialized" });
}

async function prepare(
  message: Extract<AudioGeometryMainToWorker, { type: "prepare" }>,
): Promise<void> {
  if (!feather || !geometry) throw new Error("audio geometry worker is not initialized");
  const { epoch, discardFrames } = message;
  ensureCurrent(epoch);
  let pcm16k = resample24kTo16k(pcm16ToFloat32(new Int16Array(message.pcmBuffer)));
  const maxSamples = 725 * 640;
  if (pcm16k.length > maxSamples) {
    pcm16k = pcm16k.slice(0, maxSamples);
    const fade = Math.min(1600, pcm16k.length);
    for (let index = 0; index < fade; index += 1) {
      pcm16k[pcm16k.length - fade + index] *= (fade - 1 - index) / fade;
    }
  }
  const modelFrameCount = Math.max(1, Math.ceil(pcm16k.length / 640));
  const outputFrames = message.outputFrames ?? modelFrameCount - discardFrames;
  if (discardFrames < 0 || outputFrames < 1
      || discardFrames + outputFrames > modelFrameCount) {
    throw new Error(`bad render window ${discardFrames}+${outputFrames}/${modelFrameCount}`);
  }
  post({
    type: "status",
    message: message.bootstrap
      ? `Bootstrap AudioFeatures · ${modelFrameCount} frames + silence tail…`
      : `Extracting AudioFeatures for ${modelFrameCount} streaming frames…`,
  });
  const featherStarted = performance.now();
  const audioRows = await feather.extract(pcm16k, modelFrameCount, 2);
  const featherMs = performance.now() - featherStarted;
  ensureCurrent(epoch);
  const silenceRows = await feather.silenceRows();
  const phoneIDs = fallbackPhoneTimeline(frameRms(pcm16k, modelFrameCount));
  post({
    type: "status",
    message: message.bootstrap
      ? "Running bootstrap bidirectional geometry (silence future)…"
      : "Running overlapping bidirectional geometry bucket…",
  });
  const geometryStarted = performance.now();
  const predicted = await geometry.runWindow(
    audioRows, silenceRows, phoneIDs, modelFrameCount, message.geometryFinal,
  );
  const geometryMs = performance.now() - geometryStarted;
  ensureCurrent(epoch);
  // GeometryRuntime owns reusable buffers. Transfer independent snapshots so
  // the next request cannot overwrite a bucket still being rendered.
  const pred6 = predicted.pred6.slice();
  const contactLogit = predicted.contactLogit.slice();
  post({
    type: "prepared",
    requestID: message.requestID,
    epoch,
    modelFrameCount,
    outputFrames,
    audioSamples: Math.floor(pcm16k.length * 1.5),
    pred6: pred6.buffer as ArrayBuffer,
    contactLogit: contactLogit.buffer as ArrayBuffer,
    featherMs,
    geometryMs,
  }, [pred6.buffer, contactLogit.buffer]);
}

scope.onmessage = (event: MessageEvent<AudioGeometryMainToWorker>) => {
  const message = event.data;
  if (message.type === "cancel") {
    currentEpoch = message.epoch;
    return;
  }
  if (message.type === "prepare") currentEpoch = message.epoch;
  const task = queue.then(() => message.type === "initialize"
    ? (message.ortWasmUrl && setOrtWasmUrl(message.ortWasmUrl), initialize(message.encoderModel, message.geometryModel))
    : prepare(message));
  queue = task.catch(() => undefined);
  task.catch((error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError"
        && message.type === "prepare") {
      post({ type: "cancelled", requestID: message.requestID, epoch: message.epoch });
      return;
    }
    const value = error instanceof Error ? error : new Error(String(error));
    post({
      type: "error",
      requestID: message.type === "prepare" ? message.requestID : undefined,
      epoch: message.type === "prepare" ? message.epoch : undefined,
      message: value.message,
      stack: value.stack,
    });
  });
};
