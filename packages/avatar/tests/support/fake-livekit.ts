// LiveKit's network edge, faked on the real `Room`.
//
// `YoobLiveConversation` constructs its own `Room`, so the room cannot be handed in. What is replaced is only what
// would touch a server: connecting, disconnecting and publishing the microphone. Everything else -- the room's events,
// its participant maps, its text-stream registry -- is livekit-client's own.
import { LocalParticipant, Room } from "livekit-client";

export interface FakeLiveKit {
  /** connect, disconnect, mic:on and mic:off, in order. */
  readonly log: string[];
  /** Whether the last room is connected, and whether its microphone is published. */
  readonly connected: boolean;
  readonly microphone: boolean;
  readonly room?: Room;
  /** Holds the next `room.connect()` until the returned function is called. */
  holdConnect(): () => void;
  restore(): void;
}

export function fakeLiveKit(): FakeLiveKit {
  const log: string[] = [];
  let connected = false;
  let microphone = false;
  let room: Room | undefined;
  let held: Promise<void> | undefined;
  // livekit-client assigns `connect` and `disconnect` per instance in the constructor, so they are intercepted with
  // accessors on the prototype: the constructor's assignment lands in the setter and is ignored.
  const descriptors = {
    connect: Object.getOwnPropertyDescriptor(Room.prototype, "connect"),
    disconnect: Object.getOwnPropertyDescriptor(Room.prototype, "disconnect"),
  };
  const intercept = (name: "connect" | "disconnect", fake: (this: Room, ...args: unknown[]) => Promise<void>) => {
    Object.defineProperty(Room.prototype, name, { configurable: true, get: () => fake, set: () => undefined });
  };
  const setMicrophoneEnabled = LocalParticipant.prototype.setMicrophoneEnabled;
  intercept("connect", async function (this: Room) {
    room = this;
    if (held) await held;
    log.push("connect");
    connected = true;
  });
  intercept("disconnect", async function (this: Room) {
    log.push("disconnect");
    const was = connected;
    connected = false;
    microphone = false;
    if (was) (this as unknown as { emit: (event: string) => void }).emit("disconnected");
  });
  LocalParticipant.prototype.setMicrophoneEnabled = async function (enabled: boolean) {
    log.push(enabled ? "mic:on" : "mic:off");
    microphone = enabled;
    return undefined;
  };
  return {
    log,
    get connected() { return connected; },
    get microphone() { return microphone; },
    get room() { return room; },
    holdConnect() {
      let release!: () => void;
      held = new Promise<void>((resolve) => { release = resolve; });
      return () => { held = undefined; release(); };
    },
    restore() {
      for (const name of ["connect", "disconnect"] as const) {
        const descriptor = descriptors[name];
        if (descriptor) Object.defineProperty(Room.prototype, name, descriptor);
        else delete (Room.prototype as unknown as Record<string, unknown>)[name];
      }
      LocalParticipant.prototype.setMicrophoneEnabled = setMicrophoneEnabled;
    },
  };
}
