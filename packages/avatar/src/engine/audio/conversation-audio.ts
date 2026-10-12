/** The parts of a LiveKit `RemoteAudioTrack` this module uses (kept structural: no livekit-client dependency). */
export interface RemoteAudioTrack {
  setAudioContext(context: AudioContext | undefined): void;
  setWebAudioPlugins(nodes: AudioNode[]): void;
  attach(): HTMLMediaElement;
  detach(element: HTMLMediaElement): unknown;
  setVolume(volume: number): void;
}

import { openPreferredMicrophone } from "./microphone-devices";
import {
  MICROPHONE_REOPEN_RECOVERY_MS,
  MICROPHONE_SOFT_RECOVERY_MS,
  MICROPHONE_WATCHDOG_INTERVAL_MS,
  microphonePcmStalled,
} from "./microphone-health";

export interface PlaybackTick {
  epoch: number;
  playedSamples: number;
  /** Native 24 kHz samples currently queued in the playback worklet. */
  bufferedSamples: number;
  started: boolean;
  final: boolean;
}

export interface PlaybackUnderrun extends PlaybackTick {
  /** Duration of this contiguous PCM starvation interval at native 24 kHz. */
  durationSamples: number;
}

/**
 * `AudioWorklet.addModule()` collapses every load failure — 404, wrong MIME
 * type, or a Content-Security-Policy refusal — into a bare `AbortError`, which
 * `friendlyError()` in app.ts then reports as the meaningless "Request timed
 * out". A build that inlined these worklets as `data:` URLs cost three
 * misdiagnoses; name the module and the real reason instead.
 */
async function addWorkletModule(context: AudioContext, url: URL): Promise<void> {
  try {
    await context.audioWorklet.addModule(url);
  } catch (error) {
    // A data: worklet is the known CSP failure and its href is kilobytes long.
    const source = url.protocol === "data:" ? "an inlined data: URL" : url.href;
    throw new Error(
      `Audio worklet failed to load from ${source}`
        + ` (${error instanceof Error ? error.name : "unknown error"}).`
        + " It must be served as a same-origin script that script-src allows.",
    );
  }
}

/**
 * Worklets ship as real files in `dist/worklets/` (copied at build time), never as data: URLs, so pages with a strict
 * script-src policy can load them. The base is read through a variable so the bundler leaves the URL alone.
 */
const moduleBase = import.meta.url;
function workletUrl(name: string): URL {
  return new URL(`./worklets/${name}`, moduleBase);
}

export class ConversationAudio {
  private context?: AudioContext;
  private initializing?: Promise<void>;
  private playback?: AudioWorkletNode;
  private mic?: AudioWorkletNode;
  private micSource?: MediaStreamAudioSourceNode;
  private micSilencer?: GainNode;
  private stream?: MediaStream;
  private loadedEpoch = 0;
  private remoteTapCleanup?: () => void;
  private micEnabledAtMs = 0;
  private lastMicPacketAtMs = 0;
  private micPacketSequence = 0;
  private micDeviceId: string | null = null;
  private micWatchdog?: ReturnType<typeof globalThis.setInterval>;
  private micWatchdogGeneration = 0;
  private micRecovery?: Promise<boolean>;

  onMicPcm?: (pcm: ArrayBuffer) => void;
  onMicrophoneRecovered?: () => void;
  onMicrophoneFailure?: (message: string) => void;
  onPlaybackTick?: (value: PlaybackTick) => void;
  onPlaybackDrained?: (value: PlaybackTick) => void;
  onPlaybackUnderrun?: (value: PlaybackUnderrun) => void;

  async initialize(): Promise<void> {
    if (this.context && this.playback) return;
    if (this.initializing) return this.initializing;
    const context = new AudioContext({ latencyHint: "interactive" });
    // Publish the context before the first await so activatePlayback() can call
    // resume() synchronously inside the Start button's transient activation.
    this.context = context;
    const initializing = (async () => {
      await Promise.all([
        addWorkletModule(context, workletUrl("playback-worklet.js")),
        addWorkletModule(context, workletUrl("mic-worklet.js")),
      ]);
      const playback = new AudioWorkletNode(context, "serve320-playback", {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
      });
      playback.connect(context.destination);
      playback.port.onmessage = ({ data }) => {
        if (data.type === "tick") this.onPlaybackTick?.(data as PlaybackTick);
        if (data.type === "drained") this.onPlaybackDrained?.(data as PlaybackTick);
        if (data.type === "underrun") {
          this.onPlaybackUnderrun?.(data as PlaybackUnderrun);
        }
      };
      this.playback = playback;
    })();
    this.initializing = initializing;
    try {
      await initializing;
    } catch (error) {
      // Chrome caps concurrent AudioContexts, so a retried click must not leak
      // the half-built one — six failures would otherwise wedge construction.
      if (this.context === context) {
        this.context = undefined;
        this.playback = undefined;
      }
      void context.close();
      throw error;
    } finally {
      if (this.initializing === initializing) this.initializing = undefined;
    }
  }

  /**
   * Arm browser audio while the Start button still owns a user activation.
   *
   * The LiveKit assistant track arrives only after admission, room connection,
   * and agent dispatch. Creating the AudioContext from TrackSubscribed is then
   * too late for Chrome's autoplay policy: transcripts continue to work, but
   * the suspended graph never emits PCM for synchronized playback.
   */
  async activatePlayback(): Promise<void> {
    const initialized = this.initialize();
    const context = this.context;
    if (!context) throw new Error("Browser audio output could not be initialized.");
    // Invoke resume before awaiting worklet installation; Chrome consumes the
    // transient user activation at the call site, not when the promise settles.
    const resumed = context.resume();
    await Promise.all([initialized, resumed]);
    if (context.state !== "running") {
      throw new Error("Browser audio output is blocked. Press Start again to enable sound.");
    }
  }

  async enableMicrophone(inputDeviceId: string | null = null): Promise<void> {
    await this.initialize();
    let usedFallback = false;
    const liveTrack = this.stream?.getAudioTracks().some((track) => track.readyState === "live");
    if (!liveTrack) {
      ({ usedFallback } = await this.replaceMicrophone(inputDeviceId));
    }
    await this.context!.resume();
    this.micDeviceId = usedFallback ? null : inputDeviceId;
    this.micEnabledAtMs = performance.now();
    this.mic!.port.postMessage({ type: "enabled", value: true });
  }

  /** Replace the live input without closing the Realtime conversation. */
  async switchMicrophone(
    inputDeviceId: string | null = null,
  ): Promise<{ usedFallback: boolean }> {
    await this.initialize();
    const result = await this.replaceMicrophone(inputDeviceId);
    await this.context!.resume();
    this.micDeviceId = result.usedFallback ? null : inputDeviceId;
    this.micEnabledAtMs = performance.now();
    this.mic!.port.postMessage({ type: "enabled", value: true });
    return result;
  }

  private async replaceMicrophone(
    inputDeviceId: string | null,
  ): Promise<{ usedFallback: boolean }> {
    const opened = await openPreferredMicrophone(navigator.mediaDevices, inputDeviceId);
    const source = this.context!.createMediaStreamSource(opened.stream);
    const mic = new AudioWorkletNode(this.context!, "serve320-mic", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    const silent = this.context!.createGain();
    silent.gain.value = 0;
    source.connect(mic).connect(silent).connect(this.context!.destination);
    mic.port.onmessage = ({ data }) => {
      if (data.type !== "pcm") return;
      this.lastMicPacketAtMs = performance.now();
      this.micPacketSequence += 1;
      this.onMicPcm?.(data.pcm as ArrayBuffer);
    };

    const oldStream = this.stream;
    this.mic?.port.postMessage({ type: "enabled", value: false });
    this.micSource?.disconnect();
    this.mic?.disconnect();
    this.micSilencer?.disconnect();
    oldStream?.getTracks().forEach((track) => track.stop());

    this.stream = opened.stream;
    this.micSource = source;
    this.mic = mic;
    this.micSilencer = silent;
    return { usedFallback: opened.usedFallback };
  }

  async decodeToPcm24k(encoded: ArrayBuffer): Promise<Int16Array> {
    await this.initialize();
    await this.context!.resume();
    const decoded = await this.context!.decodeAudioData(encoded.slice(0));
    const frames = Math.max(1, Math.ceil(decoded.duration * 24_000));
    const offline = new OfflineAudioContext(1, frames, 24_000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const channel = rendered.getChannelData(0);
    const pcm = new Int16Array(channel.length);
    for (let index = 0; index < channel.length; index += 1) {
      const value = Math.max(-1, Math.min(1, channel[index]));
      pcm[index] = value < 0
        ? Math.round(value * 32768)
        : Math.round(value * 32767);
    }
    return pcm;
  }

  /**
   * Decode a subscribed LiveKit audio track into the same 24 kHz PCM stream
   * consumed by the avatar. LiveKit owns the remote-track attachment and Web
   * Audio source; our worklet is installed as a plugin before its zero-gain
   * output. This keeps the supported LiveKit receive path active while the
   * synchronized playback worklet remains the only audible output.
   */
  async tapRemoteTrack(
    track: RemoteAudioTrack,
    onPcm: (pcm: Int16Array) => void,
  ): Promise<() => void> {
    await this.initialize();
    this.stopRemoteTap();
    const context = this.context!;
    const tap = new AudioWorkletNode(context, "serve320-mic", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    tap.port.onmessage = ({ data }) => {
      if (data.type === "pcm") onPcm(new Int16Array(data.pcm as ArrayBuffer));
    };
    tap.port.postMessage({ type: "enabled", value: true });
    track.setAudioContext(context);
    track.setWebAudioPlugins([tap]);
    const element = track.attach();
    element.hidden = true;
    element.setAttribute("aria-hidden", "true");
    element.dataset.yoobRemoteAudio = "true";
    document.body.append(element);
    // The plugin is upstream of LiveKit's gain node, so it still receives the
    // full signal while direct element/WebAudio playback remains silent.
    track.setVolume(0);
    const cleanup = () => {
      tap.port.postMessage({ type: "enabled", value: false });
      tap.port.onmessage = null;
      track.detach(element);
      track.setWebAudioPlugins([]);
      track.setAudioContext(undefined);
      tap.disconnect();
      element.pause();
      element.remove();
    };
    this.remoteTapCleanup = cleanup;
    try {
      await Promise.all([context.resume(), element.play()]);
    } catch (error) {
      if (this.remoteTapCleanup === cleanup) this.stopRemoteTap();
      throw error;
    }
    return cleanup;
  }

  /** Stops the remote tap, or only `cleanup`'s tap when given and still current. */
  stopRemoteTap(cleanup?: () => void): void {
    if (cleanup && this.remoteTapCleanup !== cleanup) return;
    this.remoteTapCleanup?.();
    this.remoteTapCleanup = undefined;
  }

  /** Stops the input device so the browser's recording indicator turns off. Playback keeps running. */
  releaseMicrophone(): void {
    this.stopMicrophoneWatchdog();
    this.mic?.port.postMessage({ type: "enabled", value: false });
    this.micSource?.disconnect();
    this.mic?.disconnect();
    this.micSilencer?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.micSource = undefined;
    this.mic = undefined;
    this.micSilencer = undefined;
    this.micEnabledAtMs = 0;
  }

  disableMicrophone(): void {
    this.stopMicrophoneWatchdog();
    this.mic?.port.postMessage({ type: "enabled", value: false });
    this.micEnabledAtMs = 0;
  }

  /**
   * Detect and repair a capture graph that is still open but no longer emits
   * its continuous 20 ms PCM packets. Recovery is deliberately bounded: first
   * resume/re-arm the existing graph, then reopen the selected input once. A
   * second failure is surfaced instead of leaving a green but deaf call.
   */
  startMicrophoneWatchdog(inputDeviceId: string | null = this.micDeviceId): void {
    this.stopMicrophoneWatchdog();
    this.micDeviceId = inputDeviceId;
    this.micEnabledAtMs = performance.now();
    const generation = this.micWatchdogGeneration;
    this.micWatchdog = globalThis.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (this.micRecovery) return;
      if (!microphonePcmStalled(
        this.micEnabledAtMs, this.lastMicPacketAtMs, performance.now(),
      )) return;
      const recovery = this.recoverMicrophoneFlow(generation);
      void recovery.then((recovered) => {
        if (recovered && generation === this.micWatchdogGeneration) {
          this.onMicrophoneRecovered?.();
        }
      }).catch((error: unknown) => {
        if (generation !== this.micWatchdogGeneration) return;
        this.stopMicrophoneWatchdog();
        const detail = error instanceof Error ? error.message : String(error);
        this.onMicrophoneFailure?.(`Microphone input stopped: ${detail}`);
      });
    }, MICROPHONE_WATCHDOG_INTERVAL_MS);
  }

  stopMicrophoneWatchdog(): void {
    this.micWatchdogGeneration += 1;
    if (this.micWatchdog !== undefined) globalThis.clearInterval(this.micWatchdog);
    this.micWatchdog = undefined;
  }

  private async recoverMicrophoneFlow(generation: number): Promise<boolean> {
    if (this.micRecovery) return this.micRecovery;
    const recovery = this.recoverMicrophoneFlowOnce(generation);
    this.micRecovery = recovery;
    try {
      return await recovery;
    } finally {
      if (this.micRecovery === recovery) this.micRecovery = undefined;
    }
  }

  private async recoverMicrophoneFlowOnce(generation: number): Promise<boolean> {
    if (!this.context || !this.mic || !this.stream) {
      throw new Error("capture graph is unavailable");
    }
    let sequence = this.micPacketSequence;
    await this.context.resume();
    if (generation !== this.micWatchdogGeneration) return false;
    this.mic.port.postMessage({ type: "enabled", value: true });
    if (await this.waitForMicrophonePacket(sequence, MICROPHONE_SOFT_RECOVERY_MS)) return true;
    if (generation !== this.micWatchdogGeneration) return false;

    const result = await this.replaceMicrophone(this.micDeviceId);
    if (generation !== this.micWatchdogGeneration) return false;
    this.micDeviceId = result.usedFallback ? null : this.micDeviceId;
    await this.context.resume();
    if (generation !== this.micWatchdogGeneration) return false;
    sequence = this.micPacketSequence;
    this.micEnabledAtMs = performance.now();
    this.mic!.port.postMessage({ type: "enabled", value: true });
    if (await this.waitForMicrophonePacket(sequence, MICROPHONE_REOPEN_RECOVERY_MS)) return true;
    throw new Error("no PCM packets after reopening the input");
  }

  private async waitForMicrophonePacket(sequence: number, timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (this.micPacketSequence === sequence && performance.now() < deadline) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
    }
    return this.micPacketSequence !== sequence;
  }

  /** Seconds from the playback worklet to the speaker (output and base latency), 0 before playback is set up. */
  get outputLatencySeconds(): number {
    const context = this.context;
    if (!context) return 0;
    return (Number.isFinite(context.outputLatency) ? context.outputLatency : 0) + (Number.isFinite(context.baseLatency) ? context.baseLatency : 0);
  }

  load(pcm: Int16Array, epoch: number): void {
    if (!this.playback) throw new Error("audio is not initialized");
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) samples[i] = pcm[i] / 32768;
    this.loadedEpoch = epoch;
    this.playback.port.postMessage({ type: "load", epoch, samples: samples.buffer }, [samples.buffer]);
  }

  beginStream(epoch: number): void {
    if (!this.playback) throw new Error("audio is not initialized");
    this.loadedEpoch = epoch;
    this.playback.port.postMessage({ type: "begin", epoch });
  }

  appendStream(pcm: Int16Array, epoch: number): void {
    if (!this.playback || epoch !== this.loadedEpoch || pcm.length === 0) return;
    const samples = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index += 1) samples[index] = pcm[index] / 32768;
    this.playback.port.postMessage(
      { type: "append", epoch, samples: samples.buffer },
      [samples.buffer],
    );
  }

  finalizeStream(epoch: number): void {
    if (!this.playback || epoch !== this.loadedEpoch) return;
    this.playback.port.postMessage({ type: "finalize", epoch });
  }

  async start(epoch: number): Promise<void> {
    if (!this.context || !this.playback || epoch !== this.loadedEpoch) return;
    await this.context.resume();
    this.playback.port.postMessage({ type: "start", epoch });
  }

  pause(epoch: number): void {
    if (!this.playback || epoch !== this.loadedEpoch) return;
    this.playback.port.postMessage({ type: "pause", epoch });
  }

  clear(epoch: number): void {
    this.loadedEpoch = epoch;
    this.playback?.port.postMessage({ type: "clear", epoch });
  }

  close(): void {
    this.stopRemoteTap();
    this.disableMicrophone();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.micSource?.disconnect();
    this.mic?.disconnect();
    this.micSilencer?.disconnect();
    void this.context?.close();
    this.stream = undefined;
    this.micSource = undefined;
    this.mic = undefined;
    this.micSilencer = undefined;
    this.context = undefined;
    this.initializing = undefined;
  }
}
