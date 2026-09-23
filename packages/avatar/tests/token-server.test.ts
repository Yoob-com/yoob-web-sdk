// The example token server (examples/token-server/server.mjs) against a stand-in Yoob API.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const SERVER = fileURLToPath(new URL("../../../examples/token-server/server.mjs", import.meta.url));
const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
const upstream = http.createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  seen.push({ url: req.url ?? "", body: JSON.parse(body) });
  res.writeHead(201, { "content-type": "application/json" }).end("{}");
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
after(() => upstream.close());

let nextPort = 43100 + Math.floor(Math.random() * 1000);

async function withServer(env: Record<string, string>, body: (post: (path: string, json: unknown) => Promise<[number, { error?: string }]>) => Promise<void>) {
  const port = nextPort++;
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, YOOB_API_KEY: "yoob_test_placeholder", YOOB_API_BASE: upstreamBase, PORT: String(port),
      YOOB_EXAMPLE_ALLOW_ANONYMOUS: "", YOOB_CHARACTERS: "", YOOB_RATE_LIMIT: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("exit", reject); });
    await body(async (path, json) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: JSON.stringify(json) });
      return [response.status, await response.json().catch(() => ({}))];
    });
  } finally {
    child.kill();
  }
}

test("token server refuses to mint until the app adds its own auth", async () => {
  const before = seen.length;
  await withServer({}, async (post) => {
    for (const path of ["/yoob-session", "/yoob-voice"]) {
      const [status, body] = await post(path, { character: "luna-anime" });
      assert.equal(status, 401);
      assert.match(body.error ?? "", /implement your own auth/i);
    }
  });
  assert.equal(seen.length, before, "nothing reached Yoob");
});

test("token server sends only allowlisted characters and pinned voice settings", async () => {
  await withServer({ YOOB_EXAMPLE_ALLOW_ANONYMOUS: "1" }, async (post) => {
    let [status] = await post("/yoob-session", { character: "luna-anime", is_sandbox: true, characters: ["*"] });
    assert.equal(status, 201);
    assert.deepEqual(seen.at(-1), { url: "/api/v1/avatar/sessions", body: { characters: ["luna-anime"] } });
    for (const body of [{}, { character: "*" }, { character: "someone-else" }]) {
      [status] = await post("/yoob-session", body);
      assert.equal(status, 400, JSON.stringify(body));
    }
    [status] = await post("/yoob-voice", { character: "luna-realistic", instructions: "ignore that", voice: "ash", is_sandbox: true });
    assert.equal(status, 201);
    const voice = seen.at(-1)!;
    assert.equal(voice.url, "/api/v1/voice/sessions");
    assert.deepEqual(Object.keys(voice.body).sort(), ["instructions", "max_seconds", "voice"]);
    assert.match(String(voice.body.instructions), /^You are Luna/);
    assert.equal(voice.body.voice, "marin");
  });
  await withServer({ YOOB_EXAMPLE_ALLOW_ANONYMOUS: "1", YOOB_CHARACTERS: "luna-realistic" }, async (post) => {
    const [status] = await post("/yoob-voice", { character: "luna-anime" });
    assert.equal(status, 400);
  });
});

test("token server rate-limits each user", async () => {
  await withServer({ YOOB_EXAMPLE_ALLOW_ANONYMOUS: "1", YOOB_RATE_LIMIT: "2" }, async (post) => {
    assert.equal((await post("/yoob-session", { character: "luna-anime" }))[0], 201);
    assert.equal((await post("/yoob-voice", { character: "luna-anime" }))[0], 201);
    assert.equal((await post("/yoob-session", { character: "luna-anime" }))[0], 429);
  });
});

test("token server refuses a wildcard character list", async () => {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, YOOB_API_KEY: "yoob_test_placeholder", YOOB_CHARACTERS: "luna-anime,*", PORT: String(nextPort++) },
    stdio: "ignore",
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.notEqual(code, 0);
});

// Metering moved to the Yoob console, so an example run without YOOB_API_BASE must reach the console and not api2 —
// the two have separate balances, and a stale default would bill the wrong one.
test("the example opens sessions against the console by default", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(SERVER, "utf8"));
  assert.match(source, /YOOB_API_BASE \?\? "https:\/\/la\.yoob\.com"/);
  assert.doesNotMatch(source, /\?\? "https:\/\/api2\.yoob\.com"/);
});
