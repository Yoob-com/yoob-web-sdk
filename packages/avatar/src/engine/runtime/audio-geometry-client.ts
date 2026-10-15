import type {
  AudioGeometryMainToWorker, AudioGeometryPrepareRequest,
  AudioGeometryWorkerToMain, PreparedAudioGeometry,
} from "./audio-geometry-protocol";

type PendingRequest = {
  epoch: number;
  request: AudioGeometryPrepareRequest;
  resolve: (value: PreparedAudioGeometry) => void;
  reject: (error: Error) => void;
};

export class AudioGeometryClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly queuedRequestIDs: number[] = [];
  private activeRequestID?: number;
  private nextRequestID = 1;
  private initialized = false;
  private initializationResolve?: () => void;
  private initializationReject?: (error: Error) => void;

  private constructor(private readonly onStatus: (message: string, stage?: string) => void) {
    this.worker = new Worker(new URL("./audio-geometry-worker.ts", import.meta.url), {
      type: "module",
      name: "serve320-audio-geometry",
    });
    this.worker.onmessage = (event: MessageEvent<AudioGeometryWorkerToMain>) => {
      this.handleMessage(event.data);
    };
    this.worker.onerror = (event) => {
      this.failAll(new Error(event.message || "audio geometry worker failed"));
    };
  }

  static async create(
    encoderModel: ArrayBuffer,
    geometryModel: ArrayBuffer,
    onStatus: (message: string, stage?: string) => void,
    ortWasmUrl?: string,
  ): Promise<AudioGeometryClient> {
    const client = new AudioGeometryClient(onStatus);
    await client.initialize(encoderModel, geometryModel, ortWasmUrl);
    return client;
  }

  private initialize(encoderModel: ArrayBuffer, geometryModel: ArrayBuffer, ortWasmUrl?: string): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      this.initializationResolve = resolve;
      this.initializationReject = reject;
    });
    const message: AudioGeometryMainToWorker = {
      type: "initialize",
      encoderModel,
      geometryModel,
      ortWasmUrl,
    };
    this.worker.postMessage(message, [encoderModel, geometryModel]);
    return ready;
  }

  prepare(request: AudioGeometryPrepareRequest): Promise<PreparedAudioGeometry> {
    if (!this.initialized) return Promise.reject(new Error("audio geometry worker is not ready"));
    const requestID = this.nextRequestID++;
    const result = new Promise<PreparedAudioGeometry>((resolve, reject) => {
      this.pending.set(requestID, {
        epoch: request.epoch,
        request,
        resolve,
        reject,
      });
    });
    this.queuedRequestIDs.push(requestID);
    this.dispatchNext();
    return result;
  }

  cancel(epoch: number): void {
    for (let index = this.queuedRequestIDs.length - 1; index >= 0; index -= 1) {
      const requestID = this.queuedRequestIDs[index];
      const pending = this.pending.get(requestID);
      if (!pending || pending.epoch === epoch) continue;
      this.queuedRequestIDs.splice(index, 1);
      this.pending.delete(requestID);
      pending.reject(new DOMException("stale geometry generation", "AbortError"));
    }
    if (this.activeRequestID !== undefined) {
      const pending = this.pending.get(this.activeRequestID);
      if (pending && pending.epoch !== epoch) {
        this.pending.delete(this.activeRequestID);
        pending.reject(new DOMException("stale geometry generation", "AbortError"));
      }
    }
    this.worker.postMessage({ type: "cancel", epoch } satisfies AudioGeometryMainToWorker);
  }

  private dispatchNext(): void {
    if (!this.initialized || this.activeRequestID !== undefined) return;
    while (this.queuedRequestIDs.length > 0) {
      const requestID = this.queuedRequestIDs.shift()!;
      const pending = this.pending.get(requestID);
      if (!pending) continue;
      this.activeRequestID = requestID;
      const message: AudioGeometryMainToWorker = {
        type: "prepare",
        requestID,
        ...pending.request,
      };
      this.worker.postMessage(message, [pending.request.pcmBuffer]);
      return;
    }
  }

  private handleMessage(message: AudioGeometryWorkerToMain): void {
    if (message.type === "status") {
      this.onStatus(message.message, message.stage);
      return;
    }
    if (message.type === "initialized") {
      this.initialized = true;
      this.initializationResolve?.();
      this.initializationResolve = undefined;
      this.initializationReject = undefined;
      this.dispatchNext();
      return;
    }
    if (message.type === "cancelled") {
      if (this.activeRequestID === message.requestID) this.activeRequestID = undefined;
      const pending = this.pending.get(message.requestID);
      this.pending.delete(message.requestID);
      pending?.reject(new DOMException("stale geometry generation", "AbortError"));
      this.dispatchNext();
      return;
    }
    if (message.type === "prepared") {
      if (this.activeRequestID === message.requestID) this.activeRequestID = undefined;
      const pending = this.pending.get(message.requestID);
      this.pending.delete(message.requestID);
      pending?.resolve({
        epoch: message.epoch,
        modelFrameCount: message.modelFrameCount,
        outputFrames: message.outputFrames,
        audioSamples: message.audioSamples,
        pred6: new Float32Array(message.pred6),
        contactLogit: new Float32Array(message.contactLogit),
        featherMs: message.featherMs,
        geometryMs: message.geometryMs,
      });
      this.dispatchNext();
      return;
    }
    const error = new Error(message.message);
    if (message.requestID !== undefined) {
      if (this.activeRequestID === message.requestID) this.activeRequestID = undefined;
      const pending = this.pending.get(message.requestID);
      this.pending.delete(message.requestID);
      pending?.reject(error);
      this.dispatchNext();
      return;
    }
    this.initializationReject?.(error);
  }

  private failAll(error: Error): void {
    this.initializationReject?.(error);
    this.initializationReject = undefined;
    this.initializationResolve = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.queuedRequestIDs.length = 0;
    this.activeRequestID = undefined;
  }
}
