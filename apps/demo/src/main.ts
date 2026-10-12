import { YoobAvatar, YoobConversation, type YoobCredentials } from "@yoob/avatar";

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const status = $<HTMLParagraphElement>("#status");
const progress = $<HTMLProgressElement>("#progress");
const talk = $<HTMLButtonElement>("#talk");
const mute = $<HTMLButtonElement>("#mute");
const speak = $<HTMLButtonElement>("#speak");
const select = $<HTMLSelectElement>("#microphone");
const meter = $<HTMLDivElement>(".meter");
const meterBar = $<HTMLSpanElement>("#meter-bar");
const userCaption = $<HTMLParagraphElement>("#user-caption");
const assistantCaption = $<HTMLParagraphElement>("#assistant-caption");

async function post<T>(path: string, body: object): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    // The token server explains refusals, for example that it needs YOOB_EXAMPLE_ALLOW_ANONYMOUS=1 locally.
    const detail = await response.json().then((b: { error?: string }) => b.error).catch(() => undefined);
    throw new Error(detail ?? `${path} failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

// ?character=<id> picks the character (luna-anime by default; the realistic FeatherTalk characters by name, for example
// astrid). In development, ?pack=/packs/<id>/ loads a local FeatherTalk pack instead of the CDN (see vite.config.ts).
const params = new URLSearchParams(location.search);
const packUrl = params.get("pack") ?? undefined;
const characterId = params.get("character") ?? packUrl?.split("/").filter(Boolean).pop() ?? "luna-anime";
const NAMES: Record<string, string> = {
  "luna-anime": "Luna", astrid: "Astrid", valentina: "Valentina", leonie: "Leonie", linda: "Linda", santiago: "Santiago",
  julien: "Julien", lars: "Lars", lina: "Lina", zoe: "Zoe", maya: "Maya", ren: "Ren", kofi: "Kofi", bruno: "Bruno",
};
const displayName = NAMES[characterId] ?? characterId;
const picker = $<HTMLSelectElement>("#character-picker");
picker.replaceChildren(...Object.entries(NAMES).map(([id, name]) => new Option(name, id, false, id === characterId)));
picker.addEventListener("change", () => {
  const next = new URLSearchParams(location.search);
  if (packUrl) next.set("pack", `/packs/${picker.value}/`); else next.set("character", picker.value);
  location.search = next.toString();
});
document.title = `Yoob Web Demo · ${displayName}`;

const support = await YoobAvatar.isSupported();
if (!support.supported) {
  status.textContent = support.reason ?? "This browser can't render characters.";
} else {
  const avatar = new YoobAvatar({
    container: $("#character"),
    character: characterId,
    packUrl,
    getCredentials: () => post<YoobCredentials>("/yoob-session", { character: characterId }),
    onProgress: ({ fraction }) => { progress.hidden = fraction >= 1; progress.value = fraction; },
    onPhase: (phase) => {
      const ready = phase === "ready" || phase === "speaking";
      talk.disabled = !ready;
      speak.disabled = !ready;
      if (conversation.state === "idle" || conversation.state === "ended") {
        status.textContent = {
          "not-prepared": "Starting…", downloading: `Downloading ${displayName}…`, warming: `Getting ${displayName} ready…`,
          ready: `Ready. Press Talk to ${displayName}.`, speaking: "Speaking", failed: `${displayName} couldn't load.`, stopped: "Session ended.",
        }[phase];
      }
    },
    onError: (error) => { status.textContent = error.message; },
  });
  (window as unknown as { yoob: YoobAvatar }).yoob = avatar;

  const conversation = new YoobConversation(avatar, {
    // Your backend asks Yoob for a voice session, and sets Luna's voice and prompt there.
    // With your own OpenAI account instead (start the token server with OPENAI_API_KEY):
    // getClientSecret: async () => (await post<{ value: string }>("/openai-secret", {})).value,
    getVoiceSession: () => fetch("/yoob-voice", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ character: characterId }),
    }).then((r) => r.json()),
    greet: true,
    onState: (state) => {
      talk.textContent = state === "idle" || state === "ended" ? `Talk to ${displayName}` : "End";
      mute.disabled = state === "idle" || state === "ended" || state === "connecting";
      status.textContent = {
        idle: status.textContent ?? "", connecting: "Connecting…", listening: "Listening — just speak",
        thinking: "Thinking…", speaking: `${displayName} is speaking — talk to interrupt`, ended: "Conversation ended.",
      }[state];
    },
    onUserTranscript: (text) => { userCaption.textContent = text; },
    onAssistantTranscript: (text) => { assistantCaption.textContent = text; },
    onError: (error) => { status.textContent = error.message; },
  });

  // Microphone controls.
  const mic = avatar.microphone;
  const fillDevices = async () => {
    const current = select.value;
    const [devices, granted] = await Promise.all([mic.devices(), mic.hasAccess()]);
    const defaultLabel = granted ? "System default" : "System default (allow the microphone to choose)";
    select.replaceChildren(new Option(defaultLabel, ""), ...devices.map((d) => new Option(d.label, d.deviceId)));
    select.value = devices.some((d) => d.deviceId === current) ? current : "";
  };
  void fillDevices();
  mic.on("devices", () => void fillDevices());
  // Input names stay hidden until the microphone is allowed once: ask the first time the list is opened.
  const unlockList = async () => {
    if (await mic.hasAccess()) return;
    const devices = await mic.requestAccess().catch(() => []);
    if (devices.length) void fillDevices();
  };
  select.addEventListener("pointerdown", () => void unlockList());
  select.addEventListener("keydown", () => void unlockList());
  mic.on("level", (level) => {
    meterBar.style.width = `${Math.round(level * 100)}%`;
    meter.setAttribute("aria-valuenow", String(Math.round(level * 100)));
  });
  mic.on("state", (state) => {
    mute.setAttribute("aria-pressed", String(state === "muted"));
    mute.setAttribute("aria-label", state === "muted" ? "Unmute microphone" : "Mute microphone");
    if (state === "live") void fillDevices();
  });
  mic.on("error", (error) => { status.textContent = error.message; });
  select.addEventListener("change", () => void mic.select(select.value || null));
  mute.addEventListener("click", () => mic.setMuted(!mic.muted));

  talk.addEventListener("click", () => {
    if (conversation.state === "idle" || conversation.state === "ended") {
      void conversation.start({ deviceId: select.value || null }).catch(() => undefined);
    } else {
      conversation.stop();
      userCaption.textContent = "";
      assistantCaption.textContent = "";
    }
  });

  void avatar.prepare();

  speak.addEventListener("click", async () => {
    if (avatar.phase === "speaking") { avatar.interrupt(); return; }
    await avatar.unlockAudio();
    const pcm = new Int16Array(await (await fetch("/hello-24k.pcm")).arrayBuffer());
    for (let offset = 0; offset < pcm.length; offset += 2400) {
      avatar.speak(pcm.subarray(offset, offset + 2400));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    avatar.endSpeech();
  });
}
