import {
  clockTimeRefs,
  formatLocalTime,
  formatWaitRemaining,
  readClaudeCredentials,
  type ClaudeAuthResult,
  type ClockTimeRef,
} from "./claude-agent.js";
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

/** The length of the rolling usage window. No reading older than this can
 *  describe the window that is open now. */
const USAGE_WINDOW_MS = 5 * 60 * 60_000;

/** A request still hanging after this is given up on until the next poll. */
const USAGE_REQUEST_TIMEOUT_MS = 15_000;

/** How messages name env.yaml's token. */
export const CONFIGURED_TOKEN_LABEL = "anthropic_usage_token";
/** How messages name the token the Claude CLI itself is logged in with. */
export const CLAUDE_LOGIN_LABEL = "the Claude CLI login";

/**
 * - `ok`: live numbers.
 * - `unconfigured`: nothing to read with — no `anthropic_usage_token` in
 *   env.yaml, and the Claude CLI is not logged in to a Claude account.
 * - `unavailable`: there is a token, but this reading could not be taken.
 */
export type UsageStatus = "ok" | "unconfigured" | "unavailable";

/** One reading, exactly as it is sent to the Dashboard. Never holds the token. */
export interface UsageReading {
  status: UsageStatus;
  /** Percent (0–100) of the 5-hour window consumed; null unless status is "ok",
   *  or an "unavailable" reading holds over the last good one's (see `heldFromMs`). */
  fiveHourPercent: number | null;
  /** Epoch millis the 5-hour window resets; null when unknown or none is open. */
  resetsAtMs: number | null;
  /** Epoch millis this reading was taken. */
  fetchedAtMs: number;
  /** Why this reading has no fresh numbers, for the gauge's tooltip; empty when status is "ok". */
  reason: string;
  /**
   * Set only on an "unavailable" reading that carries the numbers of the last
   * good one, so a failed read — a 529 from an overloaded endpoint, say — does
   * not blank the gauge: the epoch millis those numbers were read.
   */
  heldFromMs?: number;
  /**
   * The wall-clock times `reason` names, as the server rendered them, so the
   * Dashboard can show them in the viewer's time zone instead. Absent when the
   * reason names none.
   */
  clockTimes?: ClockTimeRef[];
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
function describeHttpFailure(status: number, tokenLabel: string): string {
  if (status === 401) {
    return `Anthropic rejected ${tokenLabel} (HTTP 401) — it may have expired`;
  }
  if (status === 403) {
    return `${tokenLabel} may not read usage (HTTP 403) — it needs the user:profile scope of a Claude login token`;
  }
  if (status === 429) return "Anthropic is rate-limiting usage reads (HTTP 429)";
  if (status === 529) return "Anthropic is overloaded (HTTP 529)";
  return `Anthropic usage endpoint answered HTTP ${status}`;
}

export interface FetchUsageOptions {
  fetchImpl?: typeof fetch;
  clock?: () => number;
  timeoutMs?: number;
  /** How failure reasons name the token (default: anthropic_usage_token). */
  tokenLabel?: string;
}

function readingWithoutNumbers(
  status: Exclude<UsageStatus, "ok">,
  reason: string,
  nowMs: number,
  clockTimes: ClockTimeRef[] = [],
): UsageReading {
  return {
    status,
    fiveHourPercent: null,
    resetsAtMs: null,
    fetchedAtMs: nowMs,
    reason,
    ...(clockTimes.length > 0 ? { clockTimes } : {}),
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
  const tokenLabel = options.tokenLabel ?? CONFIGURED_TOKEN_LABEL;
  const unavailable = (reason: string): UsageReading =>
    readingWithoutNumbers("unavailable", reason, clock());

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
      return unavailable(describeHttpFailure(response.status, tokenLabel));
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

/** Reads the Claude CLI's stored credentials blob; see `readClaudeCredentials`. */
export type ClaudeCredentialsReader = () => Promise<{ raw: string } | ClaudeAuthResult>;

const NO_CLAUDE_LOGIN_REASON =
  "no Claude login to read it with — log in with `claude`, or set anthropic_usage_token in env.yaml";

/**
 * The access token the Claude CLI is logged in with: the `claudeAiOauth`
 * credential it keeps for its own runs, which carries the `user:profile` scope
 * the usage endpoint needs. Read afresh for every poll, because the CLI renews
 * it and a copy taken at startup would expire within hours. Yoke never renews
 * it itself — that would hand the CLI a used-up refresh token.
 *
 * Without one — the CLI is not logged in, or runs on a Console API key, which
 * has no usage windows — returns why instead, as the status the gauge shows.
 */
export async function readClaudeLoginToken(
  nowMs: number,
  readCredentials: ClaudeCredentialsReader = readClaudeCredentials,
): Promise<
  { token: string } | { status: Exclude<UsageStatus, "ok">; reason: string; clockTimes?: ClockTimeRef[] }
> {
  const read = await readCredentials();
  if ("valid" in read) {
    return read.reason === "credentials not found"
      ? { status: "unconfigured", reason: NO_CLAUDE_LOGIN_REASON }
      : { status: "unavailable", reason: `could not read the Claude CLI login: ${read.reason ?? "unknown error"}` };
  }
  let credentials: unknown;
  try {
    credentials = JSON.parse(read.raw);
  } catch {
    // Never quote the blob: it is the credential.
    return { status: "unavailable", reason: "the Claude CLI's credentials are not valid JSON" };
  }
  const oauth = typeof credentials === "object" && credentials !== null
    ? (credentials as Record<string, unknown>)["claudeAiOauth"]
    : undefined;
  const fields = typeof oauth === "object" && oauth !== null ? (oauth as Record<string, unknown>) : {};
  const token = typeof fields["accessToken"] === "string" ? fields["accessToken"].trim() : "";
  if (token === "") return { status: "unconfigured", reason: NO_CLAUDE_LOGIN_REASON };
  const expiresAt = fields["expiresAt"];
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt <= nowMs) {
    // Asking anyway would only earn a 401.
    return {
      status: "unavailable",
      reason: `the Claude CLI login expired at ${formatLocalTime(expiresAt)} — claude renews it the next time it runs`,
      clockTimes: clockTimeRefs(expiresAt),
    };
  }
  return { token };
}

/**
 * One reading as a log line, e.g. "Claude usage: 41% of the 5-hour window
 * used · resets in 37m (Oct 14, 10:10 PM)".
 */
export function formatUsageLine(reading: UsageReading): string {
  if (reading.status === "unconfigured") return `Claude usage: off — ${reading.reason}`;
  if (reading.status !== "ok" || reading.fiveHourPercent === null) {
    const held = reading.heldFromMs !== undefined && reading.fiveHourPercent !== null
      ? ` · still showing ${Math.round(reading.fiveHourPercent)}% from ${formatLocalTime(reading.heldFromMs)}`
      : "";
    return `Claude usage: unavailable — ${reading.reason}${held}`;
  }
  const used = `${Math.round(reading.fiveHourPercent)}% of the 5-hour window used`;
  if (reading.resetsAtMs === null) return `Claude usage: ${used} · no window open yet`;
  return (
    `Claude usage: ${used} · resets in ${formatWaitRemaining(reading.resetsAtMs - reading.fetchedAtMs)}` +
    ` (${formatLocalTime(reading.resetsAtMs)})`
  );
}

/** The wall-clock times `formatUsageLine(reading)` names, for the Dashboard to render in the viewer's zone. */
export function usageLineClockTimes(reading: UsageReading): ClockTimeRef[] {
  return [...(reading.clockTimes ?? []), ...clockTimeRefs(reading.heldFromMs, reading.resetsAtMs)];
}

function usageDecile(reading: UsageReading): number | null {
  return reading.fiveHourPercent === null ? null : Math.floor(reading.fiveHourPercent / 10);
}

/** Two readings of one window can disagree on its reset by a fraction of a second. */
function sameWindow(a: number | null, b: number | null): boolean {
  return a === null || b === null ? a === b : Math.abs(a - b) < 60_000;
}

/**
 * The line to log for `reading`, or null when it says nothing new since
 * `previous`. A reading arrives every minute, so the log hears about the first
 * one, about every change of status or reason, and — while readings are live —
 * about each further 10% of the window used and each new window; not about
 * every poll.
 */
export function describeUsageChange(
  previous: UsageReading | null,
  reading: UsageReading,
): string | null {
  const unchanged =
    previous !== null &&
    previous.status === reading.status &&
    previous.reason === reading.reason &&
    usageDecile(previous) === usageDecile(reading) &&
    sameWindow(previous.resetsAtMs, reading.resetsAtMs);
  return unchanged ? null : formatUsageLine(reading);
}

export interface UsageMonitorOptions {
  /** env.yaml's `anthropic_usage_token`. Blank or missing: the Claude CLI's own login is used. */
  token: string | null | undefined;
  emitter: EventEmitter;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  /** Where the Claude CLI's login is read from when no token is configured. */
  readCredentials?: ClaudeCredentialsReader;
  /** Told, in one line, whenever a reading changes what the gauge says — with
   *  the wall-clock times the line names. */
  log?: (line: string, clockTimes: readonly ClockTimeRef[]) => void;
}

/**
 * Keeps the header gauge live: reads usage as soon as it starts, then once per
 * interval, publishing every reading as a `usage-update` event — a failed one
 * carrying the last good numbers along. The next read is scheduled only after
 * the previous one settles, so a slow endpoint can never stack requests up.
 */
export class AnthropicUsageMonitor {
  private readonly token: string;
  private readonly emitter: EventEmitter;
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private readonly fetchOptions: FetchUsageOptions;
  private readonly readCredentials: ClaudeCredentialsReader;
  private readonly log: ((line: string, clockTimes: readonly ClockTimeRef[]) => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private last: UsageReading | null = null;
  private lastOk: UsageReading | null = null;

  constructor(options: UsageMonitorOptions) {
    this.token = options.token?.trim() ?? "";
    this.emitter = options.emitter;
    this.intervalMs = options.intervalMs ?? USAGE_POLL_INTERVAL_MS;
    this.clock = options.clock ?? Date.now;
    this.fetchOptions = {
      clock: this.clock,
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    };
    this.readCredentials = options.readCredentials ?? readClaudeCredentials;
    this.log = options.log;
  }

  /** True when env.yaml sets a token; otherwise the Claude CLI's login is used. */
  get configured(): boolean {
    return this.token.length > 0;
  }

  /** What usage is read with, for the startup banner. */
  get tokenLabel(): string {
    return this.configured ? CONFIGURED_TOKEN_LABEL : CLAUDE_LOGIN_LABEL;
  }

  /**
   * Publish a reading now and every interval after. Polling continues even
   * while there is nothing to read with, so a `claude` login made after
   * startup lights the gauge without a restart.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
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
    const reading = this.holdLastOk(await this.read());
    this.publish(reading);
    return reading;
  }

  /**
   * A failed read keeps the last good numbers on the gauge. The endpoint
   * answers the odd poll with a 529 or not at all, and blanking the gauge for
   * that minute made it flicker in and out (#261). The numbers are let go once
   * the window they describe has reset — or, when no window was open, once a
   * whole window's length has passed — or when there is no login left to read
   * with; the reason still says why this reading failed.
   */
  private holdLastOk(reading: UsageReading): UsageReading {
    if (reading.status === "ok") {
      this.lastOk = reading;
      return reading;
    }
    if (reading.status === "unconfigured") {
      this.lastOk = null;
      return reading;
    }
    const last = this.lastOk;
    if (last === null || (last.resetsAtMs ?? last.fetchedAtMs + USAGE_WINDOW_MS) <= reading.fetchedAtMs) {
      return reading;
    }
    return {
      ...reading,
      fiveHourPercent: last.fiveHourPercent,
      resetsAtMs: last.resetsAtMs,
      heldFromMs: last.fetchedAtMs,
    };
  }

  private async read(): Promise<UsageReading> {
    if (this.configured) {
      return fetchAnthropicUsage(this.token, { ...this.fetchOptions, tokenLabel: CONFIGURED_TOKEN_LABEL });
    }
    let login: Awaited<ReturnType<typeof readClaudeLoginToken>>;
    try {
      login = await readClaudeLoginToken(this.clock(), this.readCredentials);
    } catch {
      login = { status: "unavailable", reason: "could not read the Claude CLI login" };
    }
    if (!("token" in login)) return readingWithoutNumbers(login.status, login.reason, this.clock(), login.clockTimes);
    return fetchAnthropicUsage(login.token, { ...this.fetchOptions, tokenLabel: CLAUDE_LOGIN_LABEL });
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
    const line = describeUsageChange(this.last, reading);
    this.last = reading;
    if (line !== null) {
      try {
        this.log?.(line, usageLineClockTimes(reading));
      } catch {
        // A log that cannot be written must not stop the gauge's polling.
      }
    }
    this.emitter.emit("usage-update", { ...reading });
  }
}
