import test from "node:test";
import assert from "node:assert/strict";

import {
  formatClockTime,
  formatLogTime,
  formatTimeOfDay,
  localizeClockTimes,
} from "../src/dashboard/shared/format.js";
import type { BroadcastEventData, EventLine } from "../src/dashboard/store/types.js";
import { HoldBanner } from "../src/dashboard/components/hold-banner.js";
import { EventStream } from "../src/dashboard/components/event-stream.js";
import { BroadcastEventCard } from "../src/dashboard/components/broadcast-event-card.js";

// Every wall-clock time the dashboard shows is rendered in the browser, in the
// viewer's own time zone (issue #272). Node renders local times in
// process.env.TZ, so setting it stands in for a browser in that zone.

/** 6:45 PM in New York, 3:45 PM in Los Angeles, 7:45 AM the next day in Tokyo. */
const AT = Date.parse("2026-10-18T22:45:00Z");
const HOUR = 60 * 60_000;
const NEW_YORK = "America/New_York";
const LOS_ANGELES = "America/Los_Angeles";
const TOKYO = "Asia/Tokyo";

/** Run `fn` as a browser whose time zone is `timeZone`. */
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

/** The exact strings below are en-US renderings; other locales only get the zone-relative checks. */
const EN_US = new Intl.DateTimeFormat().resolvedOptions().locale === "en-US";
const needsEnUs = { skip: EN_US ? false : "the default locale is not en-US" };
/** Newer ICU puts a narrow no-break space before AM/PM. */
const spaced = (text: string): string => text.replace(/\s/g, " ");

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

// ── formatters ───────────────────────────────────────────────────────────────

test("formatClockTime renders an instant in the viewer's time zone", () => {
  for (const zone of [NEW_YORK, LOS_ANGELES, TOKYO]) {
    assert.equal(asViewerIn(zone, () => formatClockTime(AT)), formatClockTime(AT, zone), zone);
  }
  assert.notEqual(asViewerIn(TOKYO, () => formatClockTime(AT)), asViewerIn(NEW_YORK, () => formatClockTime(AT)));
});

test("formatClockTime keeps the Mon D, h:mm AM/PM shape", needsEnUs, () => {
  assert.equal(spaced(formatClockTime(AT, NEW_YORK)), "Oct 18, 6:45 PM");
  assert.equal(spaced(formatClockTime(AT, LOS_ANGELES)), "Oct 18, 3:45 PM");
  assert.equal(spaced(formatClockTime(AT, TOKYO)), "Oct 19, 7:45 AM", "the date follows the zone too");
});

test("formatLogTime is a fixed-width 24-hour stamp in the viewer's time zone", () => {
  assert.equal(asViewerIn(NEW_YORK, () => formatLogTime(AT + 7_000)), "18:45:07");
  assert.equal(asViewerIn(TOKYO, () => formatLogTime(AT + 7_000)), "07:45:07");
  // Five past midnight is "00:05", never "24:05".
  assert.equal(formatLogTime(Date.parse("2026-10-19T04:05:00Z"), NEW_YORK), "00:05:00");
});

test("formatTimeOfDay renders a broadcast stamp in the viewer's time zone", () => {
  assert.equal(asViewerIn(TOKYO, () => formatTimeOfDay(AT)), formatTimeOfDay(AT, TOKYO));
  assert.notEqual(formatTimeOfDay(AT, TOKYO), formatTimeOfDay(AT, NEW_YORK));
});

test("formatTimeOfDay keeps the locale's own time shape", needsEnUs, () => {
  assert.equal(spaced(formatTimeOfDay(AT + 7_000, NEW_YORK)), "6:45:07 PM");
});

// ── localizeClockTimes ───────────────────────────────────────────────────────

test("localizeClockTimes re-renders the server's times in the viewer's zone", () => {
  // The server, in New York, rendered the deadline into its log line.
  const served = formatClockTime(AT, NEW_YORK);
  const line = `⏸ waiting 2h until ${served} for Claude usage limit`;
  assert.equal(
    localizeClockTimes(line, [{ text: served, atMs: AT }], TOKYO),
    `⏸ waiting 2h until ${formatClockTime(AT, TOKYO)} for Claude usage limit`,
  );
  assert.equal(
    asViewerIn(LOS_ANGELES, () => localizeClockTimes(line, [{ text: served, atMs: AT }])),
    `⏸ waiting 2h until ${formatClockTime(AT, LOS_ANGELES)} for Claude usage limit`,
  );
});

test("localizeClockTimes leaves text that names no time alone", () => {
  assert.equal(localizeClockTimes("Snapshot: 3 issues", [], TOKYO), "Snapshot: 3 issues");
  assert.equal(
    localizeClockTimes("Snapshot: 3 issues", [{ text: formatClockTime(AT, NEW_YORK), atMs: AT }], TOKYO),
    "Snapshot: 3 issues",
  );
  assert.equal(localizeClockTimes("Snapshot: 3 issues", [{ text: "", atMs: AT }], TOKYO), "Snapshot: 3 issues");
});

test("localizeClockTimes re-renders every time a line names, each from its own instant", () => {
  const held = AT - HOUR;
  const line = `still showing 41% from ${formatClockTime(held, NEW_YORK)} · resets ${formatClockTime(AT, NEW_YORK)}`;
  assert.equal(
    localizeClockTimes(line, [{ text: formatClockTime(AT, NEW_YORK), atMs: AT }, { text: formatClockTime(held, NEW_YORK), atMs: held }], TOKYO),
    `still showing 41% from ${formatClockTime(held, TOKYO)} · resets ${formatClockTime(AT, TOKYO)}`,
  );
});

test("localizeClockTimes never mistakes a time it re-rendered for another one the server rendered", () => {
  // In Los Angeles, the server's 6:45 PM reads 3:45 PM — which is exactly how
  // the server, in New York, renders an instant three hours earlier.
  const earlier = AT - 3 * HOUR;
  assert.equal(formatClockTime(AT, LOS_ANGELES), formatClockTime(earlier, NEW_YORK));
  const line = `until ${formatClockTime(AT, NEW_YORK)}`;
  const refs = [{ text: formatClockTime(AT, NEW_YORK), atMs: AT }, { text: formatClockTime(earlier, NEW_YORK), atMs: earlier }];
  assert.equal(localizeClockTimes(line, refs, LOS_ANGELES), `until ${formatClockTime(AT, LOS_ANGELES)}`);
});

// ── components ───────────────────────────────────────────────────────────────

test("hold banner: the deadline reads in the viewer's time zone", () => {
  const untilMs = Date.now() + 2 * HOUR;
  const banner = new HoldBanner();
  banner.hold = { kind: "claude-usage-limit", reason: "Claude usage limit", untilMs };
  for (const zone of [NEW_YORK, TOKYO]) {
    const markup = asViewerIn(zone, () => flatten(banner.render()));
    assert.match(markup, new RegExp(`UNTIL <span class="hold-banner-deadline">${formatClockTime(untilMs, zone)}</span>`), zone);
  }
});

test("event stream: each line is stamped with its event's time in the viewer's time zone", () => {
  const line: EventLine = { text: "▶ [1/3] implement #272", cylinderIdx: 0, level: "info", atMs: AT + 7_000, color: null };
  const stream = new EventStream();
  stream.events = [line];
  assert.match(asViewerIn(NEW_YORK, () => flatten(stream.render())), /<span class="event-time">18:45:07<\/span>/);
  assert.match(asViewerIn(TOKYO, () => flatten(stream.render())), /<span class="event-time">07:45:07<\/span>/);
});

test("broadcast card: the stamp is its event's time in the viewer's time zone", () => {
  const event: BroadcastEventData = {
    id: "1",
    category: "commit",
    label: "COMMIT",
    stateBefore: "Branch was at previous commit",
    changeHow: "dev pushed abc1234",
    stateAfter: "Branch advanced",
    excellence: "",
    atMs: AT,
    color: "#8a8f98",
  };
  const card = new BroadcastEventCard();
  card.event = event;
  for (const zone of [NEW_YORK, TOKYO]) {
    const markup = asViewerIn(zone, () => flatten(card.render()));
    assert.ok(markup.includes(`<span class="broadcast-event-time">${formatTimeOfDay(AT, zone)}</span>`), zone);
  }
});
