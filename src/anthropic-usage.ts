import type { EventEmitter } from "./event-emitter.js";

// ─── Live Claude account usage (#254) ────────────────────────────────────────
//
// A `"claude-usage-limit"` work hold says the subscription quota ran out after
// the fact. This is the other side of it: how much of the rolling 5-hour window
// is already used and when it resets, read once a minute for the gauge in the
// Dashboard header, so work can be planned against what is left.

/** Anthropic's report of a Claude account's rolling usage windows. */
export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** OAuth-authenticated requests to the endpoint must opt in to this beta. */
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

/** How often the gauge is refreshed. The endpoint rate-limits per token. */
export const USAGE_POLL_INTERVAL_MS = 60_000;

/** A request still hanging after this is given up on until the next poll. */
const USAGE_REQUEST_TIMEOUT_MS = 15_000;

/**
 * - `ok`: live numbers.
 * - `unconfigured`: no `anthropic_usage_token` in env.yaml, so nothing is read.
 * - `unavailable`: a token is set but this reading could not be taken.
 */
export type UsageStatus = "ok" | "unconfigured" | "unavailable";

/** One reading, exactly as it is sent to the Dashboard. Never holds the token. */
export interface UsageReading {
  status: UsageStatus;
  /** Percent (0–100) of the 5-hour window consumed; null unless status is "ok". */
  fiveHourPercent: number | null;
  /** Epoch millis the 5-hour window resets; null when unknown or none is open. */
  resetsAtMs: number | null;
  /** Epoch millis this reading was taken. */
  fetchedAtMs: number;
  /** Why there are no numbers, for the gauge's tooltip; empty when status is "ok". */
  reason: string;
}

/**
 * The 5-hour window out of a usage response:
 * `{ "five_hour": { "utilization": 37.0, "resets_at": "2026-…+00:00" }, … }`.
 * `utilization` is already a percentage. `resets_at` is null while no window is
 * open. Returns null when the response has no usable 5-hour window.
 */
export function parseUsageResponse(
  body: unknown,
): { fiveHourPercent: number; resetsAtMs: number | null } | null {
  if (typeof body !== "object" || body === null) return null;
  const window = (body as Record<string, unknown>)["five_hour"];
  if (typeof window !== "object" || window === null) return null;
  const utilization = (window as Record<string, unknown>)["utilization"];
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  const resetsAt = (window as Record<string, unknown>)["resets_at"];
  const resetsAtMs =
    resetsAt === null ? null : typeof resetsAt === "string" ? Date.parse(resetsAt) : Number.NaN;
  if (resetsAtMs !== null && !Number.isFinite(resetsAtMs)) return null;
  return {
    fiveHourPercent: Math.min(100, Math.max(0, utilization)),
    resetsAtMs,
  };
}

/**
 * What a failed status means for the operator. Composed here rather than
 * passed through from the response, so nothing the server echoes back — the
 * credential included — can reach the browser.
 */
function describeHttpFailure(status: number): string {
  if (status === 401) {
    return "Anthropic rejected anthropic_usage_token (HTTP 401) — it may have expired";
  }
  if (status === 403) {
    return "anthropic_usage_token may not read usage (HTTP 403) — it needs the user:profile scope of a Claude login token";
  }
  if (status === 429) return "Anthropic is rate-limiting usage reads (HTTP 429)";
  return `Anthropic usage endpoint answered HTTP ${status}`;
}

export interface FetchUsageOptions {
  fetchImpl?: typeof fetch;
  clock?: () => number;
  timeoutMs?: number;
}

function unconfiguredReading(nowMs: number): UsageReading {
  return {
    status: "unconfigured",
    fiveHourPercent: null,
    resetsAtMs: null,
    fetchedAtMs: nowMs,
    reason: "set anthropic_usage_token in env.yaml to show live Claude usage",
  };
}

/** Read the account's 5-hour window once. Never throws: a failure is a reading too. */
export async function fetchAnthropicUsage(
  token: string,
  options: FetchUsageOptions = {},
): Promise<UsageReading> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? Date.now;
  const timeoutMs = options.timeoutMs ?? USAGE_REQUEST_TIMEOUT_MS;
  const unavailable = (reason: string): UsageReading => ({
    status: "unavailable",
    fiveHourPercent: null,
    resetsAtMs: null,
    fetchedAtMs: clock(),
    reason,
  });

  let body: unknown;
  try {
    const response = await fetchImpl(ANTHROPIC_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + token,
        "anthropic-beta": ANTHROPIC_OAUTH_BETA,
        Accept: "application/json",
        "User-Agent": "yoke",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return unavailable(describeHttpFailure(response.status));
    }
    try {
      body = await response.json();
    } catch {
      return unavailable("Anthropic usage endpoint returned unreadable JSON");
    }
  } catch (error) {
    return unavailable(
      error instanceof Error && error.name === "TimeoutError"
        ? `Anthropic usage endpoint did not answer within ${Math.round(timeoutMs / 1000)}s`
        : "could not reach the Anthropic usage endpoint",
    );
  }

  const parsed = parseUsageResponse(body);
  if (parsed === null) return unavailable("the account reports no 5-hour usage window");
  return { status: "ok", ...parsed, fetchedAtMs: clock(), reason: "" };
}

export interface UsageMonitorOptions {
  /** env.yaml's `anthropic_usage_token`. Blank or missing turns the gauge OFF. */
  token: string | null | undefined;
  emitter: EventEmitter;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  clock?: () => number;
}

/**
 * Keeps the header gauge live: reads usage as soon as it starts, then once per
 * interval, publishing every reading as a `usage-update` event. The next read
 * is scheduled only after the previous one settles, so a slow endpoint can
 * never stack requests up.
 */
export class AnthropicUsageMonitor {
  private readonly token: string;
  private readonly emitter: EventEmitter;
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private readonly fetchOptions: FetchUsageOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(options: UsageMonitorOptions) {
    this.token = options.token?.trim() ?? "";
    this.emitter = options.emitter;
    this.intervalMs = options.intervalMs ?? USAGE_POLL_INTERVAL_MS;
    this.clock = options.clock ?? Date.now;
    this.fetchOptions = {
      clock: this.clock,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    };
  }

  /** True when a token is configured, i.e. there is anything to poll. */
  get configured(): boolean {
    return this.token.length > 0;
  }

  /**
   * Publish a reading now and, with a token configured, every interval after.
   * Without one there is nothing to poll: the gauge is told it is OFF, once.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.configured) {
      this.publish(unconfiguredReading(this.clock()));
      return;
    }
    void this.pollAndReschedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Take one reading and publish it. */
  async poll(): Promise<UsageReading> {
    const reading = this.configured
      ? await fetchAnthropicUsage(this.token, this.fetchOptions)
      : unconfiguredReading(this.clock());
    this.publish(reading);
    return reading;
  }

  private async pollAndReschedule(): Promise<void> {
    await this.poll();
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollAndReschedule();
    }, this.intervalMs);
    // Polling must never be the thing that keeps the process alive.
    this.timer.unref?.();
  }

  private publish(reading: UsageReading): void {
    this.emitter.emit("usage-update", { ...reading });
  }
}
