import test from "node:test";
import assert from "node:assert/strict";
import { burnColor, cylinderColor, pillBurnLevel, type BurnLevel } from "../src/dashboard/shared/burn-level.js";
import { issueColor, NEUTRAL_COLOR, NEUTRAL_COLOR_RGB } from "../src/dashboard/shared/issue-colors.js";
import type { PillActivity } from "../src/dashboard/shared/pill-activity.js";
import type { CylinderState, LifecyclePair } from "../src/dashboard/store/types.js";
import { engineView } from "../src/dashboard/shared/engine-view.js";
import { fieldModel } from "../src/dashboard/field/model.js";
import { layoutField } from "../src/dashboard/field/layout.js";
import { workViews } from "../src/dashboard/shared/work-view.js";
import { renderInbox, stateWith } from "./dashboard-helpers.js";

// Every state lands on a level of token burn (issue #281), and the level is a
// stratum of the field. The rainbow of issue hues is kept for the top one,
// burning (issue #286): below it work is hue-free gray, and only the things
// that identify a piece of work — the mark on its line, its inbox card, its
// tether — keep its hue.

const LEVELS: BurnLevel[] = ["burning", "queued", "waiting", "cold"];
const GRAY = { hex: NEUTRAL_COLOR, rgb: NEUTRAL_COLOR_RGB };

function hueFree(rgb: string): boolean {
  const [r, g, b] = rgb.split(",").map(Number);
  return r === g && g === b;
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

// ── the rule ─────────────────────────────────────────────────────────────────

test("only the burning level is drawn in the work's hue; every level below it is hue-free gray", () => {
  for (let n = 0; n <= 2000; n++) {
    const hue = issueColor(n);
    assert.deepEqual(burnColor(hue, "burning"), hue, `#${n} burns in its own color, exactly`);
    for (const level of LEVELS.filter((l) => l !== "burning")) {
      const c = burnColor(hue, level);
      assert.deepEqual(c, GRAY, `#${n} at ${level} is the trim gray, --trim-dim`);
      assert.ok(hueFree(c.rgb), `#${n} at ${level} has no hue`);
    }
  }
});

// ── engine cylinders ─────────────────────────────────────────────────────────

test("a cylinder keeps its work's hue for as long as it holds the work, and is trim gray with none", () => {
  assert.deepEqual(cylinderColor(cylinder()), issueColor(7), "burning on it");
  for (const status of ["done", "error", "shutdown"] as const) {
    assert.deepEqual(cylinderColor(cylinder({ status })), issueColor(7), `${status}: still holding the work, so still its hue`);
  }
  const idle = cylinder({ status: "idle", color: null, colorRgb: null, issueNumber: null });
  assert.deepEqual(cylinderColor(idle), GRAY, "idle is trim");
  const parked = { ...idle, rateLimitedUntilMs: Date.now() + 60_000, idleStatusText: "claude-usage-limit" };
  assert.deepEqual(cylinderColor(parked), GRAY, "parked by a limit is trim");
});

test("the field draws an engine in its work's hue, burning or done with it", () => {
  assert.equal(rowColor(cylinder()), issueColor(7).hex);
  assert.equal(rowColor(cylinder({ status: "done" })), issueColor(7).hex, "on the bench, in the burning stratum");
  assert.equal(rowColor(cylinder({ status: "error" })), issueColor(7).hex);
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

test("the field draws a piece of work in its hue while an engine burns on it, and in gray below", () => {
  assert.equal(pillColor(pair(), "working"), issueColor(7).hex);
  assert.equal(pillColor(pair(), "review"), NEUTRAL_COLOR, "waiting: gray");
  assert.equal(pillColor(pair(), "working", true), issueColor(7).hex, "dark, but its engine is still finishing: a reactor keeps its hue");
  const orphan = pair({ issue: null, pr: { number: 300, title: "Orphan", state: "open", checksStatus: "pending" }, prPhase: "active" });
  assert.equal(pillColor(orphan, "waiting-ci"), NEUTRAL_COLOR, "queued: gray");
});

test("work below the burning stratum keeps its hue as its identity, not as its color", () => {
  for (const [p, activity] of [[pair({ disabled: true }), "manual"], [pair(), "review"], [pair({ prPhase: "active" }), null]] as const) {
    const [work] = workViews(stateFor(p, activity), Date.now());
    assert.ok(work && work.level !== "burning");
    assert.equal(work.color.hex, NEUTRAL_COLOR, `${work.level}: drawn in gray`);
    assert.equal(work.hue.hex, issueColor(7).hex, `${work.level}: still knows which issue it is`);
  }
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

test("an inbox card is edged in its work's own hue at every level, so it can be matched to the work", () => {
  const parked = pair({ approval: "awaiting-approval" });
  const { cards, html } = renderInbox(stateFor(parked, "review"));
  const hue = issueColor(7);
  assert.equal(cards[0]?.color?.hex, hue.hex, "a waiting PR's card is not gray, though its line is");
  assert.ok(html.includes(`--card-color:${hue.hex};--card-rgb:${hue.rgb}`));
});

// ── one rule for every component ─────────────────────────────────────────────

test("an engine and the work it is on burn in the same hue, and work that has cooled is gray wherever it is drawn", () => {
  assert.equal(rowColor(cylinder()), pillColor(pair(), "working"), "an engine and the work it is on burn alike");
  assert.equal(pillColor(pair({ disabled: true }), "manual"), NEUTRAL_COLOR, "a manual PR is cold, so gray");
  assert.equal(pillColor(pair(), "review", true), NEUTRAL_COLOR, "shut down is cold, so gray");
  assert.equal(rowColor(cylinder({ status: "shutdown" })), issueColor(7).hex, "while a shut-down engine still holds its work, it keeps the hue");
});
