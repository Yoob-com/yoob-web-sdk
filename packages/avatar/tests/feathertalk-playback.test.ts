import test from "node:test";
import assert from "node:assert/strict";
import { FeatherCoordinator } from "../src/feathertalk/coordinator";

test("FeatherTalk queues speech before rendering and does not queue rendered PCM twice", async () => {
  class FakeWorker {
    static current: FakeWorker;
    onmessage?: (event: { data: unknown }) => void;
    messages: unknown[] = [];
    constructor() { FakeWorker.current = this; }
    postMessage(message: unknown) { this.messages.push(message); }
    terminate() {}
  }
  const oldWorker = globalThis.Worker;
  (globalThis as unknown as { Worker: typeof Worker }).Worker = FakeWorker as unknown as typeof Worker;
  try {
    const calls: string[] = [];
    const audio = {
      beginStream: () => calls.push("begin"),
      appendStream: (pcm: Int16Array) => calls.push(`append:${pcm.length}`),
      finalizeStream: () => calls.push("final"),
      start: async () => { calls.push("start"); },
      clear: () => calls.push("clear"),
    };
    const video = { play: async () => undefined, pause: () => calls.push("pause") };
    const canvas = { getContext: () => ({}) };
    const coordinator = new FeatherCoordinator(
      canvas as unknown as HTMLCanvasElement,
      video as unknown as HTMLVideoElement,
      {},
      audio as unknown as ConstructorParameters<typeof FeatherCoordinator>[3],
    );

    const epoch = coordinator.appendStreamingAudio("reply", new Int16Array(9_600));
    assert.deepEqual(calls, ["clear", "begin", "append:9600"]);
    for (let frame = 0; frame < 8; frame += 1) {
      FakeWorker.current.onmessage?.({
        data: { type: "frame", epoch, frame, bitmap: { close() {} }, pcm: new Int16Array(960) },
      });
    }
    assert.deepEqual(calls, ["clear", "begin", "append:9600", "pause", "start"]);

    coordinator.appendStreamingAudio("reply", new Int16Array(480), true);
    assert.deepEqual(calls.slice(-2), ["append:480", "final"]);
    assert.equal(calls.filter((call) => call.startsWith("append")).length, 2);
  } finally {
    (globalThis as unknown as { Worker: typeof Worker }).Worker = oldWorker;
  }
});
