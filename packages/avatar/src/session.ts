// Session heartbeats: how Yoob meters a prepared character, and how the SDK learns that a session must stop.
import { SDK_VERSION, YoobError } from "./cdn";

/** What `POST /api/v1/sessions/heartbeat` returns. Fields the SDK doesn't know are ignored. */
export interface HeartbeatReply {
  stop?: boolean;
  /** Why the session stopped: `out-of-credits`, `sandbox-limit`, `suspended`, `key-revoked`, `abandoned`, `ended`. */
  reason?: string | null;
  /** Detail for some reasons, for example `monthly_cap_reached`. */
  code?: string | null;
  /** A renewed download grant, sent when the current one is close to expiring. */
  download_token?: string | null;
  download_token_expires_at?: string | number | null;
  /** Older name for `download_token`, also accepted. */
  grant?: string | null;
  grant_expires_at?: string | number | null;
}

/** The renewed download grant in a heartbeat reply, if any. */
export function renewedGrant(reply: HeartbeatReply): { token: string; expiresAt?: string | number } | undefined {
  if (typeof reply.download_token === "string" && reply.download_token) {
    return { token: reply.download_token, expiresAt: reply.download_token_expires_at ?? undefined };
  }
  if (typeof reply.grant === "string" && reply.grant) {
    return { token: reply.grant, expiresAt: reply.grant_expires_at ?? undefined };
  }
  return undefined;
}

/** Why a stopped session can't simply be replaced, or undefined when a new session may be opened. */
function terminalStop(reason: string | null | undefined): YoobError | undefined {
  switch (reason) {
    case "out-of-credits": return new YoobError("out-of-credit", "This Yoob workspace is out of credit.");
    case "sandbox-limit": return new YoobError("session-ended", "This sandbox session reached its time limit.");
    case "suspended": return new YoobError("session-ended", "This Yoob workspace is suspended.");
    case "key-revoked": return new YoobError("unauthorized", "The API key that opened this session was revoked.");
    default: return undefined;
  }
}

export interface SessionMonitorOptions {
  /** Where heartbeats go, for example `https://api2.yoob.com`. Read before every beat. */
  apiBase: () => string;
  /** The current session token. Read before every beat, so a renewed session is picked up. */
  sessionToken: () => string | undefined;
  intervalSeconds: number;
  /**
   * Opens a new session through the app's backend. Called when the API no longer knows the session (it was idle too
   * long, for example a sleeping laptop). Throwing ends the session.
   */
  renew: () => Promise<void>;
  /** A renewed download grant arrived with a heartbeat. */
  onGrant: (grant: string, expiresAt?: string | number) => void;
  /** The session can't continue. Called once; the monitor has stopped. */
  onEnded: (error: YoobError) => void;
  /**
   * How long the session keeps running while heartbeats can't get an answer (network errors, timeouts, 408, 429, 5xx,
   * unreadable replies), counted from the last successful heartbeat. When it runs out the session ends as
   * `session-ended` with reason `unreachable`. Clamped to 0 (end at the first failure) through 1800. Default 600.
   */
  outageGraceSeconds?: number;
  /** Heartbeats started failing without an answer. The session keeps running while they are retried. */
  onDegraded?: (detail: string) => void;
  /** A heartbeat succeeded again after `onDegraded`. */
  onRecovered?: () => void;
  /** Waits before retrying a failed heartbeat, by failure count. Default 2 s, 6 s, then every 15 s, with jitter. */
  retryDelayMs?: (failures: number) => number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds on a monotonic clock. Default `performance.now()`. */
  now?: () => number;
  /** Milliseconds before a heartbeat request is abandoned and counted as failed. Default 10 s. */
  timeoutMs?: number;
}

type Outcome =
  | { kind: "ok"; reply: HeartbeatReply }
  | { kind: "gone" }
  | { kind: "fatal"; error: YoobError }
  | { kind: "transient"; detail: string };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultRetryDelay = (failures: number) =>
  (failures <= 1 ? 2_000 : failures === 2 ? 6_000 : 15_000) * (0.8 + Math.random() * 0.4);
const defaultNow = () => (typeof performance === "undefined" ? Date.now() : performance.now());

/** Default and bounds of `outageGraceSeconds`. */
export const OUTAGE_GRACE_SECONDS = { default: 600, min: 0, max: 1800 } as const;

export function clampOutageGrace(seconds: number | undefined): number {
  if (seconds === undefined || Number.isNaN(seconds)) return OUTAGE_GRACE_SECONDS.default;
  return Math.min(OUTAGE_GRACE_SECONDS.max, Math.max(OUTAGE_GRACE_SECONDS.min, seconds));
}

/**
 * Sends a heartbeat every `intervalSeconds` from the moment the session opens.
 *
 * A refused session (401, 403) or an exhausted workspace (402, or `stop` with a terminal reason) ends the session at
 * once through `onEnded`, even while degraded. Failures without an answer (network, timeout, 408, 429, 5xx, unreadable
 * reply) only degrade it: they are retried with backoff and the session keeps running until `outageGraceSeconds` have
 * passed since the last successful heartbeat.
 */
export class SessionMonitor {
  private running = false;
  private generation = 0;
  private failures = 0;
  private inFlight?: Promise<void>;
  private wake?: () => void;
  private lastOk = 0;
  private degradedValue = false;
  private readonly graceMs: number;
  private readonly now: () => number;

  constructor(private readonly options: SessionMonitorOptions) {
    this.graceMs = clampOutageGrace(options.outageGraceSeconds) * 1000;
    this.now = options.now ?? defaultNow;
  }

  get active(): boolean { return this.running; }
  get consecutiveFailures(): number { return this.failures; }
  /** Heartbeats are failing without an answer and being retried. */
  get degraded(): boolean { return this.degradedValue; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    this.degradedValue = false;
    this.lastOk = this.now();
    const generation = ++this.generation;
    void this.loop(generation);
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.wake?.();
  }

  /** Beats now (for example when the page becomes visible) unless a beat is already running. */
  beatNow(): Promise<void> {
    if (!this.running) return Promise.resolve();
    this.inFlight ??= this.beat(this.generation).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async loop(generation: number): Promise<void> {
    while (this.running && generation === this.generation) {
      await this.pause(Math.max(5, this.options.intervalSeconds) * 1000);
      if (!this.running || generation !== this.generation) return;
      await this.beatNow();
    }
  }

  /** Sleeps, but wakes early when the monitor stops. */
  private pause(ms: number): Promise<void> {
    const sleep = this.options.sleep ?? defaultSleep;
    return new Promise<void>((resolve) => {
      this.wake = resolve;
      void sleep(ms).then(resolve);
    });
  }

  private async beat(generation: number): Promise<void> {
    const intervalMs = Math.max(5, this.options.intervalSeconds) * 1000;
    // Time the page wasn't beating at all (a sleeping laptop, a frozen tab) isn't an outage: the grace window starts no
    // earlier than one interval before this beat.
    const anchor = Math.max(this.lastOk, this.now() - intervalMs);
    for (;;) {
      if (!this.running || generation !== this.generation) return;
      const outcome = await this.send();
      if (!this.running || generation !== this.generation) return;
      switch (outcome.kind) {
        case "ok":
          this.succeeded();
          return this.handle(outcome.reply);
        case "fatal":
          return this.end(outcome.error);
        case "gone":
          return this.renew("The Yoob session ended and a new one couldn't be opened.");
        case "transient": {
          this.failures += 1;
          const remaining = anchor + this.graceMs - this.now();
          if (remaining <= 0) {
            return this.end(new YoobError("session-ended",
              `Yoob couldn't be reached (${outcome.detail}), so the character stopped.`, { reason: "unreachable" }));
          }
          if (!this.degradedValue) {
            this.degradedValue = true;
            this.options.onDegraded?.(outcome.detail);
          }
          await this.pause(Math.min(remaining, (this.options.retryDelayMs ?? defaultRetryDelay)(this.failures)));
        }
      }
    }
  }

  private succeeded(): void {
    this.failures = 0;
    this.lastOk = this.now();
    if (!this.degradedValue) return;
    this.degradedValue = false;
    this.options.onRecovered?.();
  }

  private async handle(reply: HeartbeatReply): Promise<void> {
    const grant = renewedGrant(reply);
    if (grant) this.options.onGrant(grant.token, grant.expiresAt);
    if (!reply.stop) return;
    const terminal = terminalStop(reply.reason);
    if (terminal) return this.end(terminal);
    // The API ended the session because it went quiet (a sleeping laptop): open a new one through the backend.
    return this.renew("The Yoob session ended and a new one couldn't be opened.");
  }

  private async renew(message: string): Promise<void> {
    const generation = this.generation;
    try {
      await this.options.renew();
      if (generation === this.generation) this.succeeded();
    } catch (error) {
      if (generation !== this.generation) return;
      const cause = error instanceof YoobError && error.code === "out-of-credit" ? error : undefined;
      this.end(cause ?? new YoobError("session-ended", message));
    }
  }

  private end(error: YoobError): void {
    if (!this.running) return;
    this.stop();
    this.options.onEnded(error);
  }

  private async send(): Promise<Outcome> {
    const token = this.options.sessionToken();
    if (!token) return { kind: "fatal", error: new YoobError("unauthorized", "There is no Yoob session to keep alive.") };
    const doFetch = this.options.fetch ?? fetch;
    const controller = typeof AbortController === "undefined" ? undefined : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000) : undefined;
    try {
      const response = await doFetch(`${this.options.apiBase().replace(/\/+$/, "")}/api/v1/sessions/heartbeat`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-yoob-sdk": `yoob-web/${SDK_VERSION}` },
        credentials: "omit",
        signal: controller?.signal,
      });
      return await classify(response);
    } catch (error) {
      return { kind: "transient", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

async function classify(response: Response): Promise<Outcome> {
  switch (response.status) {
    case 401:
    case 403:
    case 402: {
      const body = await response.json().catch(() => ({})) as HeartbeatReply | null;
      const terminal = terminalStop(body?.reason);
      if (terminal) return { kind: "fatal", error: terminal };
      return response.status === 402
        ? { kind: "fatal", error: new YoobError("out-of-credit", "This Yoob workspace is out of credit.") }
        : { kind: "fatal", error: new YoobError("unauthorized", "Yoob refused the session. Fetch a new one from your backend.") };
    }
    case 404:
    case 410:
      return { kind: "gone" };
  }
  if (!response.ok) return { kind: "transient", detail: `HTTP ${response.status}` };
  try {
    const reply = await response.json() as HeartbeatReply | null;
    return { kind: "ok", reply: reply && typeof reply === "object" ? reply : {} };
  } catch {
    return { kind: "transient", detail: "unreadable heartbeat reply" };
  }
}

/** What `POST /api/v1/sessions/start` returns. */
export interface StartReply {
  metered_from?: number;
  max_session_seconds?: number;
  sandbox?: boolean;
  balance_usd?: number;
  balance_low?: boolean;
}

/**
 * Starts the meter on an open session: the moment the user begins talking.
 *
 * Opening a session only buys the right to download a character; this is what
 * starts the clock. It is idempotent, so a retry can't restart it, and a
 * refusal here (no credit, a revoked key, a used-up sandbox allowance) means
 * the conversation must not go ahead.
 */
export async function startSession(apiBase: string, token: string): Promise<StartReply> {
  const response = await fetch(`${apiBase.replace(/\/+$/, "")}/api/v1/sessions/start`, {
    method: "POST",
    credentials: "omit",
    headers: { authorization: `Bearer ${token}`, "x-yoob-sdk": `yoob-web/${SDK_VERSION}` },
  });
  const body = await response.json().catch(() => null) as (StartReply & { code?: string; error?: string }) | null;
  if (response.ok) return body ?? {};
  throw startRefusal(response.status, body?.code, body?.error);
}

/** Why the API wouldn't start the meter. The message is the API's, which names the workspace's actual problem. */
function startRefusal(status: number, code: string | undefined, error: string | undefined): YoobError {
  const fallback = error ?? `The Yoob session couldn't be started (HTTP ${status}).`;
  switch (code) {
    case "quota_exceeded":
    case "monthly_cap_reached": return new YoobError("out-of-credit", fallback);
    case "sandbox_limit":
    case "suspended": return new YoobError("session-ended", fallback, { reason: code });
    case "key_revoked": return new YoobError("unauthorized", fallback);
  }
  if (status === 402) return new YoobError("out-of-credit", fallback);
  if (status === 401 || status === 403) return new YoobError("unauthorized", fallback);
  // 404 means the session is gone; the caller opens a new one rather than giving up.
  if (status === 404 || status === 410) return new YoobError("session-ended", fallback, { reason: "gone" });
  return new YoobError("session-ended", fallback);
}

/** Sends the final heartbeat that ends a session. Best effort. */
export async function endSession(apiBase: string, token: string, keepalive = false): Promise<void> {
  await fetch(`${apiBase.replace(/\/+$/, "")}/api/v1/sessions/end`, {
    method: "POST",
    keepalive,
    credentials: "omit",
    headers: { authorization: `Bearer ${token}`, "x-yoob-sdk": `yoob-web/${SDK_VERSION}` },
  });
}
