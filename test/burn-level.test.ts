import test from "node:test";
import assert from "node:assert/strict";
import {
  BURN_SATURATION,
  burnColor,
  cylinderBurnLevel,
  cylinderColor,
  pillBurnLevel,
  type BurnLevel,
} from "../src/dashboard/shared/burn-level.js";
import { atSaturation, issueColor, issueHue, NEUTRAL_COLOR, NEUTRAL_COLOR_RGB } from "../src/dashboard/shared/issue-colors.js";
import type { PillActivity } from "../src/dashboard/shared/pill-activity.js";
import type { CylinderState, LifecyclePair } from "../src/dashboard/store/types.js";
import { CylinderRow } from "../src/dashboard/components/cylinder-row.js";
import { LifecyclePill } from "../src/dashboard/components/lifecycle-pill.js";

// More saturation = more token burn (issue #281): every state lands on one
// level of a shared scale, the hue keeps saying which issue, and the same level
// is the same color whichever component draws it.

const LEVELS: BurnLevel[] = ["burning", "queued", "waiting", "cold"];

/** Hue (degrees), HSL saturation and lightness of an "r,g,b" triplet. */
function hsl(rgb: string): { h: number; s: number; l: number } {
  const [r, g, b] = rgb.split(",").map((v) => Number(v) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const c = max - min;
  const l = (max + min) / 2;
  const s = c === 0 ? 0 : c / (1 - Math.abs(2 * l - 1));
  const sector = c === 0 ? 0 : max === r ? (g - b) / c : max === g ? (b - r) / c + 2 : (r - g) / c + 4;
  return { h: (sector * 60 + 360) % 360, s, l };
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

function flatten(value: unknown): string {
  if (value === null || value === undefined || typeof value === "symbol") return "";
  if (Array.isArray(value)) return value.map(flatten).join("");
  if (typeof value === "object" && "strings" in value && "values" in value) {
    const { strings, values } = value as { strings: readonly string[]; values: readonly unknown[] };
    return strings.reduce((out, s, i) => out + s + (i < values.length ? flatten(values[i]) : ""), "");
  }
  return String(value);
}

function cylinder(overrides: Partial<CylinderState> = {}): CylinderState {
  const c = issueColor(7);
  return {
    index: 1, color: c.hex, colorRgb: c.rgb, status: "active", idleStatusText: "",
    actionType: "start-implementation", repo: "o/a", issueNumber: 7, prNumber: null,
    issueTitle: null, prTitle: null, model: null, iterationNumber: 1, thinkingLines: [],
    actionStartedAt: null, nextCycleAtMs: null, rateLimitedUntilMs: null,
    ...overrides,
  };
}

function pair(overrides: Partial<LifecyclePair> = {}): LifecyclePair {
  return {
    issue: { number: 7, title: "X", state: "open" },
    pr: { number: 10, title: "X", state: "open", draft: false, checksStatus: "success" },
    prPhase: "review",
    repo: "o/a",
    ...overrides,
  };
}

/** The color a cylinder row draws its cylinder in. */
function rowColor(cyl: CylinderState): string {
  const row = new CylinderRow();
  row.cylinder = cyl;
  const m = /--cyl-color:(#[0-9a-f]{6});/.exec(flatten(row.render()));
  assert.ok(m, "the row sets its color");
  return m[1]!;
}

/** The color a lifecycle pill draws its work in. */
function pillColor(p: LifecyclePair, activity: PillActivity | null, dark = false): string {
  const pill = new LifecyclePill();
  const c = issueColor(p.issue?.number ?? p.pr!.number);
  Object.assign(pill, { pair: p, activity, dark, color: c.hex, colorRgb: c.rgb });
  const m = /--pill-color:(#[0-9a-f]{6});/.exec(flatten(pill.render()));
  assert.ok(m, "the pill sets its color");
  return m[1]!;
}

// ── the scale ────────────────────────────────────────────────────────────────

test("the scale runs from full saturation down to a floor above trim's zero", () => {
  assert.equal(BURN_SATURATION.burning, 1, "an engine running an action is at full saturation");
  for (let i = 1; i < LEVELS.length; i++) {
    assert.ok(BURN_SATURATION[LEVELS[i]!] < BURN_SATURATION[LEVELS[i - 1]!], `${LEVELS[i]} burns less than ${LEVELS[i - 1]}`);
  }
  assert.ok(BURN_SATURATION.cold > 0, "cold work keeps its hue, so it never reads as trim");
});

test("burnColor keeps the work's hue and lightness and sets only its saturation", () => {
  for (let n = 0; n <= 2000; n++) {
    const base = issueColor(n);
    for (const level of LEVELS) {
      const c = burnColor(base, level);
      const { h, s, l } = hsl(c.rgb);
      assert.ok(hueDistance(h, issueHue(n)) <= 1.5, `#${n} at ${level} drifts to hue ${h.toFixed(1)}`);
      assert.ok(Math.abs(s - BURN_SATURATION[level]) <= 0.03, `#${n} at ${level} has saturation ${s.toFixed(2)}`);
      assert.ok(Math.abs(l - 0.6) <= 0.01, `#${n} at ${level} has lightness ${l.toFixed(2)}`);
      const [r, g, b] = c.rgb.split(",").map(Number);
      assert.ok(!(r === g && g === b), `#${n} at ${level} is ${c.hex}: no level of work is gray`);
      assert.match(c.hex, /^#[0-9a-f]{6}$/);
    }
    assert.deepEqual(burnColor(base, "burning"), base, "burning is the issue's own color, exactly");
  }
});

test("a gray has no hue to re-saturate: trim stays trim", () => {
  const trim = { hex: NEUTRAL_COLOR, rgb: NEUTRAL_COLOR_RGB };
  for (const s of [0, 0.2, 1]) assert.deepEqual(atSaturation(trim, s), trim);
});

// ── engine cylinders ─────────────────────────────────────────────────────────

test("a cylinder burns only while it runs an action", () => {
  assert.equal(cylinderBurnLevel("active"), "burning");
  for (const status of ["done", "error", "shutdown"] as const) {
    assert.equal(cylinderBurnLevel(status), "cold", `${status}: the action has ended`);
  }
});

test("a cylinder is drawn in its work's color at its level, and in trim gray with no work", () => {
  assert.deepEqual(cylinderColor(cylinder()), issueColor(7));
  for (const status of ["done", "error", "shutdown"] as const) {
    assert.deepEqual(cylinderColor(cylinder({ status })), burnColor(issueColor(7), "cold"));
  }
  const idle = cylinder({ status: "idle", color: null, colorRgb: null, issueNumber: null });
  assert.deepEqual(cylinderColor(idle), { hex: NEUTRAL_COLOR, rgb: NEUTRAL_COLOR_RGB }, "idle is trim");
  const parked = { ...idle, rateLimitedUntilMs: Date.now() + 60_000, idleStatusText: "claude-usage-limit" };
  assert.deepEqual(cylinderColor(parked), { hex: NEUTRAL_COLOR, rgb: NEUTRAL_COLOR_RGB }, "parked by a limit is trim");
});

test("the cylinder row draws each status at its level", () => {
  assert.equal(rowColor(cylinder()), issueColor(7).hex);
  assert.equal(rowColor(cylinder({ status: "done" })), burnColor(issueColor(7), "cold").hex);
  assert.equal(rowColor(cylinder({ status: "error" })), burnColor(issueColor(7), "cold").hex);
});

// ── lifecycle pills ──────────────────────────────────────────────────────────

test("a pill's activity sets its level: working burns, CI is next, review waits, manual is cold", () => {
  assert.equal(pillBurnLevel(pair(), "working", false), "burning");
  assert.equal(pillBurnLevel(pair({ prPhase: "active" }), "waiting-ci", false), "queued");
  assert.equal(pillBurnLevel(pair(), "review", false), "waiting");
  assert.equal(pillBurnLevel(pair({ disabled: true }), "manual", false), "cold");
});

test("a dark pill is cold whatever it was doing when yoke shut down", () => {
  for (const activity of ["working", "waiting-ci", "review", "manual", null] as const) {
    assert.equal(pillBurnLevel(pair(), activity, true), "cold", `dark and ${activity}`);
  }
});

test("a pill with no activity is leveled by where its work stands", () => {
  assert.equal(pillBurnLevel(pair({ approval: "approved" }), null, false), "queued", "approved: the merge is next");
  assert.equal(pillBurnLevel(pair({ prPhase: "active" }), null, false), "queued", "an open PR waiting its turn");
  assert.equal(pillBurnLevel(pair({ pr: null, prPhase: "planning" }), null, false), "queued");
  assert.equal(pillBurnLevel(pair({ pr: null, prPhase: "absent" }), null, false), "queued", "a ready issue waiting its turn");
  assert.equal(pillBurnLevel(pair({ pr: null, prPhase: "absent", blockedByIssueNumbers: [3] }), null, false), "waiting");
  assert.equal(pillBurnLevel(pair({ prPhase: "completed" }), null, false), "cold", "merged");
  assert.equal(pillBurnLevel(pair({ pr: null, prPhase: "inactive", projectStatus: "Backlog" }), null, false), "cold");
});

test("the pill draws its work at its level", () => {
  assert.equal(pillColor(pair(), "working"), issueColor(7).hex);
  assert.equal(pillColor(pair(), "review"), burnColor(issueColor(7), "waiting").hex);
  assert.equal(pillColor(pair(), "working", true), burnColor(issueColor(7), "cold").hex);
  const orphan = pair({ issue: null, pr: { number: 300, title: "Orphan", state: "open" }, prPhase: "active" });
  assert.equal(pillColor(orphan, "waiting-ci"), burnColor(issueColor(300), "queued").hex);
});

test("a manual PR half is not grayed below the pill's cold level", () => {
  const css = LifecyclePill.styles.toString();
  const rule = /\.pill-pr-half\.disabled\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(rule, "the manual PR half has a rule");
  assert.doesNotMatch(rule, /grayscale/);
});

// ── one scale for every component ────────────────────────────────────────────

test("the same level is the same color in the engine pane and the lifecycle pane", () => {
  assert.equal(rowColor(cylinder()), pillColor(pair(), "working"), "an engine and the pill it works burn alike");
  assert.equal(
    rowColor(cylinder({ status: "done" })),
    pillColor(pair({ disabled: true }), "manual"),
    "a finished action and a manual PR are both cold",
  );
  assert.equal(rowColor(cylinder({ status: "shutdown" })), pillColor(pair(), "review", true), "shut down is cold in both");
});
