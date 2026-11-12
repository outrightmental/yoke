import test from "node:test";
import assert from "node:assert/strict";

import {
  USAGE_STALE_AFTER_MS,
  usageGaugeView,
  usageLimitUntilMs,
} from "../src/dashboard/shared/usage-gauge.js";
import type { AccountUsage, DashboardState } from "../src/dashboard/store/types.js";
import { inspect } from "../src/dashboard/shared/inbox.js";
import { initialState } from "../src/dashboard/store/dashboard-store.js";
import { formatClockTime } from "../src/dashboard/shared/format.js";
import { paintField, tokensPalette, triplet } from "./dashboard-helpers.js";

const NOW = Date.parse("2026-10-12T14:30:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function okReading(usedPercent: number, overrides: Partial<AccountUsage> = {}): AccountUsage {
  return {
    status: "ok",
    window: "five_hour",
    usedPercent,
    resetsAtMs: NOW + 2 * HOUR + 14 * MINUTE + 30_000,
    fetchedAtMs: NOW - 20_000,
    reason: "",
    ...overrides,
  };
}

/** A failed read that still carries the numbers of the last good one. */
function heldReading(usedPercent: number, overrides: Partial<AccountUsage> = {}): AccountUsage {
  return okReading(usedPercent, {
    status: "unavailable",
    reason: "Anthropic is overloaded (HTTP 529)",
    heldFromMs: NOW - 80_000,
    ...overrides,
  });
}

const PALETTE = tokensPalette();
const TAU = Math.PI * 2;

/** The dashboard's state for the field's instruments, with `props` over a quiet, connected run. */
function hudState(props: Partial<DashboardState> = {}): DashboardState {
  return { ...initialState(), connection: "connected", owner: "o", repo: "r", ...props };
}

/** The field for `props`, painted as it stands at `nowMs`, and what tapping its usage gauge says. */
function renderHud(props: Partial<DashboardState> = {}, nowMs = Date.now()) {
  const painted = paintField(hudState(props), { nowMs });
  const said = inspect({ kind: "usage" }, {
    works: painted.model.works,
    engines: painted.model.bench,
    usageHeading: painted.model.vitals.usage.heading,
    usageTitle: painted.model.vitals.usage.title,
    hold: painted.model.vitals.hold,
  });
  /** How far round the gauge's ring is filled, as a fraction of the whole; 0 when no arc was drawn. */
  const sweeps = painted.calls
    .filter((call) => call.method === "arc" && call.args[2] === 14)
    .map((call) => (Number(call.args[4]) - Number(call.args[3])) / TAU);
  return { ...painted, heading: said?.title ?? "", said: said?.body.join(" ") ?? "", filled: sweeps.find((sweep) => sweep < 0.9999) ?? (sweeps.length > 1 ? 1 : 0) };
}

/** Run `fn` as a browser whose time zone is `timeZone`: Node renders local times in process.env.TZ. */
function asViewerIn<T>(timeZone: string, fn: () => T): T {
  const saved = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
}

// ── usageGaugeView ───────────────────────────────────────────────────────────

test("usageGaugeView: before the first reading the gauge is dark, not blank", () => {
  assert.deepEqual(usageGaugeView(null, NOW), {
    tone: "unknown",
    label: "CLAUDE",
    heading: "The usage window",
    percentText: "—",
    fillPercent: 0,
    resetText: "—",
    title: "Claude usage: waiting for the first reading",
  });
});

test("usageGaugeView: without a configured token the gauge reads OFF and says how to turn it on", () => {
  const view = usageGaugeView({
    status: "unconfigured",
    window: null,
    usedPercent: null,
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
    window: null,
    usedPercent: null,
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
  assert.equal(view.label, "CLAUDE 5H");
  assert.equal(view.heading, "The 5-hour usage window");
});

test("usageGaugeView: a reading of the weekly window says so, in its caption and its words", () => {
  const view = usageGaugeView(okReading(7, { window: "seven_day", resetsAtMs: NOW + 47 * HOUR + 30 * MINUTE }), NOW);
  assert.equal(view.label, "CLAUDE 7D");
  assert.equal(view.heading, "The weekly usage window");
  assert.equal(view.percentText, "7%");
  assert.equal(view.resetText, "47h 30m");
  assert.match(view.title, /^Claude usage: 7% of the weekly window used, resets /);

  const held = usageGaugeView(heldReading(7, { window: "seven_day" }), NOW);
  assert.equal(held.label, "CLAUDE 7D");
  assert.match(held.title, /^Claude usage: 7% of the weekly window used as of /);
  assert.match(usageGaugeView(okReading(7, { window: "seven_day", resetsAtMs: NOW - 1 }), NOW).title, /the weekly window has reset/);
  assert.match(usageGaugeView(heldReading(7, { window: "seven_day" }), NOW, NOW + HOUR).title, /Anthropic last reported 7% of the weekly window used at /);
});

test("usageGaugeView: a gauge that shows no window's share names none", () => {
  const limitUntilMs = NOW + HOUR;
  for (const view of [
    usageGaugeView(okReading(7, { window: "seven_day", fetchedAtMs: NOW - USAGE_STALE_AFTER_MS - 1 }), NOW),
    usageGaugeView(okReading(7, { window: "seven_day", resetsAtMs: NOW - 1 }), NOW),
    usageGaugeView(okReading(7, { window: "seven_day" }), NOW, limitUntilMs),
  ]) {
    assert.equal(view.label, "CLAUDE", view.title);
    assert.equal(view.heading, "The usage window");
  }
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

test("usageGaugeView: a failed read that holds the last good numbers keeps showing them (#261)", () => {
  const live = usageGaugeView(okReading(15), NOW);
  const held = usageGaugeView(heldReading(15), NOW);
  assert.equal(held.tone, live.tone);
  assert.equal(held.percentText, "15%");
  assert.equal(held.fillPercent, 15);
  assert.equal(held.resetText, live.resetText);
  assert.match(
    held.title,
    /^Claude usage: 15% of the 5-hour window used as of .+, resets .+ · the latest reading failed: Anthropic is overloaded \(HTTP 529\)$/,
  );
  assert.equal(usageGaugeView(heldReading(92), NOW).tone, "critical");
});

test("usageGaugeView: every time in the tooltip reads in the viewer's time zone (#272)", () => {
  const reading = okReading(37);
  const held = heldReading(15);
  const limitUntilMs = NOW + 1 * HOUR + 41 * MINUTE;
  for (const zone of ["America/New_York", "Asia/Tokyo"]) {
    const at = (ms: number) => formatClockTime(ms, zone);
    asViewerIn(zone, () => {
      assert.equal(usageGaugeView(reading, NOW).title, `Claude usage: 37% of the 5-hour window used, resets ${at(reading.resetsAtMs!)}`, zone);
      assert.equal(
        usageGaugeView(held, NOW).title,
        `Claude usage: 15% of the 5-hour window used as of ${at(held.heldFromMs!)}, resets ${at(held.resetsAtMs!)}` +
          " · the latest reading failed: Anthropic is overloaded (HTTP 529)",
        zone,
      );
      assert.equal(
        usageGaugeView(held, NOW, limitUntilMs).title,
        `Claude usage limit reached — work resumes ${at(limitUntilMs)}` +
          ` · Anthropic last reported 15% of the 5-hour window used at ${at(held.heldFromMs!)}`,
        zone,
      );
    });
  }
});

test("usageGaugeView: held numbers still go dark once readings stop arriving or the window resets", () => {
  const stopped = usageGaugeView(heldReading(15, { fetchedAtMs: NOW - USAGE_STALE_AFTER_MS - 1 }), NOW);
  assert.equal(stopped.tone, "unknown");
  assert.equal(stopped.percentText, "—");
  assert.match(stopped.title, /last reading is .* old/);

  const reset = usageGaugeView(heldReading(15, { resetsAtMs: NOW - 1 }), NOW);
  assert.equal(reset.tone, "unknown");
  assert.equal(reset.percentText, "—");
  assert.match(reset.title, /window has reset/);
});

test("usageGaugeView: an unavailable reading shows no number unless it says what it holds over", () => {
  const view = usageGaugeView(okReading(15, { status: "unavailable", reason: "could not reach the Anthropic usage endpoint" }), NOW);
  assert.equal(view.tone, "unknown");
  assert.equal(view.percentText, "—");
});

test("usageGaugeView: a Claude usage-limit hold reads LIMIT and counts down to the CLI's reset, whatever the reading", () => {
  const limitUntilMs = NOW + 1 * HOUR + 41 * MINUTE;
  const unavailable: AccountUsage = {
    status: "unavailable",
    window: null,
    usedPercent: null,
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
  assert.match(usageGaugeView(heldReading(41), NOW, limitUntilMs).title, /Anthropic last reported 41% of the 5-hour window used at /);
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

// ── the field's instruments ──────────────────────────────────────────────────

test("the field always draws the usage gauge, dark until the first reading", () => {
  const hud = renderHud();
  assert.ok(hud.texts.includes("CLAUDE"));
  assert.ok(hud.texts.includes("RESETS IN"));
  assert.equal(hud.texts.filter((text) => text === "—").length, 2, "no percent and no countdown, said so");
  assert.ok((hud.inkOf("—")?.alpha ?? 1) < 0.5, "dark, like an instrument with no power");
  assert.equal(hud.filled, 0, "an empty ring");
  assert.equal(hud.said, "Claude usage: waiting for the first reading", "and a tap on it says why");
});

test("the field shows the gauge OFF when no usage token is configured", () => {
  const hud = renderHud({
    usage: {
      status: "unconfigured",
      window: null,
      usedPercent: null,
      resetsAtMs: null,
      fetchedAtMs: Date.now(),
      reason: "set anthropic_usage_token in env.yaml to show live Claude usage",
    },
  });
  assert.ok(hud.texts.includes("OFF"));
  assert.ok((hud.inkOf("OFF")?.alpha ?? 1) < 0.5);
  assert.match(hud.said, /^Claude usage is off: set anthropic_usage_token in env\.yaml/);
});

test("the field shows a live reading's percent, ring and reset countdown", () => {
  const now = Date.now();
  const hud = renderHud({
    usage: {
      status: "ok",
      window: "five_hour",
      usedPercent: 92,
      resetsAtMs: now + 2 * HOUR + 14 * MINUTE + 30_000,
      fetchedAtMs: now,
      reason: "",
    },
  });
  assert.deepEqual(hud.inkOf("92%"), { rgb: triplet(PALETTE.red), alpha: 1 }, "red past 90%");
  assert.ok(Math.abs(hud.filled - 0.92) < 0.001, "the ring is filled as far as the window is used");
  assert.ok(hud.texts.includes("2h 14m"));
  assert.ok(hud.texts.includes("CLAUDE 5H"));
  assert.equal(hud.heading, "The 5-hour usage window");
});

test("the field captions a weekly reading CLAUDE 7D, and a tap on it says it is the weekly window", () => {
  const now = Date.now();
  const hud = renderHud({ usage: okReading(7, { window: "seven_day", fetchedAtMs: now, resetsAtMs: now + 47 * HOUR + 30 * MINUTE }) });
  assert.ok(hud.texts.includes("CLAUDE 7D"));
  assert.ok(hud.texts.includes("7%"));
  assert.ok(hud.texts.includes("47h 30m"));
  assert.ok(Math.abs(hud.filled - 0.07) < 0.001);
  assert.equal(hud.heading, "The weekly usage window");
  assert.match(hud.said, /^Claude usage: 7% of the weekly window used, resets /);
});

test("the field's gauge turns amber at 70% and is plain trim below it", () => {
  const now = Date.now();
  const reading = (percent: number) => renderHud({ usage: okReading(percent, { fetchedAtMs: now, resetsAtMs: now + HOUR }) });
  assert.equal(reading(37).inkOf("37%")?.rgb, triplet(PALETTE.trimBright), "room to spare is not a signal");
  assert.equal(reading(71).inkOf("71%")?.rgb, triplet(PALETTE.yellow));
});

test("the field keeps showing the last good reading when the latest read failed (#261)", () => {
  const now = Date.now();
  const hud = renderHud({
    usage: {
      status: "unavailable",
      window: "five_hour",
      usedPercent: 15,
      resetsAtMs: now + 2 * HOUR + 14 * MINUTE + 30_000,
      fetchedAtMs: now,
      reason: "Anthropic is overloaded (HTTP 529)",
      heldFromMs: now - MINUTE,
    },
  });
  assert.deepEqual(hud.inkOf("15%"), { rgb: triplet(PALETTE.trimBright), alpha: 1 });
  assert.ok(Math.abs(hud.filled - 0.15) < 0.001);
  assert.ok(hud.texts.includes("2h 14m"));
  assert.match(hud.said, /^Claude usage: 15% of the 5-hour window used as of .* · the latest reading failed: Anthropic is overloaded \(HTTP 529\)$/);
});

test("the field shows LIMIT and the reset countdown while a Claude usage-limit hold parks the pool", () => {
  const now = Date.now();
  const untilMs = now + 1 * HOUR + 41 * MINUTE + 30_000;
  const hud = renderHud({
    hold: { kind: "claude-usage-limit", reason: "Claude usage limit", untilMs },
    usage: {
      status: "unavailable",
      window: null,
      usedPercent: null,
      resetsAtMs: null,
      fetchedAtMs: now,
      reason: "could not reach the Anthropic usage endpoint",
    },
  });
  assert.equal(hud.model.vitals.countdown?.label, "WAITING");
  // "WAITING" is drawn twice — on the hold itself, in orange, and above the countdown, in yellow.
  const waiting = hud.fills.filter((fill) => fill.text === "WAITING").map((fill) => fill.fill);
  assert.ok(waiting.some((fill) => fill.includes(triplet(PALETTE.yellow))), "a hold colors the countdown; the time to the next cycle is trim (#280)");
  assert.deepEqual(hud.inkOf("LIMIT"), { rgb: triplet(PALETTE.red), alpha: 1 });
  assert.equal(hud.filled, 1, "the ring is full");
  assert.equal(hud.texts.filter((text) => text === "1h 41m").length, 2, "the countdown, and the gauge's time to reset");
  assert.match(hud.said, /^Claude usage limit reached — work resumes /);
});

test("the time to the next cycle is plain trim: only a hold colors the countdown (#280)", () => {
  const now = Date.now();
  const hud = renderHud({
    cylinders: initialState().cylinders.map((cyl, i) => (i === 0 ? { ...cyl, iterationNumber: 12, nextCycleAtMs: now + 5 * MINUTE } : cyl)),
  }, now);
  assert.equal(hud.inkOf("NEXT")?.rgb, triplet(PALETTE.trimDim));
  assert.equal(hud.inkOf("5m 0s")?.rgb, triplet(PALETTE.trimBright));
});

test("the field sets the gauge at its upper right, before the keep-awake lamp: CYCLE · NEXT · usage · lamp", () => {
  const now = Date.now();
  const hud = renderHud({
    cylinders: initialState().cylinders.map((cyl, i) => (i === 0 ? { ...cyl, iterationNumber: 12, nextCycleAtMs: now + 5 * MINUTE } : cyl)),
    usage: okReading(37, { fetchedAtMs: now, resetsAtMs: now + HOUR }),
  });
  const { slots } = hud.layout.hud;
  assert.deepEqual(slots.map((slot) => slot.kind), ["cycle", "countdown", "usage"]);
  for (let i = 1; i < slots.length; i++) {
    assert.ok(slots[i]!.rect.x >= slots[i - 1]!.rect.x + slots[i - 1]!.rect.w, "left to right, none over another");
  }
  const usage = slots[slots.length - 1]!.rect;
  const fieldRight = hud.layout.field.x + hud.layout.field.w;
  assert.equal(usage.x + usage.w, fieldRight - hud.layout.viewport.lampWidth, "the lamp has the corner to itself");
  assert.ok(hud.texts.includes("CYCLE") && hud.texts.includes("12"));
});
