// Minimal backend for the Yoob examples. It keeps your keys on the server and hands the app short-lived credentials.
//
//   YOOB_API_KEY=yoob_live_... YOOB_EXAMPLE_ALLOW_ANONYMOUS=1 [OPENAI_API_KEY=sk-...] node server.mjs
//
// POST /yoob-session   → a Yoob session (character downloads and metering)
// POST /yoob-voice     → a Yoob voice session, for YoobConversation (no provider key; minutes billed to your workspace)
// POST /openai-secret  → an OpenAI Realtime client secret, for YoobConversation with your own OpenAI account
//                        (only if OPENAI_API_KEY is set)
// POST /openai-webrtc  → the SDP answer for YoobWebRTCConversation's getAnswer: the browser's offer goes to OpenAI's
//                        live sessions with the character's prompt and voice (only if OPENAI_API_KEY is set)
//
// Every session is metered to your workspace, so this server refuses to mint anything until you decide who may ask.
// Replace requireUser() with your own sign-in check before you deploy it. YOOB_EXAMPLE_ALLOW_ANONYMOUS=1 skips the
// check for local development only.
//
// Settings:
//   YOOB_API_KEY                   required. Create one on the Yoob console's API Key page; every session bills your
//                                  workspace.
//   YOOB_API_BASE                  where sessions are opened (default https://la.yoob.com, the Yoob console)
//   OPENAI_REALTIME_MODEL          speech-to-speech model for /openai-secret (default gpt-realtime)
//   OPENAI_LIVE_MODEL              model for /openai-webrtc (default gpt-live-1)
//   YOOB_CHARACTERS                characters this server hands out, comma-separated (default luna-anime,astrid; any
//                                  character the key is allowed may be listed)
//   YOOB_EXAMPLE_ALLOW_ANONYMOUS   1 lets anyone mint sessions. Local development only.
//   YOOB_RATE_LIMIT                sessions per user per minute, across all routes (default 10)
//   PORT                           default 3100. The server listens on 127.0.0.1 only.
import http from "node:http";

const apiKey = process.env.YOOB_API_KEY;
const apiBase = process.env.YOOB_API_BASE ?? "https://la.yoob.com";
// OpenAI's speech-to-speech model, for the /openai-secret route only.
const realtimeModel = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime";
const port = Number(process.env.PORT ?? 3100);
const allowAnonymous = process.env.YOOB_EXAMPLE_ALLOW_ANONYMOUS === "1";
const allowedCharacters = new Set(
  (process.env.YOOB_CHARACTERS || "luna-anime,astrid").split(",").map((id) => id.trim()).filter(Boolean),
);
const perMinute = Math.max(1, Number(process.env.YOOB_RATE_LIMIT || 10) || 10);
if (!apiKey) throw new Error("Set YOOB_API_KEY to a key from the Yoob console's API Key page");
if (allowedCharacters.has("*")) throw new Error("YOOB_CHARACTERS must list character ids, not *");

// Each character's voice and prompt are set here, on the server: the app can't change them and never sees the prompt.
const LUNA = {
  voice: "marin",
  instructions: "You are Luna, a warm, curious companion. Keep replies short and natural.",
};
const VOICES = {
  "luna-anime": LUNA,
  "luna-realistic": LUNA,
  astrid: {
    voice: "marin",
    instructions: "You are Astrid, a friendly person on a video call. Keep answers to a sentence or two.",
  },
};
/** An SDP offer is a few kilobytes; this leaves room for the JSON around it. */
const MAX_SDP_BYTES = 40 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Who is asking. Replace this with your own authentication: verify your session cookie or bearer token and return a
 * stable user id. Throw HttpError(401) when the caller isn't signed in.
 */
async function requireUser(req) {
  if (allowAnonymous) return `anonymous:${req.socket.remoteAddress ?? "local"}`;
  throw new HttpError(401,
    "This example token server has no authentication. Implement your own auth in requireUser() in token-server/server.mjs, "
    + "or set YOOB_EXAMPLE_ALLOW_ANONYMOUS=1 for local development only.");
}

// A fixed-window limit per user, in memory. Use a shared store (Redis, your database) when you run more than one server.
const windows = new Map();
function rateLimit(user) {
  const now = Date.now();
  const window = windows.get(user);
  if (!window || now - window.start >= 60_000) {
    windows.set(user, { start: now, count: 1 });
    return;
  }
  window.count += 1;
  if (window.count > perMinute) throw new HttpError(429, "Too many sessions. Try again in a minute.");
}
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [user, window] of windows) if (window.start < cutoff) windows.delete(user);
}, 60_000).unref();

function requireCharacter(body) {
  const character = body?.character;
  if (typeof character !== "string" || !allowedCharacters.has(character)) {
    throw new HttpError(400, `character must be one of: ${[...allowedCharacters].join(", ")}`);
  }
  return character;
}

async function readJson(req, limit = 16_384) {
  let body = "";
  for await (const part of req) {
    body += part;
    if (body.length > limit) throw new HttpError(413, "Request too large.");
  }
  try {
    const value = JSON.parse(body || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    throw new HttpError(400, "Send a JSON body.");
  }
}

async function forward(res, upstream) {
  res.writeHead(upstream.status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(await upstream.text());
}

function yoob(path, body) {
  return fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    // Built field by field: nothing from the app's request is passed through.
    body: JSON.stringify(body),
  });
}

const routes = {
  async "/yoob-session"(req, res) {
    rateLimit(await requireUser(req));
    const character = requireCharacter(await readJson(req));
    return forward(res, await yoob("/api/v1/avatar/sessions", { characters: [character] }));
  },
  async "/yoob-voice"(req, res) {
    rateLimit(await requireUser(req));
    const character = requireCharacter(await readJson(req));
    const voice = VOICES[character];
    // Voice sessions always carry the character's own prompt, so the app can't turn the voice into something else: this
    // server's prompt when it has one, otherwise the Yoob API's server-side preset for the character (VOICE_CHARACTERS).
    // The voice token must be used within 5 minutes and opens one conversation: mint it when the user taps Talk.
    return forward(res, await yoob("/api/v1/voice/sessions", voice?.instructions
      ? { voice: voice.voice, instructions: voice.instructions, max_seconds: 900 }
      : { character, max_seconds: 900 }));
  },
  async "/openai-secret"(req, res) {
    if (!process.env.OPENAI_API_KEY) throw new HttpError(501, "Set OPENAI_API_KEY to enable conversations.");
    rateLimit(await requireUser(req));
    return forward(res, await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ session: { type: "realtime", model: realtimeModel } }),
    }));
  },
  async "/openai-webrtc"(req, res) {
    if (!process.env.OPENAI_API_KEY) throw new HttpError(501, "Set OPENAI_API_KEY to enable conversations.");
    rateLimit(await requireUser(req));
    const body = await readJson(req, MAX_SDP_BYTES + 4096);
    const character = requireCharacter(body);
    const voice = VOICES[character];
    if (!voice?.instructions) throw new HttpError(400, `No voice is configured for ${character}.`);
    const sdp = body.sdp;
    if (typeof sdp !== "string" || !sdp || Buffer.byteLength(sdp) > MAX_SDP_BYTES) throw new HttpError(400, "Send the SDP offer as sdp.");
    // Audio only goes upstream, whatever the page sent.
    if (/^m=video/m.test(sdp)) throw new HttpError(400, "The offer must not contain video.");
    const upstream = await fetch("https://api.openai.com/v1/live/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        // No audio format: with WebRTC the codec is negotiated in the SDP.
        session: { model: process.env.OPENAI_LIVE_MODEL ?? "gpt-live-1", instructions: voice.instructions,
          audio: { output: { voice: voice.voice } } },
        transport: { type: "webrtc", sdp },
      }),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      console.error(`live/sessions: ${upstream.status} ${text.slice(0, 400)}`);
      throw new HttpError(502, `OpenAI refused the offer (${upstream.status}).`);
    }
    let answer;
    try { answer = JSON.parse(text)?.transport?.sdp; } catch { answer = undefined; }
    if (typeof answer !== "string") throw new HttpError(502, "OpenAI returned no SDP answer.");
    // The session id stays here; the page gets the answer and nothing else.
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ sdp: answer }));
  },
};

http.createServer(async (req, res) => {
  const route = req.method === "POST" ? routes[req.url] : undefined;
  if (!route) return res.writeHead(404).end();
  try {
    await route(req, res);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 502;
    const message = error instanceof HttpError ? error.message : "Couldn't reach Yoob.";
    if (!(error instanceof HttpError)) console.error(`${req.url}: ${error?.message ?? error}`);
    if (!res.headersSent) res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: message }));
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Yoob token server on http://localhost:${port} (characters: ${[...allowedCharacters].join(", ")})`);
  if (allowAnonymous) console.warn("YOOB_EXAMPLE_ALLOW_ANONYMOUS=1: anyone who can reach this server can mint sessions. Local development only.");
});
