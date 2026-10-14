import { YoobError } from "./cdn";
import { errorText, fromBase64, toBase64, type ConversationState } from "./conversation";
import type { YoobAvatar } from "./index";
import { PcmResampler } from "./resampler";

/** Gemini's voice activity detection. Every field is optional; see the defaults on each. */
export interface GeminiActivityDetection {
  /**
   * How readily speech is detected. Default `"high"` (Gemini's own default), so the user can interrupt quickly.
   * Use `"low"` in noisy rooms instead of muting the microphone.
   */
  startSensitivity?: "high" | "low";
  /** How readily the user's turn is judged finished. Default `"high"`, which ends turns sooner. */
  endSensitivity?: "high" | "low";
  /** Speech needed before a turn starts. Default 100 ms. */
  prefixPaddingMs?: number;
  /** Silence that ends a turn. Default 450 ms, the window Yoob measured as fastest for OpenAI Realtime. */
  silenceDurationMs?: number;
}

export interface YoobGeminiConversationOptions {
  /**
   * Returns a Gemini Live ephemeral token (the `name` of `client.authTokens.create()`, `auth_tokens/…`) from your
   * backend. Never put your Gemini API key in a page.
   */
  getToken: () => Promise<string>;
  /** Live model. Default `gemini-3.8-live`, Google's recommended low-latency native-audio model. */
  model?: string;
  /** Prebuilt voice name, for example `"Kore"` or `"Puck"`. Gemini picks one by default. */
  voice?: string;
  systemInstruction?: string;
  /** Have the character speak first. Pass a string to say what to prompt it with. */
  greet?: boolean | string;
  /** Transcribe what the user says (for captions). Default true. */
  inputTranscription?: boolean;
  /** Transcribe what the character says. Default true. */
  outputTranscription?: boolean;
  activityDetection?: GeminiActivityDetection;
  onState?: (state: ConversationState) => void;
  /** What the user is saying; `final` once the character starts answering. */
  onUserTranscript?: (text: string, final: boolean) => void;
  /** What the character is saying, as it streams; `final` when the reply ends or is interrupted. */
  onAssistantTranscript?: (text: string, final: boolean) => void;
  /** Gemini will close the connection soon (`timeLeft` is a duration such as `"50s"`). */
  onGoAway?: (timeLeft: string) => void;
  onError?: (error: YoobError) => void;
}

export const GEMINI_LIVE_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const DEFAULT_MODEL = "gemini-3.8-live";
const DEFAULT_GREETING = "The user just joined. Greet them briefly.";
const INPUT_RATE = 16_000;
const OUTPUT_RATE = 24_000;

interface InlineData { mimeType?: string; data?: string }
interface ServerMessage {
  setupComplete?: object;
  serverContent?: {
    modelTurn?: { parts?: Array<{ inlineData?: InlineData; text?: string; thought?: boolean }> };
    interrupted?: boolean;
    generationComplete?: boolean;
    turnComplete?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
  goAway?: { timeLeft?: string };
  error?: { code?: number | string; message?: string; status?: string };
}

/**
 * A spoken conversation between the user and a Yoob character, using the Gemini Live API.
 * Microphone audio goes from the browser to Gemini at 16 kHz; replies (24 kHz) stream into the avatar, which plays
 * them in sync. Speaking over the character interrupts it.
 *
 * Like `YoobConversation`, this starts and stops the metered session: `start()` starts the meter once the microphone
 * is live, and `stop()` ends the session.
 */
export class YoobGeminiConversation {
  private socket?: WebSocket;
  private stateValue: ConversationState = "idle";
  private unsubscribe: Array<() => void> = [];
  private upsampler?: PcmResampler;
  private downsampler = new PcmResampler(OUTPUT_RATE, INPUT_RATE);
  private setupDone?: { resolve: () => void; reject: (error: YoobError) => void };
  private replying = false;
  private userText = "";
  private userTurnDone = true;
  private assistantText = "";
  private closing = false;
  private playbackWatch?: ReturnType<typeof setInterval>;
  private unwatchSession?: () => void;

  constructor(private readonly avatar: YoobAvatar, private readonly options: YoobGeminiConversationOptions) {}

  get state(): ConversationState { return this.stateValue; }

  /** Starts listening. Call from a click: it asks for the microphone and unlocks sound. */
  async start(options: { deviceId?: string | null } = {}): Promise<void> {
    if (this.socket) return;
    this.closing = false;
    this.downsampler = new PcmResampler(OUTPUT_RATE, INPUT_RATE);
    this.setState("connecting");
    // Hang up with the session that pays for this: no credit, refused, or the avatar destroyed.
    this.unwatchSession = this.avatar.onSessionEnd((error) => {
      if (this.closing) return;
      this.stop();
      if (error) this.options.onError?.(error);
    });
    try {
      await this.avatar.prepare();
      await this.avatar.unlockAudio();
      const token = await this.options.getToken();
      // stop() may run at any await here. A stop before the socket exists must keep it from being opened at all;
      // one after is handled by stop() itself, which closes the socket and the microphone it finds.
      if (this.closing) return;
      await this.open(token);
      if (this.closing) return;
      const microphone = this.avatar.microphone;
      this.unsubscribe.push(microphone.on("audio", (pcm) => this.sendAudio(pcm)));
      await microphone.start(options);
      if (this.closing) { this.stop(); return; } // stop() ran while the microphone was opening.
      // The microphone is live and Gemini can hear: from here the user is talking to the character, before any reply,
      // so this is when the meter starts — as YoobConversation does. Awaited, so a workspace with no credit is
      // refused before the conversation goes ahead rather than after.
      await this.avatar.startMetering();
      if (this.closing) return;
      this.setState("listening");
      const greet = this.options.greet;
      if (greet) {
        this.send({
          clientContent: {
            turns: [{ role: "user", parts: [{ text: typeof greet === "string" ? greet : DEFAULT_GREETING }] }],
            turnComplete: true,
          },
        });
        this.setState("thinking");
      }
    } catch (error) {
      if (this.closing) return; // stop() already tore down; nobody is waiting for this start any more.
      const failure = error instanceof YoobError ? error : new YoobError("network", errorText(error));
      this.stop();
      this.options.onError?.(failure);
      throw failure;
    }
  }

  /** Sends typed text as the user's turn. */
  sendText(text: string): void {
    if (!text.trim()) return;
    this.interruptReply();
    this.send({ realtimeInput: { text } });
    this.setState("thinking");
  }

  /**
   * Ends the conversation, releases the microphone and ends the metered session, so nothing is billed past the
   * moment the user stopped talking. The character stays on screen; `start()` opens a fresh session.
   */
  stop(): void {
    this.closing = true;
    this.unwatchSession?.();
    this.unwatchSession = undefined;
    this.stopPlaybackWatch();
    for (const off of this.unsubscribe.splice(0)) off();
    this.avatar.microphone.stop();
    this.avatar.interrupt();
    void this.avatar.endSession().catch(() => undefined);
    this.setupDone?.reject(new YoobError("network", "The conversation was stopped."));
    this.setupDone = undefined;
    this.socket?.close(1000, "done");
    this.socket = undefined;
    this.replying = false;
    this.setState("ended");
  }

  private open(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${GEMINI_LIVE_URL}?access_token=${encodeURIComponent(token)}`);
      // Gemini sends its JSON in binary frames.
      socket.binaryType = "arraybuffer";
      const timer = setTimeout(() => fail(new YoobError("network", "Gemini Live didn't answer in time.")), 15_000);
      let settled = false;
      const fail = (error: YoobError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.setupDone = undefined;
        socket.close();
        reject(error);
      };
      this.setupDone = {
        resolve: () => { if (settled) return; settled = true; clearTimeout(timer); this.setupDone = undefined; resolve(); },
        reject: fail,
      };
      socket.onopen = () => {
        this.socket = socket;
        this.send({ setup: this.setup() });
      };
      socket.onerror = () => fail(new YoobError("network", "Couldn't connect to Gemini Live. Check the ephemeral token."));
      socket.onmessage = (event) => this.handle(frameText(event.data));
      socket.onclose = (event) => {
        const reason = event.reason ? `: ${event.reason}` : "";
        if (!settled) {
          fail(new YoobError("network", `Gemini Live closed the connection (${event.code}${reason}).`));
          return;
        }
        if (this.socket !== socket) return;
        this.socket = undefined;
        if (!this.closing) {
          this.options.onError?.(new YoobError("network", `The conversation disconnected (${event.code}${reason}).`));
          this.stop();
        }
      };
    });
  }

  private setup(): object {
    const model = this.options.model ?? DEFAULT_MODEL;
    const vad = this.options.activityDetection ?? {};
    const voice = this.options.voice;
    return {
      model: model.startsWith("models/") ? model : `models/${model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        ...(voice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } : {}),
      },
      ...(this.options.systemInstruction ? { systemInstruction: { parts: [{ text: this.options.systemInstruction }] } } : {}),
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: vad.startSensitivity === "low" ? "START_SENSITIVITY_LOW" : "START_SENSITIVITY_HIGH",
          endOfSpeechSensitivity: vad.endSensitivity === "low" ? "END_SENSITIVITY_LOW" : "END_SENSITIVITY_HIGH",
          prefixPaddingMs: vad.prefixPaddingMs ?? 100,
          silenceDurationMs: vad.silenceDurationMs ?? 450,
        },
        activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
      },
      ...(this.options.inputTranscription === false ? {} : { inputAudioTranscription: {} }),
      ...(this.options.outputTranscription === false ? {} : { outputAudioTranscription: {} }),
    };
  }

  private handle(frame: string): void {
    let message: ServerMessage;
    try { message = JSON.parse(frame) as ServerMessage; } catch { return; }
    if (message.setupComplete) {
      this.setupDone?.resolve();
      return;
    }
    if (message.goAway) {
      this.options.onGoAway?.(message.goAway.timeLeft ?? "");
      return;
    }
    if (message.error) {
      const text = message.error.message ?? message.error.status ?? String(message.error.code ?? "server error");
      const failure = new YoobError("network", text);
      if (this.setupDone) this.setupDone.reject(failure);
      else this.options.onError?.(failure);
      return;
    }
    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) {
      // The user spoke over the reply; Gemini has already cancelled it.
      this.avatar.interrupt();
      this.finishReply();
      this.setState("listening");
    }
    const heard = content.inputTranscription?.text;
    if (heard) {
      if (this.userTurnDone) {
        this.userText = "";
        this.userTurnDone = false;
      }
      this.userText += heard;
      this.options.onUserTranscript?.(this.userText, false);
    }
    for (const part of content.modelTurn?.parts ?? []) {
      const blob = part.inlineData;
      if (!blob?.data || !blob.mimeType?.startsWith("audio/pcm")) continue;
      this.beginReply();
      this.avatar.speak(this.toOutputRate(fromBase64(blob.data), pcmRate(blob.mimeType)));
      this.setState("speaking");
    }
    const said = content.outputTranscription?.text;
    if (said) {
      this.beginReply();
      this.assistantText += said;
      this.options.onAssistantTranscript?.(this.assistantText, false);
    }
    if (content.generationComplete) this.avatar.endSpeech();
    if (content.turnComplete) {
      this.avatar.endSpeech();
      this.finishReply();
      this.userTurnDone = true;
      if (this.stateValue === "thinking") this.setState("listening");
      if (this.stateValue === "speaking") this.watchPlaybackEnd();
    }
  }

  /** The first audio or text of a reply: the user's turn is over. */
  private beginReply(): void {
    if (this.replying) return;
    this.replying = true;
    this.stopPlaybackWatch();
    this.assistantText = "";
    if (!this.userTurnDone && this.userText) this.options.onUserTranscript?.(this.userText, true);
    this.userTurnDone = true;
  }

  /** Gemini sends nothing when the reply finishes playing, so follow the avatar back to listening. */
  private watchPlaybackEnd(): void {
    this.stopPlaybackWatch();
    const check = () => {
      if (this.replying || this.stateValue !== "speaking") return this.stopPlaybackWatch();
      if (this.avatar.phase !== "speaking") {
        this.stopPlaybackWatch();
        this.setState("listening");
      }
    };
    this.playbackWatch = setInterval(check, 100);
    check();
  }

  private stopPlaybackWatch(): void {
    if (this.playbackWatch) clearInterval(this.playbackWatch);
    this.playbackWatch = undefined;
  }

  private finishReply(): void {
    if (!this.replying) return;
    this.replying = false;
    if (this.assistantText) this.options.onAssistantTranscript?.(this.assistantText, true);
  }

  /** Typed input: stop the character now rather than waiting for Gemini's interruption. */
  private interruptReply(): void {
    this.avatar.interrupt();
    this.finishReply();
  }

  private sendAudio(pcm: Int16Array): void {
    if (this.socket?.readyState !== WebSocket.OPEN || this.setupDone) return;
    const samples = this.downsampler.process(pcm);
    if (samples.length === 0) return;
    this.send({ realtimeInput: { audio: { data: toBase64(samples), mimeType: `audio/pcm;rate=${INPUT_RATE}` } } });
  }

  private toOutputRate(pcm: Int16Array, rate: number): Int16Array {
    if (rate === OUTPUT_RATE) return pcm;
    if (this.upsampler?.fromRate !== rate) this.upsampler = new PcmResampler(rate, OUTPUT_RATE);
    return this.upsampler.process(pcm);
  }

  private send(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private setState(state: ConversationState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.options.onState?.(state);
  }
}

function pcmRate(mimeType: string): number {
  const match = /rate=(\d+)/.exec(mimeType);
  return match ? Number(match[1]) : OUTPUT_RATE;
}

function frameText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data);
}
