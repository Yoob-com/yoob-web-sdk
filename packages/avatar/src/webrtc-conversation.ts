// A conversation with OpenAI GPT-Live over a direct peer connection.
//
// GPT-Live cannot be reached from a page with a socket: it authenticates with an `Authorization` header and a
// browser's WebSocket cannot set one. `YoobLiveConversation` solves that by putting the model behind an agent and
// meeting it in a LiveKit room. This solves it differently: the model takes an SDP offer, so a server holding the
// project key can do the handshake and hand back only the answer -- per-session ICE and DTLS parameters, useless
// anywhere else. The audio then goes between the browser and OpenAI with nothing in between.
//
// That is the point of it. Every hop in the middle is latency to be absorbed somewhere, and the renderer absorbs it
// by making the listener wait. Taking the hop out is the cheapest latency there is.
import { YoobError, type YoobAvatar } from "./index.js";
import type { ConversationState } from "./conversation.js";
import { openPreferredMicrophone } from "./engine/audio/microphone-devices.js";

/** What your backend returns: the SDP answer, and nothing else. */
export interface YoobLiveAnswer {
  sdp: string;
}

export interface YoobWebRTCConversationOptions {
  /**
   * Hands your backend the browser's SDP offer and returns the model's answer.
   *
   * Your backend makes the call that starts the session, with your OpenAI key. Called once per `start()`: an answer
   * belongs to one peer connection.
   */
  getAnswer: (offer: string) => Promise<YoobLiveAnswer>;
  /** Publish the user's microphone. Default true. */
  microphone?: boolean;
  /** Meter this conversation to your workspace (default true). */
  meter?: boolean;
  onState?: (state: ConversationState) => void;
  /** What the user is saying, as the model hears it. */
  onUserTranscript?: (text: string, final: boolean) => void;
  /** What the character is saying, as it streams. */
  onAssistantTranscript?: (text: string, final: boolean) => void;
  onError?: (error: YoobError) => void;
}

/** The label the model expects; it must exist in the offer. */
const EVENTS_CHANNEL = "oai-events";
/** Long enough for a slow network to finish gathering, short enough not to look hung. */
const ICE_TIMEOUT_MS = 3000;

/**
 * A spoken conversation with GPT-Live, rendered by a Yoob character.
 *
 * The model is full-duplex and runs its own turn-taking: it listens while it speaks and yields on its own. There is
 * no barge-in to perform, which is why this is so much smaller than the Realtime one.
 */
export class YoobWebRTCConversation {
  #pc?: RTCPeerConnection;
  #channel?: RTCDataChannel;
  #untap?: () => void;
  #microphone?: MediaStream;
  #state: ConversationState = "idle";
  #starting = false;
  #closing = false;

  constructor(private readonly avatar: YoobAvatar, private readonly options: YoobWebRTCConversationOptions) {}

  get state(): ConversationState {
    return this.#state;
  }

  /** Opens the connection and starts listening. Call from a click: it asks for the microphone and unlocks sound. */
  async start(): Promise<void> {
    if (this.#pc || this.#starting) return;
    this.#starting = true;
    this.#closing = false;
    this.#setState("connecting");

    const pc = new RTCPeerConnection();
    this.#pc = pc;
    try {
      // Resume audio while the click still counts as a user gesture, then finish loading.
      const unlocked = this.avatar.unlockAudio();
      await this.avatar.prepare();
      await unlocked;

      // The channel is created before the offer so the offer carries an m=application section, which the model
      // requires. Its events are the only ones that cross it: audio rides the media tracks.
      this.#channel = pc.createDataChannel(EVENTS_CHANNEL);
      this.#channel.onmessage = (event) => this.#event(event.data);

      pc.ontrack = (event) => void this.#listen(event.streams[0] ?? new MediaStream([event.track]));
      pc.onconnectionstatechange = () => {
        if (this.#closing) return;
        if (pc.connectionState === "connected") this.#setState("listening");
        if (pc.connectionState === "failed") this.#fail(new YoobError("network", "The conversation disconnected."));
      };

      if (this.options.microphone ?? true) {
        // Opened directly rather than through `avatar.microphone`: that routes capture into the PCM worklet a socket
        // needs, and here the track goes to the model as media. The shared helper carries the same constraints --
        // echo cancellation above all, since the model hears itself through the speakers otherwise.
        const opened = await openPreferredMicrophone(navigator.mediaDevices, null);
        this.#microphone = opened.stream;
        for (const track of opened.stream.getAudioTracks()) pc.addTrack(track, opened.stream);
      }

      await pc.setLocalDescription(await pc.createOffer());
      await this.#gathered(pc);
      if (this.#closing) return;

      const answer = await this.options.getAnswer(pc.localDescription!.sdp);
      if (this.#closing) return;
      if (!answer?.sdp) throw new YoobError("unsupported", "The backend returned no SDP answer.");
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });

      // The connection is live and the character can hear: this is the session the user is paying for.
      if (this.options.meter ?? true) await this.avatar.startMetering();
      this.#starting = false;
    } catch (error) {
      this.#starting = false;
      const failure = error instanceof YoobError ? error : new YoobError("network", message(error));
      void this.stop();
      this.options.onError?.(failure);
      throw failure;
    }
  }

  /**
   * Ends the conversation and releases the microphone. The character stays on screen.
   *
   * Async to match `YoobLiveConversation.stop()`, so an app can swap one transport for the other without changing
   * how it tears down -- and so the metered session is known to be closed when this resolves, rather than merely
   * asked to close.
   */
  async stop(): Promise<void> {
    this.#closing = true;
    this.#untap?.();
    this.#untap = undefined;
    this.#microphone?.getTracks().forEach((track) => track.stop());
    this.#microphone = undefined;
    this.avatar.interrupt();
    this.#channel?.close();
    this.#channel = undefined;
    this.#pc?.close();
    this.#pc = undefined;
    this.#setState("ended");
    await this.avatar.endSession().catch(() => undefined);
  }

  /** Her voice, straight into the character. */
  async #listen(stream: MediaStream): Promise<void> {
    if (this.#closing) return;
    this.#untap?.();
    this.#untap = await this.avatar.attachMediaStream(stream, (pcm) => {
      if (!this.#closing) this.avatar.speak(pcm);
    });
  }

  /** Waits for ICE, but never forever: a candidate or two is enough to connect. */
  #gathered(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (pc.iceGatheringState !== "complete") return;
        pc.removeEventListener("icegatheringstatechange", done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        pc.removeEventListener("icegatheringstatechange", done);
        resolve();
      }, ICE_TIMEOUT_MS);
      pc.addEventListener("icegatheringstatechange", done);
    });
  }

  #event(raw: unknown): void {
    if (typeof raw !== "string") return;
    let event: { type?: string; delta?: string };
    try { event = JSON.parse(raw); } catch { return; }
    switch (event.type) {
      case "session.input_transcript.delta":
        return this.options.onUserTranscript?.(event.delta ?? "", false);
      case "session.output_transcript.delta":
        return this.options.onAssistantTranscript?.(event.delta ?? "", false);
      default:
    }
  }

  #fail(error: YoobError): void {
    void this.stop();
    this.options.onError?.(error);
  }

  #setState(state: ConversationState): void {
    if (state === this.#state) return;
    this.#state = state;
    this.options.onState?.(state);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
