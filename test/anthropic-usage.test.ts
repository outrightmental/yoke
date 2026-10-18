import test from "node:test";
import assert from "node:assert/strict";

import {
  ANTHROPIC_USAGE_URL,
  AnthropicUsageMonitor,
  USAGE_POLL_INTERVAL_MS,
  describeUsageChange,
  fetchAnthropicUsage,
  formatUsageLine,
  parseUsageResponse,
  readClaudeLoginToken,
  type ClaudeCredentialsReader,
  type UsageReading,
} from "../src/anthropic-usage.js";
import { formatLocalTime } from "../src/claude-agent.js";
import { EventEmitter, type DashboardEvent } from "../src/event-emitter.js";

const TOKEN = "test-usage-token-do-not-leak";
const NOW = Date.parse("2026-10-12T14:30:00Z");
const RESETS_AT = "2026-10-12T17:00:00+00:00";
const OK_BODY = {
  five_hour: { utilization: 37, resets_at: RESETS_AT },
  seven_day: { utilization: 12, resets_at: null },
};

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch that records its calls and answers each with `respond()`. */
function fakeFetch(respond: () => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function collectUsageEvents(emitter: EventEmitter): DashboardEvent[] {
  const events: DashboardEvent[] = [];
  emitter.subscribe((event) => {
    if (event.type === "usage-update") events.push(event);
  });
  return events;
}

/** The Claude CLI's credentials blob, as `claude` stores it after a login. */
function claudeCredentials(accessToken: string, expiresAt = NOW + 60 * 60_000): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: "refresh-token-do-not-leak",
      expiresAt,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
    },
  });
}

/** A credentials reader that hands back each blob in turn, repeating the last. */
function fakeCredentials(...blobs: string[]): { readCredentials: ClaudeCredentialsReader; reads: () => number } {
  let n = 0;
  return {
    readCredentials: async () => ({ raw: blobs[Math.min(n++, blobs.length - 1)]! }),
    reads: () => n,
  };
}

const NOT_LOGGED_IN: ClaudeCredentialsReader = async () => ({ valid: false, reason: "credentials not found" });

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ── parseUsageResponse ───────────────────────────────────────────────────────

test("parseUsageResponse reads the 5-hour window's utilization and reset time", () => {
  assert.deepEqual(parseUsageResponse(OK_BODY), {
    fiveHourPercent: 37,
    resetsAtMs: Date.parse(RESETS_AT),
  });
});

test("parseUsageResponse clamps utilization to 0–100", () => {
  assert.equal(parseUsageResponse({ five_hour: { utilization: 112.5, resets_at: RESETS_AT } })?.fiveHourPercent, 100);
  assert.equal(parseUsageResponse({ five_hour: { utilization: -3, resets_at: RESETS_AT } })?.fiveHourPercent, 0);
});

test("parseUsageResponse reports no reset time when no window is open", () => {
  assert.deepEqual(parseUsageResponse({ five_hour: { utilization: 0, resets_at: null } }), {
    fiveHourPercent: 0,
    resetsAtMs: null,
  });
});

test("parseUsageResponse rejects missing or malformed reset times", () => {
  assert.equal(parseUsageResponse({ five_hour: { utilization: 37 } }), null);
  assert.equal(parseUsageResponse({ five_hour: { utilization: 37, resets_at: 123 } }), null);
  assert.equal(parseUsageResponse({ five_hour: { utilization: 37, resets_at: "not a date" } }), null);
});

test("parseUsageResponse returns null without a usable 5-hour window", () => {
  assert.equal(parseUsageResponse(null), null);
  assert.equal(parseUsageResponse("nope"), null);
  assert.equal(parseUsageResponse({}), null);
  assert.equal(parseUsageResponse({ five_hour: null }), null);
  assert.equal(parseUsageResponse({ five_hour: { utilization: "37", resets_at: RESETS_AT } }), null);
  assert.equal(parseUsageResponse({ five_hour: { utilization: Number.NaN } }), null);
});

// ── fetchAnthropicUsage ──────────────────────────────────────────────────────

test("fetchAnthropicUsage GETs the usage endpoint with the OAuth token and beta header", async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
  const reading = await fetchAnthropicUsage(TOKEN, { fetchImpl, clock: () => NOW });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, ANTHROPIC_USAGE_URL);
  assert.equal(calls[0]!.init?.method, "GET");
  const headers = new Headers(calls[0]!.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer " + TOKEN);
  assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
  assert.equal(headers.get("accept"), "application/json");
  assert.ok(calls[0]!.init?.signal, "the request has a timeout signal");

  assert.deepEqual(reading, {
    status: "ok",
    fiveHourPercent: 37,
    resetsAtMs: Date.parse(RESETS_AT),
    fetchedAtMs: NOW,
    reason: "",
  });
});

test("fetchAnthropicUsage explains HTTP failures without echoing the response", async () => {
  const cases: Array<[number, RegExp]> = [
    [401, /rejected anthropic_usage_token.*401.*expired/],
    [403, /403.*user:profile/],
    [429, /rate-limiting.*429/],
    [529, /overloaded.*529/],
    [500, /HTTP 500/],
  ];
  for (const [status, expected] of cases) {
    // An error body that echoes the credential must never reach the reason.
    const { fetchImpl } = fakeFetch(() => jsonResponse({ error: { message: `bad token ${TOKEN}` } }, status));
    const reading = await fetchAnthropicUsage(TOKEN, { fetchImpl, clock: () => NOW });
    assert.equal(reading.status, "unavailable", `HTTP ${status}`);
    assert.equal(reading.fiveHourPercent, null);
    assert.equal(reading.resetsAtMs, null);
    assert.equal(reading.fetchedAtMs, NOW);
    assert.match(reading.reason, expected);
    assert.ok(!reading.reason.includes(TOKEN), `HTTP ${status} reason leaks the token`);
  }
});

test("fetchAnthropicUsage reports a network failure as unavailable instead of throwing", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  const reading = await fetchAnthropicUsage(TOKEN, { fetchImpl, clock: () => NOW });
  assert.equal(reading.status, "unavailable");
  assert.match(reading.reason, /could not reach/);
});

test("fetchAnthropicUsage gives up on a request that outlasts its timeout", async () => {
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;
  // AbortSignal.timeout's timer is unref'd; a real request's socket is what
  // keeps the process alive meanwhile, so stand in for it.
  const keepAlive = setTimeout(() => {}, 5_000);
  try {
    const reading = await fetchAnthropicUsage(TOKEN, { fetchImpl, clock: () => NOW, timeoutMs: 20 });
    assert.equal(reading.status, "unavailable");
    assert.match(reading.reason, /did not answer within/);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("fetchAnthropicUsage reports unreadable or unexpected bodies as unavailable", async () => {
  const garbage = fakeFetch(() => new Response("<html>oops</html>", { status: 200 }));
  const unreadable = await fetchAnthropicUsage(TOKEN, { fetchImpl: garbage.fetchImpl, clock: () => NOW });
  assert.equal(unreadable.status, "unavailable");
  assert.match(unreadable.reason, /unreadable JSON/);

  const noWindow = fakeFetch(() => jsonResponse({ seven_day: { utilization: 12, resets_at: null } }));
  const missing = await fetchAnthropicUsage(TOKEN, { fetchImpl: noWindow.fetchImpl, clock: () => NOW });
  assert.equal(missing.status, "unavailable");
  assert.match(missing.reason, /no 5-hour usage window/);

  for (const body of [
    { five_hour: { utilization: 37 } },
    { five_hour: { utilization: 37, resets_at: 123 } },
    { five_hour: { utilization: 37, resets_at: "not a date" } },
  ]) {
    const malformed = fakeFetch(() => jsonResponse(body));
    const reading = await fetchAnthropicUsage(TOKEN, { fetchImpl: malformed.fetchImpl, clock: () => NOW });
    assert.equal(reading.status, "unavailable");
  }
});

// ── AnthropicUsageMonitor ────────────────────────────────────────────────────

test("AnthropicUsageMonitor polls once a minute by default", () => {
  assert.equal(USAGE_POLL_INTERVAL_MS, 60_000);
});

test("AnthropicUsageMonitor with no token and no Claude login reports the gauge OFF and never fetches", async () => {
  for (const token of [undefined, null, "", "   "]) {
    const emitter = new EventEmitter();
    const events = collectUsageEvents(emitter);
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
    const monitor = new AnthropicUsageMonitor({
      token, emitter, fetchImpl, intervalMs: 5, clock: () => NOW, readCredentials: NOT_LOGGED_IN,
    });

    assert.equal(monitor.configured, false);
    monitor.start();
    await waitFor(() => events.length >= 2);
    monitor.stop();

    assert.equal(calls.length, 0, `token ${JSON.stringify(token)} triggered a fetch`);
    for (const event of events) {
      assert.equal(event.data["status"], "unconfigured");
      assert.equal(event.data["fiveHourPercent"], null);
      assert.match(event.data["reason"] as string, /log in with `claude`, or set anthropic_usage_token/);
    }
  }
});

test("AnthropicUsageMonitor without a token reads usage with the Claude CLI's own login", async () => {
  const emitter = new EventEmitter();
  const events = collectUsageEvents(emitter);
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
  const { readCredentials } = fakeCredentials(claudeCredentials(TOKEN));
  const monitor = new AnthropicUsageMonitor({ token: null, emitter, fetchImpl, clock: () => NOW, readCredentials });

  assert.equal(monitor.tokenLabel, "the Claude CLI login");
  const reading = await monitor.poll();
  assert.equal(calls.length, 1);
  assert.equal(new Headers(calls[0]!.init?.headers).get("authorization"), "Bearer " + TOKEN);
  assert.equal(reading.status, "ok");
  assert.equal(reading.fiveHourPercent, 37);
  assert.ok(!JSON.stringify(events).includes(TOKEN), "a usage-update event leaked the login token");
  assert.ok(!JSON.stringify(events).includes("refresh-token-do-not-leak"), "a usage-update event leaked the refresh token");
});

test("AnthropicUsageMonitor re-reads the Claude login on every poll, so the CLI's renewals are picked up", async () => {
  const emitter = new EventEmitter();
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
  const { readCredentials, reads } = fakeCredentials(claudeCredentials("first-token"), claudeCredentials("renewed-token"));
  const monitor = new AnthropicUsageMonitor({ token: "", emitter, fetchImpl, clock: () => NOW, readCredentials });

  await monitor.poll();
  await monitor.poll();
  assert.equal(reads(), 2);
  assert.deepEqual(
    calls.map((call) => new Headers(call.init?.headers).get("authorization")),
    ["Bearer first-token", "Bearer renewed-token"],
  );
});

test("AnthropicUsageMonitor prefers anthropic_usage_token and then never reads the Claude login", async () => {
  const emitter = new EventEmitter();
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
  const { readCredentials, reads } = fakeCredentials(claudeCredentials("claude-cli-token"));
  const monitor = new AnthropicUsageMonitor({ token: TOKEN, emitter, fetchImpl, clock: () => NOW, readCredentials });

  assert.equal(monitor.tokenLabel, "anthropic_usage_token");
  await monitor.poll();
  assert.equal(reads(), 0);
  assert.equal(new Headers(calls[0]!.init?.headers).get("authorization"), "Bearer " + TOKEN);
});

test("AnthropicUsageMonitor reports an expired Claude login without asking Anthropic", async () => {
  const emitter = new EventEmitter();
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
  const expiresAt = NOW - 1;
  const { readCredentials } = fakeCredentials(claudeCredentials(TOKEN, expiresAt));
  const monitor = new AnthropicUsageMonitor({ token: undefined, emitter, fetchImpl, clock: () => NOW, readCredentials });

  const reading = await monitor.poll();
  assert.equal(calls.length, 0);
  assert.equal(reading.status, "unavailable");
  assert.equal(
    reading.reason,
    `the Claude CLI login expired at ${formatLocalTime(expiresAt)} — claude renews it the next time it runs`,
  );
});

test("AnthropicUsageMonitor names the Claude login, not anthropic_usage_token, when Anthropic rejects it", async () => {
  const emitter = new EventEmitter();
  const { fetchImpl } = fakeFetch(() => jsonResponse({ error: { message: `bad ${TOKEN}` } }, 401));
  const { readCredentials } = fakeCredentials(claudeCredentials(TOKEN));
  const monitor = new AnthropicUsageMonitor({ token: undefined, emitter, fetchImpl, clock: () => NOW, readCredentials });

  const reading = await monitor.poll();
  assert.equal(reading.status, "unavailable");
  assert.equal(reading.reason, "Anthropic rejected the Claude CLI login (HTTP 401) — it may have expired");
});

test("AnthropicUsageMonitor survives a credentials reader that throws", async () => {
  const emitter = new EventEmitter();
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
  const readCredentials: ClaudeCredentialsReader = async () => {
    throw new Error(`keychain exploded holding ${TOKEN}`);
  };
  const monitor = new AnthropicUsageMonitor({ token: undefined, emitter, fetchImpl, clock: () => NOW, readCredentials });

  const reading = await monitor.poll();
  assert.equal(calls.length, 0);
  assert.equal(reading.status, "unavailable");
  assert.equal(reading.reason, "could not read the Claude CLI login");
});

test("AnthropicUsageMonitor reads at once, then on every interval, until stopped", async () => {
  const emitter = new EventEmitter();
  const events = collectUsageEvents(emitter);
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
  const monitor = new AnthropicUsageMonitor({ token: `  ${TOKEN}\n`, emitter, fetchImpl, intervalMs: 10, clock: () => NOW });

  monitor.start();
  monitor.start(); // idempotent: still a single polling loop
  assert.equal(calls.length, 1, "the first reading is taken immediately");
  assert.equal(new Headers(calls[0]!.init?.headers).get("authorization"), "Bearer " + TOKEN, "token is trimmed");

  await waitFor(() => events.length >= 3);
  assert.deepEqual(events[0]!.data, {
    status: "ok",
    fiveHourPercent: 37,
    resetsAtMs: Date.parse(RESETS_AT),
    fetchedAtMs: NOW,
    reason: "",
  });

  monitor.stop();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const settledCalls = calls.length;
  const settledEvents = events.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, settledCalls, "no polling after stop()");
  assert.equal(events.length, settledEvents, "no readings after stop()");
});

test("AnthropicUsageMonitor never overlaps requests when the endpoint is slow", async () => {
  const emitter = new EventEmitter();
  const events = collectUsageEvents(emitter);
  let inFlight = 0;
  let maxInFlight = 0;
  const { fetchImpl } = fakeFetch(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 25));
    inFlight -= 1;
    return jsonResponse(OK_BODY);
  });
  const monitor = new AnthropicUsageMonitor({ token: TOKEN, emitter, fetchImpl, intervalMs: 1, clock: () => NOW });

  monitor.start();
  await waitFor(() => events.length >= 3);
  monitor.stop();
  assert.equal(maxInFlight, 1);
});

test("AnthropicUsageMonitor keeps polling through failures and never publishes the token", async () => {
  const emitter = new EventEmitter();
  const events = collectUsageEvents(emitter);
  const responses = [
    () => jsonResponse({ error: { message: `invalid ${TOKEN}` } }, 401),
    () => Promise.reject(new TypeError(`connect failed for ${TOKEN}`)),
    () => jsonResponse(OK_BODY),
  ];
  let n = 0;
  const { fetchImpl } = fakeFetch(() => responses[Math.min(n++, responses.length - 1)]!());
  const monitor = new AnthropicUsageMonitor({ token: TOKEN, emitter, fetchImpl, intervalMs: 5, clock: () => NOW });

  monitor.start();
  await waitFor(() => events.length >= 3);
  monitor.stop();

  assert.deepEqual(
    events.slice(0, 3).map((e) => e.data["status"]),
    ["unavailable", "unavailable", "ok"],
  );
  for (const event of events) {
    assert.ok(!JSON.stringify(event).includes(TOKEN), "a usage-update event leaked the token");
  }
});

test("AnthropicUsageMonitor holds the last good numbers through failed reads, so a 529 does not blank the gauge (#261)", async () => {
  const emitter = new EventEmitter();
  const events = collectUsageEvents(emitter);
  const resetsAtMs = Date.parse(RESETS_AT);
  const responses = [
    () => jsonResponse({ five_hour: { utilization: 15, resets_at: RESETS_AT } }),
    () => jsonResponse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, 529),
    () => Promise.reject(new TypeError("fetch failed")),
    () => jsonResponse({ five_hour: { utilization: 18, resets_at: RESETS_AT } }),
  ];
  let n = 0;
  const { fetchImpl } = fakeFetch(() => responses[n++]!());
  let now = NOW;
  const monitor = new AnthropicUsageMonitor({ token: TOKEN, emitter, fetchImpl, clock: () => now });

  await monitor.poll();
  now += 60_000;
  assert.deepEqual(await monitor.poll(), {
    status: "unavailable",
    fiveHourPercent: 15,
    resetsAtMs,
    fetchedAtMs: NOW + 60_000,
    reason: "Anthropic is overloaded (HTTP 529)",
    heldFromMs: NOW,
  });

  now += 60_000;
  const unreachable = await monitor.poll();
  assert.equal(unreachable.status, "unavailable");
  assert.equal(unreachable.fiveHourPercent, 15);
  assert.equal(unreachable.heldFromMs, NOW, "held from the last good reading, not the last failed one");
  assert.match(unreachable.reason, /could not reach/);

  now += 60_000;
  assert.deepEqual(await monitor.poll(), {
    status: "ok",
    fiveHourPercent: 18,
    resetsAtMs,
    fetchedAtMs: NOW + 180_000,
    reason: "",
  });
  assert.deepEqual(events.map((e) => e.data["fiveHourPercent"]), [15, 15, 15, 18], "the Dashboard never loses the number");
});

test("AnthropicUsageMonitor holds nothing before its first good reading", async () => {
  const emitter = new EventEmitter();
  const { fetchImpl } = fakeFetch(() => jsonResponse({}, 529));
  const monitor = new AnthropicUsageMonitor({ token: TOKEN, emitter, fetchImpl, clock: () => NOW });

  const reading = await monitor.poll();
  assert.equal(reading.status, "unavailable");
  assert.equal(reading.fiveHourPercent, null);
  assert.equal(reading.resetsAtMs, null);
  assert.ok(!("heldFromMs" in reading));
});

test("AnthropicUsageMonitor lets held numbers go once their window resets", async () => {
  const emitter = new EventEmitter();
  const resetsAtMs = Date.parse(RESETS_AT);
  let n = 0;
  const { fetchImpl } = fakeFetch(() => (n++ === 0 ? jsonResponse(OK_BODY) : jsonResponse({}, 529)));
  let now = NOW;
  const monitor = new AnthropicUsageMonitor({ token: TOKEN, emitter, fetchImpl, clock: () => now });

  await monitor.poll();
  now = resetsAtMs - 1;
  assert.equal((await monitor.poll()).fiveHourPercent, 37);
  now = resetsAtMs;
  const afterReset = await monitor.poll();
  assert.equal(afterReset.status, "unavailable");
  assert.equal(afterReset.fiveHourPercent, null);
  assert.equal(afterReset.resetsAtMs, null);
  assert.ok(!("heldFromMs" in afterReset));
});

test("AnthropicUsageMonitor holds a reading with no open window for one window's length at most", async () => {
  const emitter = new EventEmitter();
  let n = 0;
  const { fetchImpl } = fakeFetch(() =>
    n++ === 0 ? jsonResponse({ five_hour: { utilization: 0, resets_at: null } }) : jsonResponse({}, 529));
  let now = NOW;
  const monitor = new AnthropicUsageMonitor({ token: TOKEN, emitter, fetchImpl, clock: () => now });

  await monitor.poll();
  now = NOW + 5 * 60 * 60_000 - 1;
  const held = await monitor.poll();
  assert.equal(held.fiveHourPercent, 0);
  assert.equal(held.heldFromMs, NOW);
  // A window may have opened and filled since: 0% is no longer worth showing.
  now = NOW + 5 * 60 * 60_000;
  const letGo = await monitor.poll();
  assert.equal(letGo.status, "unavailable");
  assert.equal(letGo.fiveHourPercent, null);
  assert.ok(!("heldFromMs" in letGo));
});

test("AnthropicUsageMonitor lets held numbers go when the Claude login is gone", async () => {
  const emitter = new EventEmitter();
  let n = 0;
  const { fetchImpl } = fakeFetch(() => (n++ === 0 ? jsonResponse(OK_BODY) : jsonResponse({}, 529)));
  let loggedIn = true;
  const readCredentials: ClaudeCredentialsReader = async () =>
    loggedIn ? { raw: claudeCredentials(TOKEN) } : { valid: false, reason: "credentials not found" };
  const monitor = new AnthropicUsageMonitor({ token: undefined, emitter, fetchImpl, clock: () => NOW, readCredentials });

  await monitor.poll();
  loggedIn = false;
  const loggedOut = await monitor.poll();
  assert.equal(loggedOut.status, "unconfigured");
  assert.equal(loggedOut.fiveHourPercent, null);

  // Whoever logs in next may be another account: 37% was not theirs.
  loggedIn = true;
  const failed = await monitor.poll();
  assert.equal(failed.status, "unavailable");
  assert.equal(failed.fiveHourPercent, null);
  assert.ok(!("heldFromMs" in failed));
});

test("AnthropicUsageMonitor.poll takes and publishes a single reading on demand", async () => {
  const emitter = new EventEmitter();
  const events = collectUsageEvents(emitter);
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
  const monitor = new AnthropicUsageMonitor({ token: TOKEN, emitter, fetchImpl, clock: () => NOW });

  const reading = await monitor.poll();
  assert.equal(calls.length, 1);
  assert.equal(reading.status, "ok");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.data, reading);
});

// ── readClaudeLoginToken ─────────────────────────────────────────────────────

test("readClaudeLoginToken returns the access token the Claude CLI is logged in with", async () => {
  const { readCredentials } = fakeCredentials(claudeCredentials(`  ${TOKEN}\n`));
  assert.deepEqual(await readClaudeLoginToken(NOW, readCredentials), { token: TOKEN });
});

test("readClaudeLoginToken treats a missing login as unconfigured", async () => {
  assert.deepEqual(await readClaudeLoginToken(NOW, NOT_LOGGED_IN), {
    status: "unconfigured",
    reason: "no Claude login to read it with — log in with `claude`, or set anthropic_usage_token in env.yaml",
  });

  // A CLI that runs on a Console API key keeps no claudeAiOauth login at all.
  for (const raw of ["{}", "null", JSON.stringify({ claudeAiOauth: null }), JSON.stringify({ claudeAiOauth: { accessToken: "  " } })]) {
    const { readCredentials } = fakeCredentials(raw);
    const result = await readClaudeLoginToken(NOW, readCredentials);
    assert.equal("status" in result ? result.status : "token", "unconfigured", raw);
  }
});

test("readClaudeLoginToken reports unreadable credentials as unavailable without quoting them", async () => {
  const unreadable = await readClaudeLoginToken(NOW, async () => ({
    valid: false,
    reason: "credentials unreadable: EACCES: permission denied",
  }));
  assert.deepEqual(unreadable, {
    status: "unavailable",
    reason: "could not read the Claude CLI login: credentials unreadable: EACCES: permission denied",
  });

  const { readCredentials } = fakeCredentials(`{"claudeAiOauth":{"accessToken":"${TOKEN}"`);
  const malformed = await readClaudeLoginToken(NOW, readCredentials);
  assert.deepEqual(malformed, { status: "unavailable", reason: "the Claude CLI's credentials are not valid JSON" });
  assert.ok(!JSON.stringify(malformed).includes(TOKEN));
});

test("readClaudeLoginToken passes over an expiry it cannot read, and refuses one that has passed", async () => {
  const { readCredentials: noExpiry } = fakeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }));
  assert.deepEqual(await readClaudeLoginToken(NOW, noExpiry), { token: TOKEN });

  const { readCredentials: live } = fakeCredentials(claudeCredentials(TOKEN, NOW + 1));
  assert.deepEqual(await readClaudeLoginToken(NOW, live), { token: TOKEN });

  const { readCredentials: expired } = fakeCredentials(claudeCredentials(TOKEN, NOW));
  const result = await readClaudeLoginToken(NOW, expired);
  assert.equal("status" in result ? result.status : "token", "unavailable");
});

// ── Narrating readings to the log ────────────────────────────────────────────

function ok(fiveHourPercent: number, overrides: Partial<UsageReading> = {}): UsageReading {
  return {
    status: "ok",
    fiveHourPercent,
    resetsAtMs: Date.parse(RESETS_AT),
    fetchedAtMs: NOW,
    reason: "",
    ...overrides,
  };
}

function without(status: "unconfigured" | "unavailable", reason: string): UsageReading {
  return { status, fiveHourPercent: null, resetsAtMs: null, fetchedAtMs: NOW, reason };
}

test("formatUsageLine says what the gauge shows, in one line", () => {
  assert.equal(
    formatUsageLine(ok(41.4)),
    `Claude usage: 41% of the 5-hour window used · resets in 2h 30m (${formatLocalTime(Date.parse(RESETS_AT))})`,
  );
  assert.equal(formatUsageLine(ok(0, { resetsAtMs: null })), "Claude usage: 0% of the 5-hour window used · no window open yet");
  assert.equal(
    formatUsageLine(without("unavailable", "could not reach the Anthropic usage endpoint")),
    "Claude usage: unavailable — could not reach the Anthropic usage endpoint",
  );
  assert.equal(formatUsageLine(without("unconfigured", "no Claude login")), "Claude usage: off — no Claude login");
  assert.equal(
    formatUsageLine({
      ...without("unavailable", "Anthropic is overloaded (HTTP 529)"),
      fiveHourPercent: 41.4,
      resetsAtMs: Date.parse(RESETS_AT),
      heldFromMs: NOW - 60_000,
    }),
    `Claude usage: unavailable — Anthropic is overloaded (HTTP 529) · still showing 41% from ${formatLocalTime(NOW - 60_000)}`,
  );
});

test("describeUsageChange speaks up for the first reading, each further 10%, a new window and any change of status", () => {
  const first = ok(41);
  assert.match(describeUsageChange(null, first) ?? "", /^Claude usage: 41% /);

  // Same decile, same window, a few ms of jitter on the reset: nothing new.
  assert.equal(describeUsageChange(first, ok(48.9, { resetsAtMs: first.resetsAtMs! + 7 })), null);

  assert.match(describeUsageChange(first, ok(50)) ?? "", /^Claude usage: 50% /);
  const nextWindow = ok(3, { resetsAtMs: first.resetsAtMs! + 5 * 60 * 60_000 });
  assert.match(describeUsageChange(ok(5), nextWindow) ?? "", /^Claude usage: 3% /);
  assert.match(describeUsageChange(ok(41, { resetsAtMs: null }), first) ?? "", /^Claude usage: 41% .* resets in/);

  const unreachable = without("unavailable", "could not reach the Anthropic usage endpoint");
  assert.equal(describeUsageChange(first, unreachable), "Claude usage: unavailable — could not reach the Anthropic usage endpoint");
  assert.equal(describeUsageChange(unreachable, { ...unreachable, fetchedAtMs: NOW + 60_000 }), null);
  assert.match(
    describeUsageChange(unreachable, without("unavailable", "Anthropic is rate-limiting usage reads (HTTP 429)")) ?? "",
    /HTTP 429/,
  );
  assert.match(describeUsageChange(unreachable, first) ?? "", /^Claude usage: 41% /);
});

test("AnthropicUsageMonitor logs the first reading and changes, not every poll, and never the token", async () => {
  const emitter = new EventEmitter();
  const events = collectUsageEvents(emitter);
  const percents = [41, 43, 44, 71];
  let n = 0;
  const { fetchImpl } = fakeFetch(() =>
    n < percents.length
      ? jsonResponse({ five_hour: { utilization: percents[n++], resets_at: RESETS_AT } })
      : jsonResponse({ error: { message: `no ${TOKEN}` } }, 401));
  const logged: string[] = [];
  const { readCredentials } = fakeCredentials(claudeCredentials(TOKEN));
  const monitor = new AnthropicUsageMonitor({
    token: undefined, emitter, fetchImpl, clock: () => NOW, readCredentials, log: (line) => logged.push(line),
  });

  for (let i = 0; i < 6; i++) await monitor.poll();

  assert.equal(events.length, 6, "every reading still reaches the Dashboard");
  assert.deepEqual(logged.map((line) => line.replace(/ · resets in .*$/, "")), [
    "Claude usage: 41% of the 5-hour window used",
    "Claude usage: 71% of the 5-hour window used",
    "Claude usage: unavailable — Anthropic rejected the Claude CLI login (HTTP 401) — it may have expired" +
      ` · still showing 71% from ${formatLocalTime(NOW)}`,
  ]);
  assert.ok(!logged.join("\n").includes(TOKEN), "the log leaked the token");
});

test("AnthropicUsageMonitor keeps polling when its log throws", async () => {
  const emitter = new EventEmitter();
  const events = collectUsageEvents(emitter);
  const { fetchImpl } = fakeFetch(() => jsonResponse(OK_BODY));
  const monitor = new AnthropicUsageMonitor({
    token: TOKEN, emitter, fetchImpl, intervalMs: 5, clock: () => NOW,
    log: () => { throw new Error("terminal gone"); },
  });

  monitor.start();
  await waitFor(() => events.length >= 2);
  monitor.stop();
});
