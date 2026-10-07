import type {
  AudioCaptureOptions, Participant, RemoteAudioTrack, RemoteParticipant, Room, TextStreamReader, TranscriptionSegment,
} from "livekit-client";

// The built file imports the core's own `index.js` (see vite.config.ts), so both entries share one YoobError class.
import { YoobError, type ConversationState, type YoobAvatar } from "./index.js";

export type { ConversationState };

/** What a LiveKit agent reports in its `lk.agent.state` attribute. */
export type AgentState = "initializing" | "idle" | "listening" | "thinking" | "speaking";

export interface YoobLiveKitSessionOptions {
  /** A LiveKit room, connected before `start()`. The session never disconnects it. */
  room: Room;
  /**
   * The agent's participant identity. By default the first participant that LiveKit marks as an agent, or that
   * publishes an `lk.agent.state` attribute.
   */
  agentIdentity?: string;
  /**
   * Meter this conversation to your Yoob workspace (default true).
   *
   * The session's own rate decides what a minute costs — `full` for avatar and voice, `avatar` for the character
   * alone — and the SDK's heartbeat is what bills it. Yoob never reads your LiveKit, your agent or your voice
   * provider, so this is the only meter and it does not care whose infrastructure the conversation ran on.
   *
   * Set it false only when the avatar is a passenger in a call you are billing some other way.
   */
  meter?: boolean;
  /**
   * Publish the user's microphone through LiveKit (default true, with echo cancellation). Pass capture options to pick
   * a device, or false to publish it yourself.
   */
  microphone?: boolean | AudioCaptureOptions;
  /**
   * Silence that ends an utterance when the agent does not report its state. Default 600 ms. With agent state, the
   * utterance ends once the agent leaves `speaking` and 300 ms of silence follow.
   */
  silenceMs?: number;
  onState?: (state: ConversationState) => void;
  /** What the user is saying; `final` once the turn is transcribed. */
  onUserTranscript?: (text: string, final: boolean) => void;
  /** What the character is saying, as it streams. */
  onAssistantTranscript?: (text: string, final: boolean) => void;
  onError?: (error: YoobError) => void;
}

const AGENT_STATE_ATTRIBUTE = "lk.agent.state";
const TRANSCRIPTION_TOPIC = "lk.transcription";
const TRANSCRIPTION_FINAL = "lk.transcription_final";
const TRANSCRIBED_TRACK = "lk.transcribed_track_id";
const AGENT_KIND = 4; // livekit ParticipantInfo.Kind.AGENT
const SAMPLES_PER_MS = 24;
/** Peak below which a 20 ms packet counts as silence (about −57 dBFS). */
const AUDIBLE_PEAK = 48;
const STATE_TAIL_MS = 300;
/** A user transcript this recent means the user is talking. */
const USER_SPEECH_RECENT_MS = 1_500;
const AGENT_STATES = new Set<string>(["initializing", "idle", "listening", "thinking", "speaking"]);

type Listener = (...args: never[]) => void;
type Emitter = {
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
};

/**
 * Shows a LiveKit voice agent as a Yoob character. The agent's audio track is decoded in the browser and played by the
 * avatar, so the face moves with it: no avatar server and no video track. The agent needs nothing special.
 *
 * Replies are split into utterances with the agent's `lk.agent.state` attribute, or with silence when the agent does
 * not report a state. When the agent stops speaking because the user talked over it, the character stops at once.
 */
export class YoobLiveKitSession {
  private stateValue: ConversationState = "idle";
  private agentStateValue?: AgentState;
  private agent?: Participant;
  private track?: RemoteAudioTrack;
  private detach?: () => void;
  private attaching?: RemoteAudioTrack;
  private readonly offs: Array<() => void> = [];
  private running = false;
  private publishedMicrophone = false;
  // Utterance segmentation.
  private open = false;
  private suppressed = false;
  private pending: Int16Array[] = [];
  private silentSamples = 0;
  // Barge-in evidence.
  private userSpeaking = false;
  private lastUserTranscriptAt = -Infinity;
  // Transcripts.
  private readonly legacySegments = { user: new Map<string, string>(), assistant: new Map<string, string>() };

  constructor(private readonly avatar: YoobAvatar, private readonly options: YoobLiveKitSessionOptions) {}

  get state(): ConversationState { return this.stateValue; }
  /** The agent's last reported state, if it reports one. */
  get agentState(): AgentState | undefined { return this.agentStateValue; }
  /** The participant whose audio the character speaks. */
  get agentParticipant(): Participant | undefined { return this.agent; }

  /** Starts rendering the agent and publishes the microphone. Call from a click: it unlocks sound. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.setState("connecting");
    const { room } = this.options;
    try {
      // Resume audio while the click still counts as a user gesture, then finish loading.
      const unlocked = this.avatar.unlockAudio();
      await this.avatar.prepare();
      await unlocked;
      this.listen();
      this.registerTranscripts();
      for (const participant of room.remoteParticipants.values()) this.consider(participant);
      const microphone = this.options.microphone ?? true;
      if (microphone !== false) {
        const capture: AudioCaptureOptions = {
          echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
          ...(microphone === true ? {} : microphone),
        };
        await room.localParticipant.setMicrophoneEnabled(true, capture);
        // stop() may have run while the microphone was opening.
        if (!this.running) {
          await room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
          return;
        }
        this.publishedMicrophone = true;
      }
      if (!this.running) return;

      // The session is live now, so start the meter now.
      //
      // Without this the clock starts at the character's first word, because `speak()` starts it as a fallback for an
      // app driving the avatar itself. That fallback is right for an app we know nothing about and wrong here: a user
      // talking for thirty seconds before any reply would be thirty unbilled seconds, and a character that never
      // speaks would never be billed at all.
      //
      // Inside the `running` guard on purpose: a start that was cancelled while the microphone was opening must not
      // leave a metered session behind. And awaited, so a workspace with no credit is refused before anyone speaks
      // rather than after.
      if (this.options.meter ?? true) await this.avatar.startMetering();
      if (!this.running) return;

      this.setState(this.agent ? this.stateFromAgent() : "connecting");
    } catch (error) {
      const failure = error instanceof YoobError ? error : new YoobError("network", errorText(error));
      await this.stop();
      this.options.onError?.(failure);
      throw failure;
    }
  }

  /** Stops rendering, unpublishes the microphone this session published and removes its listeners. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const off of this.offs.splice(0)) off();
    this.closeUtterance(true);
    this.releaseTrack();
    this.agent = undefined;
    this.agentStateValue = undefined;
    this.userSpeaking = false;
    this.legacySegments.user.clear();
    this.legacySegments.assistant.clear();
    const microphone = this.publishedMicrophone;
    this.publishedMicrophone = false;
    this.setState("ended");
    if (microphone) await this.options.room.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
  }

  private listen(): void {
    const { room } = this.options;
    const emitter = room as unknown as Emitter;
    const on = (event: string, listener: Listener) => {
      emitter.on(event, listener);
      this.offs.push(() => emitter.off(event, listener));
    };
    on("participantConnected", ((participant: RemoteParticipant) => this.consider(participant)) as Listener);
    on("participantAttributesChanged", ((_changed: unknown, participant: Participant) => {
      if (participant !== room.localParticipant) this.consider(participant);
    }) as Listener);
    on("trackSubscribed", ((track: RemoteAudioTrack, _publication: unknown, participant: RemoteParticipant) => {
      this.consider(participant);
      if (participant === this.agent && String(track.kind) === "audio") this.attach(track);
    }) as Listener);
    on("trackUnsubscribed", ((track: RemoteAudioTrack) => {
      if (track === this.track) this.releaseTrack();
    }) as Listener);
    on("participantDisconnected", ((participant: RemoteParticipant) => {
      if (participant !== this.agent) return;
      this.closeUtterance(true);
      this.releaseTrack();
      this.agent = undefined;
      this.agentStateValue = undefined;
      this.setState("connecting");
      // Another agent may already be in the room.
      for (const other of room.remoteParticipants.values()) this.consider(other);
    }) as Listener);
    on("activeSpeakersChanged", ((speakers: Participant[]) => {
      this.userSpeaking = speakers.some((speaker) => speaker.identity === room.localParticipant.identity);
    }) as Listener);
    on("disconnected", (() => void this.stop()) as Listener);
  }

  /** Adopts `participant` as the agent if it is one, then follows its state and audio. */
  private consider(participant: Participant): void {
    if (!this.agent) {
      if (!this.isAgent(participant)) return;
      this.agent = participant;
    }
    if (participant !== this.agent) return;
    this.readAgentState();
    for (const publication of (participant as RemoteParticipant).audioTrackPublications.values()) {
      if (publication.track) {
        this.attach(publication.track as RemoteAudioTrack);
        break;
      }
      if (!publication.isSubscribed) publication.setSubscribed(true);
    }
  }

  private isAgent(participant: Participant): boolean {
    if (this.options.agentIdentity) return participant.identity === this.options.agentIdentity;
    return participant.isAgent || Number(participant.kind) === AGENT_KIND
      || participant.attributes?.[AGENT_STATE_ATTRIBUTE] !== undefined;
  }

  private attach(track: RemoteAudioTrack): void {
    if (track === this.track || track === this.attaching || !this.running) return;
    this.releaseTrack();
    this.attaching = track;
    this.avatar.attachAudioTrack(track, (pcm) => {
      if (this.track === track || this.attaching === track) this.handleAudio(pcm);
    }).then((detach) => {
      if (this.attaching !== track || !this.running) {
        detach();
        return;
      }
      this.attaching = undefined;
      this.track = track;
      this.detach = detach;
    }, (error: unknown) => {
      if (this.attaching === track) this.attaching = undefined;
      this.options.onError?.(new YoobError("renderer", `Couldn't play the agent's audio: ${errorText(error)}`));
    });
  }

  private releaseTrack(): void {
    this.detach?.();
    this.detach = undefined;
    this.track = undefined;
    this.attaching = undefined;
    this.closeUtterance(false);
  }

  private readAgentState(): void {
    const value = this.agent?.attributes?.[AGENT_STATE_ATTRIBUTE];
    if (!value || !AGENT_STATES.has(value) || value === this.agentStateValue) return;
    const previous = this.agentStateValue;
    const next = value as AgentState;
    this.agentStateValue = next;
    if (previous === "speaking" && this.open && this.userIsSpeaking()) {
      // The agent was cut off: drop what is still queued and the audio still in flight.
      this.closeUtterance(true);
      this.suppressed = true;
    } else if (previous === "speaking") {
      this.silentSamples = 0;
    }
    if (next === "thinking" || next === "speaking") this.suppressed = false;
    this.setState(this.stateFromAgent());
  }

  private userIsSpeaking(): boolean {
    return this.userSpeaking || this.options.room.localParticipant.isSpeaking
      || performance.now() - this.lastUserTranscriptAt < USER_SPEECH_RECENT_MS;
  }

  /** Splits the track's continuous sound into utterances. */
  private handleAudio(pcm: Int16Array): void {
    if (this.suppressed || this.stateValue === "ended") return;
    const audible = peak(pcm) >= AUDIBLE_PEAK;
    if (!this.open) {
      if (!audible) return;
      this.open = true;
      this.pending = [];
      this.silentSamples = 0;
      if (!this.agentStateValue) this.setState("speaking");
    }
    const speakingNow = this.agentStateValue === "speaking";
    if (audible || speakingNow) {
      // A pause inside a reply keeps its length.
      for (const held of this.pending.splice(0)) this.speak(held);
      this.silentSamples = 0;
      this.speak(pcm);
      return;
    }
    this.pending.push(pcm);
    this.silentSamples += pcm.length;
    const gateMs = this.agentStateValue ? STATE_TAIL_MS : this.options.silenceMs ?? 600;
    if (this.silentSamples >= gateMs * SAMPLES_PER_MS) this.closeUtterance(false);
  }

  private speak(pcm: Int16Array): void {
    try {
      this.avatar.speak(pcm);
    } catch (error) {
      this.closeUtterance(false);
      this.options.onError?.(error instanceof YoobError ? error : new YoobError("renderer", errorText(error)));
    }
  }

  /** Ends the utterance. Trailing silence is dropped; `cut` also stops what is still playing. */
  private closeUtterance(cut: boolean): void {
    const wasOpen = this.open;
    this.open = false;
    this.pending = [];
    this.silentSamples = 0;
    if (cut) this.avatar.interrupt();
    else if (wasOpen) this.avatar.endSpeech();
    if (wasOpen && !this.agentStateValue && this.stateValue === "speaking") this.setState("listening");
  }

  private stateFromAgent(): ConversationState {
    const state = this.agentStateValue;
    if (state === "speaking" || state === "thinking") return state;
    if (!state && this.open) return "speaking";
    return state === "initializing" ? "connecting" : "listening";
  }

  private registerTranscripts(): void {
    const { room } = this.options;
    if (typeof room.registerTextStreamHandler === "function") {
      try {
        room.registerTextStreamHandler(TRANSCRIPTION_TOPIC, (reader, from) => void this.readTranscript(reader, from.identity));
        this.offs.push(() => room.unregisterTextStreamHandler(TRANSCRIPTION_TOPIC));
        return;
      } catch {
        // The app already reads this topic; fall back to transcription events.
      }
    }
    const emitter = room as unknown as Emitter;
    const listener = ((segments: TranscriptionSegment[], participant?: Participant) => {
      const user = participant?.identity === room.localParticipant.identity;
      const known = this.legacySegments[user ? "user" : "assistant"];
      for (const segment of segments) known.set(segment.id, segment.text);
      const text = [...known.values()].join(" ").replace(/\s+/g, " ").trim();
      const final = segments.every((segment) => segment.final);
      this.transcript(user, text, final);
      if (final && segments.length) known.clear();
    }) as Listener;
    emitter.on("transcriptionReceived", listener);
    this.offs.push(() => emitter.off("transcriptionReceived", listener));
  }

  private async readTranscript(reader: TextStreamReader, identity: string): Promise<void> {
    const { room } = this.options;
    const attributes = reader.info.attributes ?? {};
    const trackId = attributes[TRANSCRIBED_TRACK];
    const local = room.localParticipant;
    const user = identity === local.identity
      || (trackId !== undefined && [...local.trackPublications.values()].some((publication) => publication.trackSid === trackId));
    // Agents send their own words as deltas in one stream per segment, and the user's words as whole texts.
    let text = "";
    try {
      for await (const chunk of reader) {
        if (!this.running) return;
        text += chunk;
        this.transcript(user, text.trim(), false);
      }
    } catch {
      return;
    }
    if (!this.running) return;
    const final = attributes[TRANSCRIPTION_FINAL] === "true" || !user;
    if (final) this.transcript(user, text.trim(), true);
  }

  private transcript(user: boolean, text: string, final: boolean): void {
    if (!this.running) return;
    if (user) {
      this.lastUserTranscriptAt = performance.now();
      this.options.onUserTranscript?.(text, final);
    } else {
      this.options.onAssistantTranscript?.(text, final);
    }
  }

  private setState(state: ConversationState): void {
    if (this.stateValue === state) return;
    if (this.stateValue === "ended" && state !== "connecting") return;
    this.stateValue = state;
    this.options.onState?.(state);
  }
}

function peak(pcm: Int16Array): number {
  let max = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const value = Math.abs(pcm[i]);
    if (value > max) max = value;
  }
  return max;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Shipped from this entry rather than the root: it needs `livekit-client`, which is an optional peer dependency, so
// an app using only the Realtime path never pulls it in.
export {
  YoobLiveConversation, type YoobLiveConversationOptions, type YoobLiveSession,
} from "./live-conversation.js";
