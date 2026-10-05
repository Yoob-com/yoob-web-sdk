import { YoobError } from "./cdn";
import type { YoobAvatar } from "./index";

/** Turn-taking settings passed to OpenAI Realtime. */
export type TurnDetection =
  | { type: "server_vad"; silenceMs?: number; threshold?: number; prefixPaddingMs?: number }
  | { type: "semantic_vad"; eagerness?: "low" | "medium" | "high" | "auto" };

/**
 * What `POST https://api2.yoob.com/api/v1/voice/sessions` returns to your backend. Pass the whole response to the page.
 * The token opens one conversation and must be used within 5 minutes, so fetch a new one for every `start()`.
 */
export interface YoobVoiceSession {
  voice_token: string;
  /** The Yoob voice relay, for example `wss://voice.yoob.com/v1/realtime?model=gpt-realtime-2.1-mini`. */
  url: string;
  voice_session_id?: string;
  model?: string;
  max_seconds?: number;
  credits_per_minute?: number;
  expires_at?: string;
}

export interface YoobConversationOptions {
  /**
   * Bundled voice: returns a Yoob voice session from your backend, which calls
   * `POST https://api2.yoob.com/api/v1/voice/sessions` with your Yoob API key. No OpenAI key needed; minutes are billed
   * to your Yoob workspace. Pass this or `getClientSecret`, not both.
   */
  getVoiceSession?: () => Promise<YoobVoiceSession>;
  /**
   * Hosts a Yoob voice session may connect to. Default `["*.yoob.com"]`: a session URL anywhere else is refused, so a
   * compromised or misconfigured backend can't send microphone audio elsewhere. Override only to self-host the relay,
   * for example `["voice.example.com"]`. `*.` matches any subdomain. Only `wss://` URLs are accepted.
   */
  voiceHosts?: string[];
  /**
   * Your own OpenAI account: returns a short-lived OpenAI Realtime client secret from your backend
   * (`POST https://api.openai.com/v1/realtime/client_secrets`). Never put your OpenAI key in a page.
   */
  getClientSecret?: () => Promise<string>;
  /** OpenAI model. With `getVoiceSession`, the session's `url` picks the model instead. */
  model?: string;
  /**
   * The character's voice. With `getVoiceSession`, a voice or instructions set on your backend take precedence and
   * never reach the page; the ones set here are used only when the backend left them out.
   */
  voice?: string;
  instructions?: string;
  /**
   * Spoken speed, 0.25–1.5. Default 1.08, which the Yoob demo measured as natural but snappy.
   * With `getVoiceSession`, Yoob sets speed, turn detection, noise reduction and transcription, and these options are
   * ignored.
   */
  speed?: number;
  /**
   * Default `server_vad` with a 450 ms silence window: replies start about 0.8 s sooner than `semantic_vad`, which
   * waits to judge whether a sentence is finished. Raise `threshold` for noisy rooms instead of muting the mic.
   */
  turnDetection?: TurnDetection;
  /** `far_field` (default) suits laptops and kiosks; `near_field` suits headsets. */
  noiseReduction?: "far_field" | "near_field" | null;
  /** Transcribe what the user says (for captions). Default `gpt-4o-mini-transcribe`; null turns it off. */
  transcriptionModel?: string | null;
  /** Have the character speak first. */
  greet?: boolean;
  onState?: (state: ConversationState) => void;
  /** What the user is saying; `final` once the turn is transcribed. */
  onUserTranscript?: (text: string, final: boolean) => void;
  /** What the character is saying, as it streams. */
  onAssistantTranscript?: (text: string, final: boolean) => void;
  onError?: (error: YoobError) => void;
}

export type ConversationState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "ended";

const REALTIME_URL = "wss://api.openai.com/v1/realtime";
const GRANT_PROTOCOL = "yoob-voice-grant.";

/** What the Yoob voice relay's close codes mean to the person using the app. */
export function voiceCloseError(code: number, reason = ""): YoobError {
  const messages: Record<number, string> = {
    1011: "The voice service disconnected. Start the conversation again.",
    1013: "Voice is busy right now. Try again in a moment.",
    4000: "The voice service refused this app's request. Update the app and try again.",
    4001: "The voice session was refused. Start the conversation again.",
    4002: "The voice session expired before it connected. Start the conversation again.",
    4003: "This voice session was already used. Start the conversation again.",
    4008: "This conversation reached its usage limit.",
    4009: "This conversation reached its time limit.",
    4010: "The conversation ended because it was idle for too long.",
    4029: "Voice has reached its usage limit for now. Try again later.",
  };
  return new YoobError("voice-session", messages[code] ?? `The conversation disconnected (${code}).`, { closeCode: code, closeReason: reason });
}

export const DEFAULT_VOICE_HOSTS: readonly string[] = ["*.yoob.com"];

/** Whether `url` is a `wss://` URL on one of `hosts` (exact names, or `*.domain` for any subdomain of it). */
export function isAllowedVoiceUrl(url: string, hosts: readonly string[] = DEFAULT_VOICE_HOSTS): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "wss:" || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return hosts.some((entry) => {
    const pattern = entry.trim().toLowerCase();
    if (pattern.startsWith("*.")) {
      const domain = pattern.slice(2);
      return domain.length > 0 && host.endsWith(`.${domain}`);
    }
    return pattern.length > 0 && host === pattern;
  });
}

/** Checks what the backend returned, and turns a passed-through Yoob API error into the matching `YoobError`. */
export function checkVoiceSession(session: unknown, hosts: readonly string[] = DEFAULT_VOICE_HOSTS): YoobVoiceSession {
  const value = (session ?? {}) as Partial<YoobVoiceSession> & { code?: string; error?: string };
  if (typeof value.voice_token === "string" && value.voice_token && typeof value.url === "string") {
    if (!/^wss:\/\//i.test(value.url)) throw new YoobError("voice-session", "The voice session URL must use wss://.");
    if (!isAllowedVoiceUrl(value.url, hosts)) {
      throw new YoobError("voice-session",
        "The voice session URL isn't on an allowed host. Yoob voice runs on *.yoob.com; set voiceHosts to self-host.");
    }
    return value as YoobVoiceSession;
  }
  if (value.code === "quota_exceeded") throw new YoobError("out-of-credit", "This Yoob workspace is out of voice credit.");
  if (value.error || value.code) throw new YoobError("unauthorized", `Yoob didn't create a voice session: ${value.error ?? value.code}.`);
  throw new YoobError("voice-session", "The backend didn't return a Yoob voice session.");
}

interface ServerEvent {
  type: string;
  delta?: string;
  transcript?: string;
  response_id?: string;
  item_id?: string;
  response?: { id?: string; status?: string };
  item?: { id?: string };
  error?: { code?: string; type?: string; message?: string };
}

/**
 * A spoken conversation between the user and a Yoob character, over the OpenAI Realtime protocol: either Yoob voice
 * (`getVoiceSession`, no provider key, billed through your Yoob workspace) or your own OpenAI account
 * (`getClientSecret`). Microphone audio goes from the browser to the voice service; replies stream into the avatar,
 * which plays them in sync.
 * Speaking over the character interrupts it, and the model is told how much of its reply was heard.
 *
 * This is what starts and stops the metered session: `start()` starts the meter once the microphone is live, and
 * `stop()` ends the session so the last slice is billed and nothing accrues after the user is done.
 */
export class YoobConversation {
  private socket?: WebSocket;
  private stateValue: ConversationState = "idle";
  private unsubscribe: Array<() => void> = [];
  private activeResponse?: string;
  private playingItem?: string;
  private readonly finished = new Set<string>();
  private userText = "";
  private assistantText = "";
  private closing = false;
  private starting = false;
  private closeFailure?: YoobError;

  constructor(private readonly avatar: YoobAvatar, private readonly options: YoobConversationOptions) {
    if (!options.getVoiceSession === !options.getClientSecret) {
      throw new YoobError("unsupported", "Pass either getVoiceSession (Yoob voice) or getClientSecret (your OpenAI account).");
    }
  }

  private get bundled(): boolean { return Boolean(this.options.getVoiceSession); }

  get state(): ConversationState { return this.stateValue; }

  /** Starts listening. Call from a click: it asks for the microphone and unlocks sound. */
  async start(options: { deviceId?: string | null } = {}): Promise<void> {
    if (this.socket) return;
    this.closing = false;
    this.starting = true;
    this.closeFailure = undefined;
    this.setState("connecting");
    try {
      await this.avatar.prepare();
      await this.avatar.unlockAudio();
      if (this.options.getVoiceSession) {
        // A voice session opens one connection and can't be refreshed, so it is fetched right before connecting.
        const session = checkVoiceSession(await this.options.getVoiceSession(), this.options.voiceHosts ?? DEFAULT_VOICE_HOSTS);
        await this.open(session.url, ["realtime", GRANT_PROTOCOL + session.voice_token], "Yoob voice");
        this.configureVoice();
      } else {
        const secret = await this.options.getClientSecret!();
        const model = encodeURIComponent(this.options.model ?? "gpt-realtime");
        // Browsers can't set headers on WebSockets; OpenAI accepts an ephemeral secret as a subprotocol.
        await this.open(`${REALTIME_URL}?model=${model}`, ["realtime", `openai-insecure-api-key.${secret}`], "OpenAI Realtime");
        this.configure();
      }
      const microphone = this.avatar.microphone;
      this.unsubscribe.push(microphone.on("audio", (pcm) => this.send({ type: "input_audio_buffer.append", audio: toBase64(pcm) })));
      await microphone.start(options);
      if (this.closing) { this.starting = false; this.stop(); return; } // stop() was called while starting.
      // The service may close the socket while the microphone permission prompt is open (an expired grant, a quota).
      if (!this.socket) throw this.closeFailure ?? new YoobError("network", "The conversation disconnected.");
      // The microphone is live and the character can hear: this is the session the user is paying for, so the meter
      // starts here rather than at prepare(), which only downloaded the character. A refusal stops the conversation
      // before any of it happens.
      await this.avatar.startMetering();
      this.starting = false;
      this.setState("listening");
      if (this.options.greet) this.send({ type: "response.create" });
    } catch (error) {
      this.starting = false;
      const failure = error instanceof YoobError ? error : new YoobError("network", errorText(error));
      this.stop();
      this.options.onError?.(failure);
      throw failure;
    }
  }

  /** Sends typed text as the user's turn. */
  sendText(text: string): void {
    if (!text.trim()) return;
    this.bargeIn();
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    this.send({ type: "response.create" });
    this.setState("thinking");
  }

  /**
   * Ends the conversation, releases the microphone and ends the metered session, so nothing is billed past the
   * moment the user stopped talking. The character stays on screen; `start()` opens a fresh session.
   */
  stop(): void {
    this.closing = true;
    for (const off of this.unsubscribe.splice(0)) off();
    this.avatar.microphone.stop();
    this.avatar.interrupt();
    void this.avatar.endSession();
    this.socket?.close(1000, "done");
    this.socket = undefined;
    this.activeResponse = undefined;
    this.playingItem = undefined;
    this.setState("ended");
  }

  private open(url: string, protocols: string[], service: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, protocols);
      const timer = setTimeout(() => { socket.close(); reject(new YoobError("network", `${service} didn't answer in time.`)); }, 15_000);
      socket.onopen = () => { clearTimeout(timer); this.socket = socket; resolve(); };
      socket.onerror = () => {
        clearTimeout(timer);
        const hint = this.bundled ? "Check the network connection." : "Check the client secret.";
        reject(new YoobError("network", `Couldn't connect to ${service}. ${hint}`));
      };
      socket.onmessage = (event) => this.handle(String(event.data));
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        if (this.closing) return;
        const failure = this.bundled
          ? voiceCloseError(event.code, event.reason)
          : new YoobError("network", `The conversation disconnected (${event.code}).`);
        // During start(), start() reports the failure once.
        if (this.starting) { this.closeFailure = failure; return; }
        this.options.onError?.(failure);
        this.stop();
      };
    });
  }

  /**
   * Yoob voice configures the session itself. The relay accepts only instructions and voice from the page, and only
   * when the backend didn't set them, so each goes in its own update: a refused one doesn't block the other.
   */
  private configureVoice(): void {
    if (this.options.instructions) this.send({ type: "session.update", session: { instructions: this.options.instructions } });
    if (this.options.voice) this.send({ type: "session.update", session: { audio: { output: { voice: this.options.voice } } } });
  }

  private configure(): void {
    const turn = this.options.turnDetection ?? { type: "server_vad" };
    const turnDetection = turn.type === "semantic_vad"
      ? { type: "semantic_vad", eagerness: turn.eagerness ?? "auto", create_response: true, interrupt_response: true }
      : {
          type: "server_vad",
          silence_duration_ms: turn.silenceMs ?? 450,
          prefix_padding_ms: turn.prefixPaddingMs ?? 300,
          threshold: turn.threshold ?? 0.5,
          create_response: true,
          interrupt_response: true,
        };
    const noise = this.options.noiseReduction === undefined ? "far_field" : this.options.noiseReduction;
    const transcription = this.options.transcriptionModel === undefined ? "gpt-4o-mini-transcribe" : this.options.transcriptionModel;
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            noise_reduction: noise ? { type: noise } : null,
            transcription: transcription ? { model: transcription } : null,
            turn_detection: turnDetection,
          },
          output: {
            format: { type: "audio/pcm", rate: 24_000 },
            ...(this.options.voice ? { voice: this.options.voice } : {}),
            speed: this.options.speed ?? 1.08,
          },
        },
      },
    });
  }

  private handle(frame: string): void {
    let event: ServerEvent;
    try { event = JSON.parse(frame) as ServerEvent; } catch { return; }
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.bargeIn();
        this.userText = "";
        this.options.onUserTranscript?.("", false);
        this.setState("listening");
        return;
      case "input_audio_buffer.speech_stopped":
        this.setState("thinking");
        return;
      case "conversation.item.input_audio_transcription.delta":
        this.userText += event.delta ?? "";
        this.options.onUserTranscript?.(this.userText, false);
        return;
      case "conversation.item.input_audio_transcription.completed":
        this.userText = event.transcript ?? this.userText;
        this.options.onUserTranscript?.(this.userText, true);
        return;
      case "response.created":
        if (event.response?.id && !this.finished.has(event.response.id)) {
          this.activeResponse = event.response.id;
          this.assistantText = "";
        }
        return;
      case "response.output_item.added":
        if (event.response_id === this.activeResponse && event.item?.id) this.playingItem = event.item.id;
        return;
      case "response.output_audio.delta": {
        if (!event.delta || !event.response_id || event.response_id !== this.activeResponse) return;
        this.avatar.speak(fromBase64(event.delta));
        this.setState("speaking");
        return;
      }
      case "response.output_audio.done":
        if (event.response_id === this.activeResponse) this.avatar.endSpeech();
        return;
      case "response.output_audio_transcript.delta":
        if (event.response_id !== this.activeResponse) return;
        this.assistantText += event.delta ?? "";
        this.options.onAssistantTranscript?.(this.assistantText, false);
        return;
      case "response.output_audio_transcript.done":
        if (event.response_id === this.activeResponse) this.options.onAssistantTranscript?.(event.transcript ?? this.assistantText, true);
        return;
      case "response.done": {
        const id = event.response?.id;
        if (!id) return;
        this.finished.add(id);
        const status = event.response?.status;
        // A reply cut short by a limit still plays what arrived; a cancelled or failed one is dropped.
        if (id === this.activeResponse && status !== "completed" && status !== "incomplete") this.avatar.interrupt();
        if (id === this.activeResponse) this.avatar.endSpeech();
        if (this.stateValue === "thinking" && id === this.activeResponse) this.setState("listening");
        return;
      }
      case "error": {
        const code = event.error?.code ?? event.error?.type ?? "server_error";
        // Cancelling a reply that just finished is a harmless race.
        if (code.includes("response_cancel") || code.includes("no_active_response")) return;
        // Yoob voice: the backend already set the voice or instructions, and those win.
        if (code === "yoob_voice_locked" || code === "yoob_instructions_locked") return;
        this.options.onError?.(new YoobError("network", event.error?.message ?? code));
        return;
      }
      default:
    }
  }

  /** The user started talking: stop the character and tell the model how much of its reply was heard. */
  private bargeIn(): void {
    const heardMs = this.avatar.interrupt();
    if (this.activeResponse) {
      this.finished.add(this.activeResponse);
      this.send({ type: "response.cancel", response_id: this.activeResponse });
      if (this.playingItem) {
        this.send({ type: "conversation.item.truncate", item_id: this.playingItem, content_index: 0, audio_end_ms: Math.max(0, heardMs) });
      }
    }
    this.activeResponse = undefined;
    this.playingItem = undefined;
  }

  private send(event: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event));
  }

  private setState(state: ConversationState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.options.onState?.(state);
  }
}

export function toBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Int16Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length & ~1);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
