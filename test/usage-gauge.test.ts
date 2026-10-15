import test from "node:test";
import assert from "node:assert/strict";

import {
  USAGE_STALE_AFTER_MS,
  usageGaugeView,
  usageLimitUntilMs,
} from "../src/dashboard/shared/usage-gauge.js";
import type { AccountUsage } from "../src/dashboard/store/types.js";
import { YokeHeader } from "../src/dashboard/components/yoke-header.js";

const NOW = Date.parse("2026-10-12T14:30:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function okReading(fiveHourPercent: number, overrides: Partial<AccountUsage> = {}): AccountUsage {
  return {
    status: "ok",
    fiveHourPercent,
    resetsAtMs: NOW + 2 * HOUR + 14 * MINUTE + 30_000,
    fetchedAtMs: NOW - 20_000,
    reason: "",
    ...overrides,
  };
}

/** A Lit TemplateResult flattened to the markup it describes. */
function flatten(value: unknown): string {
  if (value === null || value === undefined || typeof value === "symbol") return "";
  if (Array.isArray(value)) return value.map(flatten).join("");
  if (typeof value === "object" && "strings" in value && "values" in value) {
    const { strings, values } = value as { strings: readonly string[]; values: readonly unknown[] };
    return strings.reduce((out, s, i) => out + s + (i < values.length ? flatten(values[i]) : ""), "");
  }
  return String(value);
}

function renderHeader(props: Partial<YokeHeader> = {}): string {
  const header = new YokeHeader();
  Object.assign(header, { owner: "o", repo: "r" }, props);
  return flatten(header.render()).replace(/\s+/g, " ");
}

// ── usageGaugeView ───────────────────────────────────────────────────────────

test("usageGaugeView: before the first reading the gauge is dark, not blank", () => {
  assert.deepEqual(usageGaugeView(null, NOW), {
    tone: "unknown",
    percentText: "—",
    fillPercent: 0,
    resetText: "—",
    title: "Claude usage: waiting for the first reading",
  });
});

test("usageGaugeView: without a configured token the gauge reads OFF and says how to turn it on", () => {
  const view = usageGaugeView({
    status: "unconfigured",
    fiveHourPercent: null,
    resetsAtMs: null,
    fetchedAtMs: NOW,
    reason: "set anthropic_usage_token in env.yaml to show live Claude usage",
  }, NOW);
  assert.equal(view.tone, "unknown");
  assert.equal(view.percentText, "OFF");
  assert.equal(view.resetText, "—");
  assert.equal(view.fillPercent, 0);
  assert.match(view.title, /anthropic_usage_token/);
});

test("usageGaugeView: an unavailable reading shows no number and explains why", () => {
  const view = usageGaugeView({
    status: "unavailable",
    fiveHourPercent: null,
    resetsAtMs: null,
    fetchedAtMs: NOW,
    reason: "Anthropic rejected anthropic_usage_token (HTTP 401) — it may have expired",
  }, NOW);
  assert.equal(view.tone, "unknown");
  assert.equal(view.percentText, "—");
  assert.equal(view.resetText, "—");
  assert.match(view.title, /unavailable: Anthropic rejected anthropic_usage_token \(HTTP 401\)/);
});

test("usageGaugeView: a live reading shows percent used and time until reset", () => {
  const view = usageGaugeView(okReading(37), NOW);
  assert.equal(view.tone, "ok");
  assert.equal(view.percentText, "37%");
  assert.equal(view.fillPercent, 37);
  assert.equal(view.resetText, "2h 14m");
  assert.match(view.title, /37% of the 5-hour window used, resets /);
});

test("usageGaugeView: the reset countdown is computed against the current time", () => {
  const reading = okReading(10, { resetsAtMs: NOW + 45 * MINUTE });
  assert.equal(usageGaugeView(reading, NOW).resetText, "45m 0s");
  assert.equal(usageGaugeView(reading, NOW + 2 * MINUTE).resetText, "43m 0s");
});

test("usageGaugeView: tone turns amber at 70% and red at 90%", () => {
  const toneAt = (percent: number) => usageGaugeView(okReading(percent), NOW).tone;
  assert.equal(toneAt(0), "ok");
  assert.equal(toneAt(69.9), "ok");
  assert.equal(toneAt(70), "warn");
  assert.equal(toneAt(89.9), "warn");
  assert.equal(toneAt(90), "critical");
  assert.equal(toneAt(100), "critical");
});

test("usageGaugeView: the meter never over- or under-fills", () => {
  assert.equal(usageGaugeView(okReading(130), NOW).fillPercent, 100);
  assert.equal(usageGaugeView(okReading(130), NOW).percentText, "100%");
  assert.equal(usageGaugeView(okReading(-5), NOW).fillPercent, 0);
});

test("usageGaugeView: no open window shows the percent with no reset countdown", () => {
  const view = usageGaugeView(okReading(0, { resetsAtMs: null }), NOW);
  assert.equal(view.tone, "ok");
  assert.equal(view.percentText, "0%");
  assert.equal(view.resetText, "—");
  assert.match(view.title, /no window open yet/);
});

test("usageGaugeView: a stale reading is not shown as if it were live", () => {
  const view = usageGaugeView(okReading(37, { fetchedAtMs: NOW - USAGE_STALE_AFTER_MS - 1 }), NOW);
  assert.equal(view.tone, "unknown");
  assert.equal(view.percentText, "—");
  assert.match(view.title, /last reading is .* old/);

  const fresh = usageGaugeView(okReading(37, { fetchedAtMs: NOW - USAGE_STALE_AFTER_MS }), NOW);
  assert.equal(fresh.percentText, "37%");
});

test("usageGaugeView: once the reset time passes, the old percentage is no longer shown", () => {
  const view = usageGaugeView(okReading(95, { resetsAtMs: NOW - 1 }), NOW);
  assert.equal(view.tone, "unknown");
  assert.equal(view.percentText, "—");
  assert.equal(view.resetText, "—");
  assert.match(view.title, /window has reset/);
});

test("usageGaugeView: a Claude usage-limit hold reads LIMIT and counts down to the CLI's reset, whatever the reading", () => {
  const limitUntilMs = NOW + 1 * HOUR + 41 * MINUTE;
  const unavailable: AccountUsage = {
    status: "unavailable",
    fiveHourPercent: null,
    resetsAtMs: null,
    fetchedAtMs: NOW,
    reason: "could not reach the Anthropic usage endpoint",
  };
  for (const usage of [
    null,
    unavailable,
    { ...unavailable, status: "unconfigured" as const, reason: "no Claude login" },
    okReading(37, { fetchedAtMs: NOW - USAGE_STALE_AFTER_MS - 1 }),
    // A weekly limit can run out with the 5-hour window far from full.
    okReading(41),
  ]) {
    const view = usageGaugeView(usage, NOW, limitUntilMs);
    assert.equal(view.tone, "critical", JSON.stringify(usage));
    assert.equal(view.percentText, "LIMIT");
    assert.equal(view.fillPercent, 100);
    assert.equal(view.resetText, "1h 41m");
    assert.match(view.title, /^Claude usage limit reached — work resumes /);
  }

  assert.match(usageGaugeView(okReading(41), NOW, limitUntilMs).title, /Anthropic last reported 41% of the 5-hour window used/);
  assert.match(usageGaugeView(unavailable, NOW, limitUntilMs).title, /usage reading: could not reach the Anthropic usage endpoint/);
});

test("usageGaugeView: once the usage-limit hold has lifted, the gauge goes back to the reading", () => {
  const view = usageGaugeView(okReading(12), NOW, NOW - 1);
  assert.equal(view.tone, "ok");
  assert.equal(view.percentText, "12%");
  assert.equal(usageGaugeView(okReading(12), NOW, null).percentText, "12%");
});

test("usageLimitUntilMs: only the Claude usage-limit hold reaches the usage gauge", () => {
  assert.equal(usageLimitUntilMs(null), null);
  assert.equal(usageLimitUntilMs({ kind: "claude-usage-limit", reason: "Claude usage limit", untilMs: NOW + HOUR }), NOW + HOUR);
  assert.equal(usageLimitUntilMs({ kind: "github-rate-limit", reason: "GitHub rate limit", untilMs: NOW + HOUR }), null);
});

// ── <yoke-header> rendering ──────────────────────────────────────────────────

test("yoke-header always renders the usage gauge, dark until the first reading", () => {
  const markup = renderHeader();
  assert.match(markup, /class="usage-gauge tone-unknown"/);
  assert.match(markup, /title="Claude usage: waiting for the first reading"/);
  assert.match(markup, /<div class="usage-gauge-label">CLAUDE 5H<\/div>/);
  assert.match(markup, /<div class="usage-gauge-label">RESETS IN<\/div>/);
  assert.match(markup, /<div class="usage-gauge-value">—<\/div>/);
  assert.match(markup, /--usage-fill:0%/);
});

test("yoke-header shows the gauge OFF when no usage token is configured", () => {
  const markup = renderHeader({
    usage: {
      status: "unconfigured",
      fiveHourPercent: null,
      resetsAtMs: null,
      fetchedAtMs: Date.now(),
      reason: "set anthropic_usage_token in env.yaml to show live Claude usage",
    },
  });
  assert.match(markup, /class="usage-gauge tone-unknown"/);
  assert.match(markup, /<div class="usage-gauge-value">OFF<\/div>/);
  assert.match(markup, /title="Claude usage is off: set anthropic_usage_token in env\.yaml/);
});

test("yoke-header shows a live reading's percent, meter and reset countdown", () => {
  const now = Date.now();
  const markup = renderHeader({
    usage: {
      status: "ok",
      fiveHourPercent: 92,
      resetsAtMs: now + 2 * HOUR + 14 * MINUTE + 30_000,
      fetchedAtMs: now,
      reason: "",
    },
  });
  assert.match(markup, /class="usage-gauge tone-critical"/);
  assert.match(markup, /<div class="usage-gauge-value">92%<\/div>/);
  assert.match(markup, /--usage-fill:92%/);
  assert.match(markup, /<div class="usage-gauge-value">2h 14m<\/div>/);
});

test("yoke-header shows LIMIT and the reset countdown while a Claude usage-limit hold parks the pool", () => {
  const now = Date.now();
  const untilMs = now + 1 * HOUR + 41 * MINUTE + 30_000;
  const markup = renderHeader({
    holdUntilMs: untilMs,
    usageLimitUntilMs: untilMs,
    usage: {
      status: "unavailable",
      fiveHourPercent: null,
      resetsAtMs: null,
      fetchedAtMs: now,
      reason: "could not reach the Anthropic usage endpoint",
    },
  });
  assert.match(markup, /<div class="countdown-label">WAITING<\/div>/);
  assert.match(markup, /class="usage-gauge tone-critical"/);
  assert.match(markup, /<div class="usage-gauge-value">LIMIT<\/div>/);
  assert.match(markup, /--usage-fill:100%/);
  assert.match(markup, /<div class="usage-gauge-value">1h 41m<\/div>/);
  assert.match(markup, /title="Claude usage limit reached — work resumes /);
});

test("yoke-header puts the gauge in the upper-right cluster, before the keep-awake lamp", () => {
  const now = Date.now();
  const markup = renderHeader({
    iteration: 12,
    nextCycleAtMs: now + 5 * MINUTE,
    usage: okReading(37, { fetchedAtMs: now, resetsAtMs: now + HOUR }),
  });
  const cycle = markup.indexOf('class="iteration-info"');
  const countdown = markup.indexOf('class="countdown state-waiting"');
  const gauge = markup.indexOf('class="usage-gauge tone-ok"');
  const lamp = markup.indexOf("<keep-awake-light></keep-awake-light>");
  assert.ok(cycle >= 0 && countdown >= 0 && gauge >= 0 && lamp >= 0, markup);
  assert.ok(cycle < countdown && countdown < gauge && gauge < lamp, "CYCLE · NEXT · usage · lamp");
});
