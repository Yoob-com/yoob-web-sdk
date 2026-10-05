import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionMonitor, startSession, type SessionMonitorOptions } from "../src/session";
import { YoobError } from "../src/cdn";

type Reply = { status: number; body?: unknown } | Error;
type Script = Reply[] | ((now: number) => Reply);

/** A heartbeat endpoint that answers from a script, and a clock that only moves when the test says so. */
function harness(replies: Script, extra: Partial<SessionMonitorOptions> = {}) {
  const requests: Array<{ url: string; auth: string; at: number }> = [];
  const sleeps: number[] = [];
  const waiting: Array<{ ms: number; resolve: () => void }> = [];
  const ended: YoobError[] = [];
  const grants: string[] = [];
  const events: string[] = [];
  let renewals = 0;
  let token = "st_1";
  let clock = 0;
  const monitor = new SessionMonitor({
    apiBase: () => "https://api2.yoob.com/",
    sessionToken: () => token,
    intervalSeconds: 15,
    renew: async () => { renewals += 1; token = `st_${renewals + 1}`; },
    onGrant: (grant) => grants.push(grant),
    onEnded: (error) => ended.push(error),
    onDegraded: (detail) => events.push(`degraded ${detail}`),
    onRecovered: () => events.push("recovered"),
    retryDelayMs: (n) => n * 1000,
    now: () => clock,
    sleep: (ms) => { sleeps.push(ms); return new Promise((resolve) => waiting.push({ ms, resolve })); },
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, auth: (init.headers as Record<string, string>).authorization, at: clock });
      const next = typeof replies === "function" ? replies(clock) : replies.shift() ?? { status: 200, body: { stop: false } };
      if (next instanceof Error) throw next;
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
    }) as typeof fetch,
    ...extra,
  });
  /** Lets every pending sleep finish (the clock moves by the longest), then lets the resulting work settle. */
  const tick = async () => {
    const due = waiting.splice(0);
    clock += Math.max(0, ...due.map((entry) => entry.ms));
    for (const entry of due) entry.resolve();
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  /** Runs a beat to completion, moving the fake clock for any retry waits. */
  const drive = async (work: Promise<void>) => {
    let done = false;
    void work.finally(() => { done = true; });
    for (let i = 0; i < 500 && !done; i += 1) await tick();
    assert.ok(done, "the beat finished");
    await work;
  };
  return {
    monitor, requests, sleeps, ended, grants, events, tick, drive,
    get clock() { return clock; },
    advance: (ms: number) => { clock += ms; },
    get renewals() { return renewals; },
    setRenew: (fn: () => Promise<void>) => { (monitor as unknown as { options: SessionMonitorOptions }).options.renew = fn; },
  };
}

test("beats on the session's interval from the start, with the session token", async () => {
  const h = harness([]);
  h.monitor.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.sleeps, [15_000]);
  assert.equal(h.requests.length, 0, "waits one interval before the first beat");
  await h.tick();
  assert.equal(h.requests.length, 1);
  await h.tick();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].url, "https://api2.yoob.com/api/v1/sessions/heartbeat");
  assert.equal(h.requests[0].auth, "Bearer st_1");
  assert.deepEqual(h.ended, []);
  h.monitor.stop();
});

const MIN = 60_000;
/** Backoff like the default one, without jitter: 2 s, 6 s, then every 15 s. */
const backoff = (n: number) => (n <= 1 ? 2_000 : n === 2 ? 6_000 : 15_000);
/** Fails until `until`, alternating 503s and network errors, then answers. */
const outage = (until: number): ((now: number) => Reply) => {
  let n = 0;
  return (now) => (now >= until ? { status: 200, body: { stop: false } }
    : (n += 1) % 2 ? { status: 503 } : new TypeError("offline"));
};

test("keeps running through 9 minutes of transient failures, then recovers", async () => {
  const h = harness(outage(9 * MIN), { retryDelayMs: backoff });
  h.monitor.start();
  await h.drive(h.monitor.beatNow());
  assert.deepEqual(h.ended, []);
  assert.equal(h.monitor.active, true);
  assert.ok(h.requests.length > 30, `retried through the outage (${h.requests.length} beats)`);
  assert.deepEqual(h.sleeps.slice(1, 5), [2_000, 6_000, 15_000, 15_000], "backs off, then retries every 15 s");
  assert.ok(h.requests.at(-1)!.at >= 9 * MIN);
  assert.deepEqual(h.events, ["degraded HTTP 503", "recovered"], "one degraded event, one recovery");
  assert.equal(h.monitor.degraded, false);
  assert.equal(h.monitor.consecutiveFailures, 0);

  h.monitor.stop();
});

test("the grace window restarts after a recovery", async () => {
  const first = outage(9 * MIN), second = outage(19 * MIN);
  const h = harness((now) => (now < 10 * MIN ? first(now) : second(now)), { retryDelayMs: backoff });
  h.monitor.start();
  await h.drive(h.monitor.beatNow());
  h.advance(10 * MIN - h.clock);
  await h.drive(h.monitor.beatNow());
  assert.deepEqual(h.ended, [], "two 9-minute outages with a success between them are both survived");
  assert.deepEqual(h.events, ["degraded HTTP 503", "recovered", "degraded HTTP 503", "recovered"]);
  h.monitor.stop();
});

test("stops as unreachable once transient failures outlast the 10-minute grace window", async () => {
  const h = harness(() => ({ status: 502, body: "<html>Bad Gateway</html>" }), { retryDelayMs: backoff });
  h.monitor.start();
  await h.drive(h.monitor.beatNow());
  assert.equal(h.ended.length, 1);
  assert.equal(h.ended[0].code, "session-ended");
  assert.equal(h.ended[0].details.reason, "unreachable");
  assert.equal(h.monitor.active, false);
  const last = h.requests.at(-1)!.at;
  assert.ok(last >= 10 * MIN && last < 10 * MIN + 15_000, `the last attempt lands on the deadline (${last} ms)`);
  assert.ok(h.requests.at(-2)!.at < 10 * MIN, "still retrying inside the window");
  assert.deepEqual(h.events, ["degraded HTTP 502"]);
  const beats = h.requests.length;
  await h.drive(h.monitor.beatNow());
  assert.equal(h.requests.length, beats, "no beats after the session ended");
});

test("408, 429, timeouts and unreadable replies are transient too", async () => {
  const replies: Reply[] = [{ status: 408 }, { status: 429 }, new DOMException("aborted", "AbortError"),
    { status: 200, body: undefined }, { status: 200, body: {} }];
  // A 200 with an empty body is unreadable JSON: a proxy, not Yoob.
  const h = harness(replies);
  h.monitor.start();
  await h.drive(h.monitor.beatNow());
  assert.equal(h.requests.length, 5);
  assert.deepEqual(h.ended, []);
  assert.deepEqual(h.events, ["degraded HTTP 408", "recovered"]);
  h.monitor.stop();

  const proxy = harness([{ status: 200, body: undefined }], { outageGraceSeconds: 0 });
  proxy.monitor.start();
  await proxy.drive(proxy.monitor.beatNow());
  assert.equal(proxy.ended[0]?.details.reason, "unreachable");
});

test("a 402 stops at once even while degraded", async () => {
  const h = harness((now) => (now < 3 * MIN ? new TypeError("offline") : { status: 402, body: { code: "quota_exceeded" } }),
    { retryDelayMs: backoff });
  h.monitor.start();
  await h.drive(h.monitor.beatNow());
  assert.equal(h.ended.length, 1);
  assert.equal(h.ended[0].code, "out-of-credit");
  assert.ok(h.requests.at(-1)!.at < 4 * MIN, "did not wait for the grace window");
  assert.deepEqual(h.events, ["degraded offline"]);
  assert.equal(h.monitor.active, false);
});

test("the grace window is configurable from 0 (strict) to 1800 seconds", async () => {
  const strict = harness(() => new TypeError("offline"), { outageGraceSeconds: 0 });
  strict.monitor.start();
  await strict.drive(strict.monitor.beatNow());
  assert.equal(strict.requests.length, 1, "0 ends at the first failure");
  assert.equal(strict.ended[0]?.details.reason, "unreachable");

  const short = harness(outage(90_000), { outageGraceSeconds: 60, retryDelayMs: backoff });
  short.monitor.start();
  await short.drive(short.monitor.beatNow());
  assert.equal(short.ended[0]?.details.reason, "unreachable");
  assert.ok(short.requests.at(-1)!.at >= 60_000 && short.requests.at(-1)!.at < 90_000);

  const capped = harness(() => ({ status: 500 }), { outageGraceSeconds: 99_999, retryDelayMs: backoff });
  capped.monitor.start();
  await capped.drive(capped.monitor.beatNow());
  const last = capped.requests.at(-1)!.at;
  assert.ok(last >= 30 * MIN && last < 30 * MIN + 15_000, `capped at 1800 s (${last} ms)`);

  const negative = harness(() => ({ status: 500 }), { outageGraceSeconds: -5 });
  negative.monitor.start();
  await negative.drive(negative.monitor.beatNow());
  assert.equal(negative.requests.length, 1, "negative values clamp to 0");
});

test("time the page wasn't beating (a sleeping laptop) doesn't count against the grace window", async () => {
  const h = harness(outage(40 * MIN), { retryDelayMs: backoff });
  h.monitor.start();
  h.advance(30 * MIN);
  await h.drive(h.monitor.beatNow());
  assert.deepEqual(h.events, ["degraded HTTP 503"]);
  assert.equal(h.ended[0]?.details.reason, "unreachable");
  const first = h.requests[0].at, last = h.requests.at(-1)!.at;
  assert.ok(last - first >= 10 * MIN - 15_000, `retried for about 10 minutes after waking (${(last - first) / 1000} s)`);
});

test("stops at once when the API refuses the session or the workspace is out of credit", async () => {
  const cases: Array<[Reply, YoobError["code"]]> = [
    [{ status: 401, body: { error: "Missing session token" } }, "unauthorized"],
    [{ status: 403, body: {} }, "unauthorized"],
    [{ status: 402, body: { code: "quota_exceeded" } }, "out-of-credit"],
    [{ status: 200, body: { stop: true, reason: "out-of-credits" } }, "out-of-credit"],
    [{ status: 200, body: { stop: true, reason: "out-of-credits", code: "monthly_cap_reached" } }, "out-of-credit"],
    [{ status: 200, body: { stop: true, reason: "sandbox-limit", code: "sandbox_limit" } }, "session-ended"],
    [{ status: 402, body: { stop: true, reason: "suspended", code: "suspended" } }, "session-ended"],
    [{ status: 403, body: { stop: true, reason: "key-revoked", code: "key_revoked" } }, "unauthorized"],
    [{ status: 402, body: "not json" }, "out-of-credit"],
  ];
  for (const [reply, code] of cases) {
    const h = harness([reply]);
    h.monitor.start();
    await h.drive(h.monitor.beatNow());
    assert.equal(h.requests.length, 1, code);
    assert.equal(h.ended[0]?.code, code);
    assert.equal(h.monitor.active, false);
  }
});

test("opens a new session when the API has forgotten this one, and stops if that fails", async () => {
  const gone = harness([{ status: 404, body: { error: "Unknown or already-ended session." } }, { status: 200, body: {} }]);
  gone.monitor.start();
  await gone.drive(gone.monitor.beatNow());
  assert.equal(gone.renewals, 1);
  await gone.drive(gone.monitor.beatNow());
  assert.equal(gone.requests[1].auth, "Bearer st_2", "the renewed session token is used");
  assert.deepEqual(gone.ended, []);
  gone.monitor.stop();

  const abandoned = harness([{ status: 200, body: { stop: true, reason: "abandoned" } }]);
  abandoned.setRenew(async () => { throw new Error("backend down"); });
  abandoned.monitor.start();
  await abandoned.drive(abandoned.monitor.beatNow());
  assert.equal(abandoned.ended[0]?.code, "session-ended");

  const broke = harness([{ status: 404 }]);
  broke.setRenew(async () => { throw new YoobError("out-of-credit", "no credit"); });
  broke.monitor.start();
  await broke.drive(broke.monitor.beatNow());
  assert.equal(broke.ended[0]?.code, "out-of-credit");
});

test("hands over a renewed download grant and tolerates its absence", async () => {
  const h = harness([
    { status: 200, body: { stop: false, credits_remaining: 9, billed_seconds: 15, reason: null, download_token: "yg1.a", download_token_expires_at: 1790000000 } },
    { status: 200, body: { stop: false, grant: "yg1.b", grant_expires_at: "2026-09-17T13:00:00Z" } },
    { status: 200, body: { stop: false, download_token: "yg1.c", grant: "yg1.ignored" } },
    { status: 200, body: { stop: false, download_token: null, grant: null } },
    { status: 200, body: { stop: false } },
    { status: 200, body: "not an object" },
  ]);
  h.monitor.start();
  for (let i = 0; i < 6; i += 1) await h.drive(h.monitor.beatNow());
  assert.deepEqual(h.grants, ["yg1.a", "yg1.b", "yg1.c"]);
  assert.deepEqual(h.ended, []);
  h.monitor.stop();
});

test("does nothing after stop()", async () => {
  const h = harness([]);
  h.monitor.start();
  h.monitor.stop();
  await h.drive(h.monitor.beatNow());
  await h.tick(); await h.tick();
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.ended, []);
});

test("fails closed without a session token", async () => {
  const h = harness([], { sessionToken: () => undefined });
  h.monitor.start();
  await h.drive(h.monitor.beatNow());
  assert.equal(h.requests.length, 0);
  assert.equal(h.ended[0]?.code, "unauthorized");
});

/** A `/api/v1/sessions/start` endpoint that answers once. */
function startHarness(status: number, body: unknown) {
  const calls: Array<{ url: string; method?: string; auth: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method, auth: (init.headers as Record<string, string>).authorization });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("starting the meter posts the session token and returns the cap", async () => {
  const { calls, restore } = startHarness(200, { metered_from: 1700, max_session_seconds: 120, sandbox: true });
  try {
    const reply = await startSession("https://la.yoob.com/", "st_1");
    assert.equal(calls[0].url, "https://la.yoob.com/api/v1/sessions/start");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].auth, "Bearer st_1");
    assert.equal(reply.max_session_seconds, 120);
    assert.equal(reply.metered_from, 1700);
  } finally { restore(); }
});

test("a refused start says what is wrong rather than failing as a network error", async () => {
  const cases: Array<[number, string, string]> = [
    [402, "quota_exceeded", "out-of-credit"],
    [402, "monthly_cap_reached", "out-of-credit"],
    [402, "sandbox_limit", "session-ended"],
    [403, "key_revoked", "unauthorized"],
  ];
  for (const [status, code, expected] of cases) {
    const { restore } = startHarness(status, { code, error: "Nope." });
    try {
      await assert.rejects(startSession("https://la.yoob.com", "st_1"), (error: YoobError) => {
        assert.equal(error.code, expected);
        assert.equal(error.message, "Nope.");
        return true;
      });
    } finally { restore(); }
  }
});

test("a session the API has forgotten is reported as gone, not as a refusal", async () => {
  const { restore } = startHarness(404, { error: "Unknown or already-ended session." });
  try {
    await assert.rejects(startSession("https://la.yoob.com", "st_1"), (error: YoobError) => {
      assert.equal(error.code, "session-ended");
      assert.equal(error.details.reason, "gone");
      return true;
    });
  } finally { restore(); }
});
