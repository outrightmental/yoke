import test from "node:test";
import assert from "node:assert/strict";

import {
  ANTHROPIC_USAGE_URL,
  AnthropicUsageMonitor,
  USAGE_POLL_INTERVAL_MS,
  fetchAnthropicUsage,
  parseUsageResponse,
} from "../src/anthropic-usage.js";
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

test("AnthropicUsageMonitor without a token reports the gauge OFF once and never fetches", async () => {
  for (const token of [undefined, null, "", "   "]) {
    const emitter = new EventEmitter();
    const events = collectUsageEvents(emitter);
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(OK_BODY));
    const monitor = new AnthropicUsageMonitor({ token, emitter, fetchImpl, intervalMs: 5, clock: () => NOW });

    assert.equal(monitor.configured, false);
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    monitor.stop();

    assert.equal(calls.length, 0, `token ${JSON.stringify(token)} triggered a fetch`);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.data["status"], "unconfigured");
    assert.equal(events[0]!.data["fiveHourPercent"], null);
    assert.match(events[0]!.data["reason"] as string, /anthropic_usage_token/);
  }
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
