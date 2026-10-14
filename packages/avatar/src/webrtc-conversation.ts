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
   *
   * Leave it out for **full mode**, where Yoob opens the conversation on its own OpenAI account: the session your
   * backend opened with `mode: "full"` carries the credential and this class presents it for you, so you need no
   * OpenAI key and no handshake route of your own.
   */
  getAnswer?: (offer: string) => Promise<YoobLiveAnswer>;
  /**
   * Hosts a full-mode conversation may be opened through. Default `["*.yoob.com"]`.
   *
   * The same guarantee `voiceHosts` gives a Yoob voice session: a session response pointing anywhere else is refused,
   * so a compromised or misconfigured backend cannot negotiate the user's microphone somewhere we did not mint a
   * grant for. Only `https:` is accepted, and localhost for running the console yourself.
   */
  liveHosts?: string[];
  /** The character's prompt, when your backend pinned none at session open. Ignored if it did. */
  instructions?: string;
  /** The character's voice, when your backend pinned none at session open. Ignored if it did. */
  voice?: string;
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

/** Where a full-mode conversation may be opened. See `liveHosts`. */
export const DEFAULT_LIVE_HOSTS = ["*.yoob.com"];

/**
 * Whether a full-mode handshake URL is one we are willing to send an offer to.
 *
 * The offer itself is not a secret, but the connection it opens carries the user's microphone, so where it is
 * negotiated is worth pinning. `*.` matches any subdomain; localhost is allowed so the console can be run locally.
 */
export function isAllowedLiveUrl(value: string, hosts: string[] = DEFAULT_LIVE_HOSTS): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) return false;
  if (local) return true;
  return hosts.some((host) => (host.startsWith("*.")
    ? url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1))
    : url.hostname === host));
}

/**
 * Below this, a sample is the model's own silence rather than its voice.
 *
 * GPT-Live does not stop sending between turns: it streams a continuous 24 kHz stream and fills the gaps with zeroes.
 * Measured against the live API, 95% of the audio arriving while nobody is talking peaks at 1. Handing that to the
 * renderer makes the character mouth silence for as long as the call lasts, and the idle loop never gets a turn —
 * which is what "the avatar moves its head and lips before we start to talk" is.
 *
 * The same threshold the voice agent uses to decide when the model has the floor.
 */
const AUDIBLE_PEAK = 48;
/**
 * How long after the last audible sample the voice still counts as speaking.
 *
 * Long enough to carry the pause between two sentences, so a reply is not chopped into pieces, and short enough that
 * the character settles back to rest promptly once it has finished.
 */
const SPEECH_TAIL_MS = 400;

/**
 * Decides which audio is the character talking and which is the gap between turns.
 *
 * Silence is not dropped sample by sample: the quiet inside a sentence has to reach the renderer or the mouth loses
 * the clock, so once a sound is heard everything keeps flowing until the voice has been quiet for `tailMs`. What is
 * dropped is the long silence between replies, and dropping it is what lets the renderer run dry and the idle loop
 * come back.
 */
export class SpeechGate {
  private until = 0;
  private open = false;
  constructor(private readonly peak = AUDIBLE_PEAK, private readonly tailMs = SPEECH_TAIL_MS) {}

  /**
   * What to do with this chunk: feed it to the character, end the utterance, or nothing.
   *
   * `accepts` says whether the audio is speech; it cannot say when the speech *stopped*, and that edge is the half
   * that matters. `endSpeech()` is the only thing that finalizes the stream, the playback worklet emits `drained`
   * only for a finalized one, and without `drained` the coordinator never rests: it holds the last speech frame on
   * screen, never returns to the idle still, and treats the next reply as a continuation of a stream that already
   * stopped. "end" is returned once per reply, on the first chunk after the tail expires.
   */
  update(pcm: Int16Array, now: number): "speak" | "end" | "idle" {
    if (this.accepts(pcm, now)) {
      this.open = true;
      return "speak";
    }
    if (!this.open) return "idle";
    this.open = false;
    return "end";
  }

  accepts(pcm: Int16Array, now: number): boolean {
    let loudest = 0;
    for (let i = 0; i < pcm.length; i += 1) {
      const level = Math.abs(pcm[i]);
      if (level > loudest) loudest = level;
    }
    if (loudest >= this.peak) {
      this.until = now + this.tailMs;
      return true;
    }
    return now < this.until;
  }
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
  #gate = new SpeechGate();

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

      const answer = await this.#answer(pc.localDescription!.sdp);
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

  /**
   * The model's answer, from whichever side is paying for the conversation.
   *
   * With `getAnswer`, the integrator's backend holds an OpenAI key and does the handshake. Without it, this is full
   * mode: the session Yoob opened carries a grant, and the offer goes to Yoob instead. One of the two must be there —
   * a session opened as `mode: "avatar"` has no grant, and that is the mistake this message is for.
   */
  async #answer(offer: string): Promise<YoobLiveAnswer> {
    if (this.options.getAnswer) return this.options.getAnswer(offer);

    const live = this.avatar.liveSession;
    if (!live) {
      throw new YoobError("unsupported",
        'This session has no voice. Open it with mode: "full" for Yoob voice, or pass getAnswer to use your own '
        + "OpenAI key.");
    }
    if (!isAllowedLiveUrl(live.url, this.options.liveHosts ?? DEFAULT_LIVE_HOSTS)) {
      throw new YoobError("unsupported", `Refusing to open a conversation at ${live.url}.`);
    }

    const response = await fetch(live.url, {
      method: "POST",
      credentials: "omit",
      headers: { authorization: `Bearer ${live.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        sdp: offer,
        // Used only when the backend pinned neither; the server ignores them otherwise.
        ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
        ...(this.options.voice ? { voice: this.options.voice } : {}),
      }),
    });
    const body = await response.json().catch(() => null) as { sdp?: string; error?: string } | null;
    if (!response.ok) {
      const message = body?.error ?? `Yoob refused the conversation (${response.status}).`;
      // 424 is the voice model failing rather than us refusing: it is worth retrying, which "unauthorized" is not.
      const kind = response.status === 402 ? "out-of-credit" : response.status === 424 ? "network" : "unauthorized";
      throw new YoobError(kind, message);
    }
    return { sdp: body?.sdp ?? "" };
  }

  /** Her voice, straight into the character — and only her voice. */
  async #listen(stream: MediaStream): Promise<void> {
    if (this.#closing) return;
    this.#untap?.();
    this.#untap = await this.avatar.attachMediaStream(stream, (pcm) => {
      if (this.#closing) return;
      // Both halves, as the LiveKit path already does in `closeUtterance`: feed the voice, and end the utterance
      // when it stops. Only speaking was wired up here, so the character rendered one sentence and froze.
      const action = this.#gate.update(pcm, performance.now());
      if (action === "speak") this.avatar.speak(pcm);
      else if (action === "end") this.avatar.endSpeech();
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
