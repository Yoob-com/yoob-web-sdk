export interface AudioGeometryPrepareRequest {
  epoch: number;
  pcmBuffer: ArrayBuffer;
  discardFrames: number;
  outputFrames?: number;
  geometryFinal: boolean;
  bootstrap: boolean;
}

export interface PreparedAudioGeometry {
  epoch: number;
  modelFrameCount: number;
  outputFrames: number;
  audioSamples: number;
  pred6: Float32Array;
  contactLogit: Float32Array;
  featherMs: number;
  geometryMs: number;
}

export type AudioGeometryMainToWorker =
  | { type: "initialize"; encoderModel: ArrayBuffer; geometryModel: ArrayBuffer; ortWasmUrl?: string }
  | ({ type: "prepare"; requestID: number } & AudioGeometryPrepareRequest)
  | { type: "cancel"; epoch: number };

export type AudioGeometryWorkerToMain =
  | { type: "initialized" }
  | { type: "status"; message: string; stage?: string }
  | { type: "cancelled"; requestID: number; epoch: number }
  | {
      type: "prepared";
      requestID: number;
      epoch: number;
      modelFrameCount: number;
      outputFrames: number;
      audioSamples: number;
      pred6: ArrayBuffer;
      contactLogit: ArrayBuffer;
      featherMs: number;
      geometryMs: number;
    }
  | { type: "error"; requestID?: number; epoch?: number; message: string; stack?: string };
