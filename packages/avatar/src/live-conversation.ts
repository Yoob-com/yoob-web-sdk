// A conversation with OpenAI GPT-Live, which the page cannot reach on its own.
//
// `YoobConversation` opens a socket to OpenAI from the browser. GPT-Live cannot work that way: it authenticates with
// an `Authorization` header and offers no subprotocol equivalent, and a browser's WebSocket cannot set headers. So
// the model lives behind an agent and the page meets it in a LiveKit room.
//
// That is the only difference a caller sees. Both classes take `(avatar, options)`, both have `start()` and `stop()`,
// and both end with 24 kHz PCM going into the avatar — so an app can offer the two models side by side and switch
// between them without a second set of states to interpret.
import { Room, RoomEvent } from "livekit-client";
import { YoobLiveKitSession, type AgentState, type ConversationState } from "./livekit.js";
import { YoobError, type YoobAvatar } from "./index.js";

/** What your backend returns: a room, and a token to enter it. The agent is already inside. */
export interface YoobLiveSession {
  /** The LiveKit server, for example `wss://your-project.livekit.cloud`. */
  url: string;
  /** A join token scoped to one room, minted server-side. */
  token: string;
  room?: string;
}

export interface YoobLiveConversationOptions {
  /**
   * Asks your backend to open a room with an agent in it. Called once per `start()`: a token admits one participant
   * to one room, and a room is one conversation.
   */
  getLiveSession: () => Promise<YoobLiveSession>;
  /** Publish the user's microphone, with echo cancellation. Default true. */
  microphone?: boolean;
  /** Meter this conversation to your workspace (default true). See `YoobLiveKitSessionOptions.meter`. */
  meter?: boolean;
  onState?: (state: ConversationState) => void;
  /** What the user is saying; `final` once the agent has settled on it. */
  onUserTranscript?: (text: string, final: boolean) => void;
  /** What the character is saying, as it streams. */
  onAssistantTranscript?: (text: string, final: boolean) => void;
  onError?: (error: YoobError) => void;
}

/**
 * A spoken conversation with a GPT-Live model, rendered by a Yoob character.
 *
 * The model is full-duplex and runs its own turn-taking: it listens while it speaks and yields on its own. There is
 * no barge-in to perform here, which is why this class is so much smaller than the Realtime one — speaking over the
 * character is simply heard, rather than being an interruption to detect and act on.
 */
export class YoobLiveConversation {
  #room?: Room;
  #session?: YoobLiveKitSession;
  #state: ConversationState = "idle";

  constructor(private readonly avatar: YoobAvatar, private readonly options: YoobLiveConversationOptions) {}

  get state(): ConversationState {
    return this.#state;
  }

  /** The agent's own view of itself, once it is in the room. */
  get agentState(): AgentState | undefined {
    return this.#session?.agentState;
  }

  /** Opens the room and starts listening. Call from a click: it asks for the microphone and unlocks sound. */
  async start(): Promise<void> {
    if (this.#room) return;
    this.#setState("connecting");

    const room = new Room();
    this.#room = room;
    try {
      const session = check(await this.options.getLiveSession());
      // Connected here rather than inside YoobLiveKitSession, which deliberately never owns the room it is handed —
      // an app embedding the avatar in its own LiveKit call keeps control of its connection.
      await room.connect(session.url, session.token);

      this.#session = new YoobLiveKitSession(this.avatar, {
        room,
        microphone: this.options.microphone ?? true,
        meter: this.options.meter ?? true,
        onState: (state) => this.#setState(state),
        onUserTranscript: this.options.onUserTranscript,
        onAssistantTranscript: this.options.onAssistantTranscript,
        onError: this.options.onError,
      });
      await this.#session.start();
    } catch (error) {
      const failure = error instanceof YoobError ? error : new YoobError("network", message(error));
      await this.stop();
      this.options.onError?.(failure);
      throw failure;
    }
  }

  /** Ends the conversation and leaves the room. The character stays on screen. */
  async stop(): Promise<void> {
    const room = this.#room;
    this.#room = undefined;
    await this.#session?.stop().catch(() => undefined);
    this.#session = undefined;
    // We opened this room, so we close it — and the agent takes the empty room as its cue to end the model session.
    await room?.disconnect().catch(() => undefined);
    this.#setState("ended");
  }

  #setState(state: ConversationState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.options.onState?.(state);
  }
}

function check(session: YoobLiveSession): YoobLiveSession {
  if (!session || typeof session.url !== "string" || !session.url || typeof session.token !== "string" || !session.token) {
    throw new YoobError("unauthorized", "getLiveSession() didn't return a room. Check your backend's response.");
  }
  if (!/^wss?:\/\//i.test(session.url)) {
    throw new YoobError("voice-session", "The LiveKit URL must be a ws:// or wss:// address.");
  }
  return session;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export { RoomEvent };
