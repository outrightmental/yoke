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
import { engineView } from "../src/dashboard/shared/engine-view.js";
import { fieldModel } from "../src/dashboard/field/model.js";
import { layoutField } from "../src/dashboard/field/layout.js";
import { workViews } from "../src/dashboard/shared/work-view.js";
import { renderInbox, stateWith } from "./dashboard-helpers.js";

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

/** The color the field draws an engine's ring in. */
function rowColor(cyl: CylinderState): string {
  return engineView(cyl, Date.now()).color.hex;
}

/** The dashboard's state with `p` as its one piece of work, in the state that gives it `activity`. */
function stateFor(p: LifecyclePair, activity: PillActivity | null, dark = false) {
  const state = stateWith([p], p.repo ?? "");
  return {
    ...state,
    // An engine on it is what makes a piece of work `working`.
    cylinders: activity === "working"
      ? [cylinder({ issueNumber: p.issue?.number ?? null, prNumber: p.pr?.number ?? null })]
      : [],
    shutdownRequested: dark,
    // A dark pill keeps the activity it had when it went dark (#268).
    frozenPillActivity: dark ? new Map([[`${p.repo ?? ""}${p.issue ? `#${p.issue.number}` : `pr-${p.pr?.number}`}`, activity]]) : null,
  };
}

/** The color the field draws a piece of work in. */
function pillColor(p: LifecyclePair, activity: PillActivity | null, dark = false): string {
  const [work] = workViews(stateFor(p, activity, dark), Date.now());
  assert.ok(work, "the work is on the field");
  assert.equal(work.activity, activity, "in the state the test means");
  return work.color.hex;
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

test("the field draws an engine at each status's level", () => {
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

test("the field draws a piece of work at its level", () => {
  assert.equal(pillColor(pair(), "working"), issueColor(7).hex);
  assert.equal(pillColor(pair(), "review"), burnColor(issueColor(7), "waiting").hex);
  assert.equal(pillColor(pair(), "working", true), burnColor(issueColor(7), "cold").hex);
  const orphan = pair({ issue: null, pr: { number: 300, title: "Orphan", state: "open", checksStatus: "pending" }, prPhase: "active" });
  assert.equal(pillColor(orphan, "waiting-ci"), burnColor(issueColor(300), "queued").hex);
});

test("a manual PR is drawn at the cold level, hue and all, never grayed below it", () => {
  const manual = pillColor(pair({ disabled: true }), "manual");
  assert.equal(manual, burnColor(issueColor(7), "cold").hex);
  assert.notEqual(manual, NEUTRAL_COLOR, "cold work keeps a trace of its hue");
});

test("a piece of work is laid out in the stratum of its level, and an engine's work beside its ring", () => {
  const stratumOf = (p: LifecyclePair, activity: PillActivity | null, dark = false) => {
    const model = fieldModel(stateFor(p, activity, dark), Date.now());
    const layout = layoutField(model, { width: 1400, height: 900, railWidth: 0, lampWidth: 0 });
    const node = layout.nodes.find((candidate) => candidate.kind === "work");
    assert.ok(node && node.kind === "work");
    return `${node.mode}:${node.level}`;
  };
  assert.equal(stratumOf(pair(), "working"), "reactor:burning", "an engine is on it");
  assert.equal(stratumOf(pair({ prPhase: "active", pr: { number: 10, title: "X", state: "open", checksStatus: "pending" } }), "waiting-ci"), "row:queued");
  assert.equal(stratumOf(pair(), "review"), "row:waiting");
  assert.equal(stratumOf(pair({ disabled: true }), "manual"), "row:cold");
  assert.equal(stratumOf(pair(), "review", true), "row:cold", "shut down: everything goes cold");
});

test("an inbox card is accented in its work's color at its level, the same color the field draws it in", () => {
  const parked = pair({ approval: "awaiting-approval" });
  const { cards, html } = renderInbox(stateFor(parked, "review"));
  const leveled = burnColor(issueColor(7), "waiting");
  assert.equal(cards[0]?.color?.hex, leveled.hex);
  assert.ok(html.includes(`--card-color:${leveled.hex};--card-rgb:${leveled.rgb}`));
});

// ── one scale for every component ────────────────────────────────────────────

test("the same level is the same color for an engine and for a piece of work", () => {
  assert.equal(rowColor(cylinder()), pillColor(pair(), "working"), "an engine and the work it is on burn alike");
  assert.equal(
    rowColor(cylinder({ status: "done" })),
    pillColor(pair({ disabled: true }), "manual"),
    "a finished action and a manual PR are both cold",
  );
  assert.equal(rowColor(cylinder({ status: "shutdown" })), pillColor(pair(), "review", true), "shut down is cold in both");
});
