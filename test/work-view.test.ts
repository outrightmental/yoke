import test from "node:test";
import assert from "node:assert/strict";

import { engineView, engineViews } from "../src/dashboard/shared/engine-view.js";
import { issueColor, NEUTRAL_COLOR } from "../src/dashboard/shared/issue-colors.js";
import { burnColor } from "../src/dashboard/shared/burn-level.js";
import { liveHold, vitals } from "../src/dashboard/shared/vitals.js";
import {
  actionTarget,
  actionVerb,
  briefStatus,
  compareWork,
  pairStage,
  STAGES,
  workGlyph,
  workViews,
  type WorkView,
} from "../src/dashboard/shared/work-view.js";
import { dashboardReducer, initialState } from "../src/dashboard/store/dashboard-store.js";
import type { DashboardState, LifecyclePair } from "../src/dashboard/store/types.js";
import { cylinder, makeEvent, stateWith } from "./dashboard-helpers.js";

// Everything the field, the inbox and the screen-reader mirror say about a
// piece of work is worked out once, in workViews. These pin what it says.

const NOW = Date.parse("2026-11-10T12:00:00Z");
const MINUTE = 60_000;

function issuePair(number: number, overrides: Partial<LifecyclePair> = {}): LifecyclePair {
  return { issue: { number, title: `Issue ${number}`, state: "open" }, pr: null, prPhase: "absent", ...overrides };
}

function prPair(number: number, prNumber: number, overrides: Partial<LifecyclePair> = {}, pr: Record<string, unknown> = {}): LifecyclePair {
  return {
    issue: { number, title: `Issue ${number}`, state: "open" },
    pr: { number: prNumber, title: `PR ${prNumber}`, state: "open", draft: true, checksStatus: "success", ...pr },
    prPhase: "active",
    ...overrides,
  };
}

/** The one piece of work a dashboard showing only `pair` has. */
function only(pair: LifecyclePair, overrides: Partial<DashboardState> = {}): WorkView {
  const [work] = workViews(stateWith([pair], "o/a", overrides), NOW);
  assert.ok(work);
  return work;
}

// ── the lifecycle ────────────────────────────────────────────────────────────

test("the lifecycle has five stages, and each phase of a pair is one of them", () => {
  assert.deepEqual([...STAGES], ["issue", "build", "draft", "ready", "merged"]);
  assert.equal(pairStage(issuePair(1)), 0);
  assert.equal(pairStage(issuePair(1, { prPhase: "inactive", projectStatus: "Backlog" })), 0, "out of the queue is still an issue");
  assert.equal(pairStage(issuePair(1, { prPhase: "planning" })), 1);
  assert.equal(pairStage(prPair(1, 10)), 2);
  assert.equal(pairStage(prPair(1, 10, { prPhase: "review" }, { draft: false })), 3);
  assert.equal(pairStage(prPair(1, 10, { prPhase: "completed" })), 4);
});

// ── where a piece of work stands ─────────────────────────────────────────────

test("a line of status names the one thing a piece of work is waiting on", () => {
  const cases: Array<[string, LifecyclePair, string, string]> = [
    ["a ready issue", issuePair(1), "waiting for an engine", "plain"],
    ["a blocked issue", issuePair(1, { blockedByIssueNumbers: [2, 3] }), "blocked by #2, #3", "problem"],
    ["a claimed issue", issuePair(1, { prPhase: "planning" }), "implementing…", "plain"],
    ["out of the queue", issuePair(1, { prPhase: "inactive", projectStatus: "Backlog" }), "Backlog", "plain"],
    ["a draft waiting its turn", prPair(1, 10), "draft — waiting for an engine", "plain"],
    ["checks running", prPair(1, 10, {}, { checksStatus: "pending" }), "checks running", "progress"],
    ["checks failing", prPair(1, 10, {}, { checksStatus: "failure" }), "checks failing — an engine fixes them next", "problem"],
    ["ready for review", prPair(1, 10, { prPhase: "review" }, { draft: false }), "ready for review", "plain"],
    ["parked for approval", prPair(1, 10, { prPhase: "review", approval: "awaiting-approval" }, { draft: false }), "ready — waiting for your approval", "plain"],
    ["parked, checks failing", prPair(1, 10, { prPhase: "review", approval: "awaiting-approval" }, { draft: false, checksStatus: "failure" }), "ready — but its checks are failing", "problem"],
    ["manual", prPair(1, 10, { prPhase: "review", disabled: true }, { draft: false }), "manual — yoke leaves it to you", "plain"],
    ["merged", prPair(1, 10, { prPhase: "completed" }), "merged", "approved"],
  ];
  for (const [description, pair, text, tone] of cases) {
    const { status } = only(pair);
    assert.deepEqual({ text: status.text, tone: status.tone }, { text, tone }, description);
  }
});

test("a status that says only what its stratum says is marked routine, so a list can leave it unsaid", () => {
  assert.equal(only(issuePair(1)).status.routine, true);
  assert.equal(only(prPair(1, 10)).status.routine, true);
  for (const pair of [
    issuePair(1, { blockedByIssueNumbers: [2] }),
    prPair(1, 10, {}, { checksStatus: "pending" }),
    prPair(1, 10, { prPhase: "review", approval: "awaiting-approval" }, { draft: false }),
  ]) {
    assert.notEqual(only(pair).status.routine, true, only(pair).status.text);
  }
});

test("a line with room for only a few words says where the work stands in a word or two", () => {
  const brief = (pair: LifecyclePair, overrides: Partial<DashboardState> = {}) => briefStatus(only(pair, overrides).status);

  assert.equal(brief(issuePair(1)), "", "waiting its turn: its stratum says so");
  assert.equal(brief(issuePair(1, { blockedByIssueNumbers: [2] })), "blocked by #2");
  assert.equal(brief(prPair(1, 10, {}, { checksStatus: "pending" })), "checks running");
  assert.equal(brief(prPair(1, 10, {}, { checksStatus: "failure" })), "checks failing");
  assert.equal(brief(prPair(1, 10, { prPhase: "review", approval: "awaiting-approval" }, { draft: false })), "awaiting approval");
  assert.equal(brief(prPair(1, 10, { prPhase: "review", approval: "awaiting-approval" }, { draft: false, checksStatus: "failure" })), "checks failing");
  assert.equal(brief(prPair(1, 10, { prPhase: "review", approval: "approved" }, { draft: false })), "approved");
  assert.equal(brief(prPair(1, 10, { prPhase: "review", disabled: true }, { draft: false })), "manual");
  assert.equal(brief(prPair(1, 10, { prPhase: "completed" })), "merged");

  const refused = brief(prPair(1, 10, { prPhase: "review", approval: "awaiting-approval", repo: "o/a" }, { draft: false }), {
    approvalPresses: new Map([["o/a#10", { repo: "o/a", pullRequestNumber: 10, atMs: NOW - 5, sent: true }]]),
    approvals: new Map([["o/a#10", {
      repo: "o/a", pullRequestNumber: 10, requestedAt: "", state: "refused" as const, reason: "its checks are failing",
      emittedAt: "", receivedAtMs: NOW,
    }]]),
  });
  assert.equal(refused, "not approved", "the reason is on the card");
});

test("an approval says its own piece first: it is the one thing a person set in motion", () => {
  const approved = only(prPair(1, 10, { prPhase: "review", approval: "approved" }, { draft: false }));
  assert.equal(approved.status.text, "approved — waiting for a free engine to squash-merge it");
  assert.equal(approved.status.tone, "approved");

  const pressed = only(prPair(1, 10, { prPhase: "review", approval: "awaiting-approval", repo: "o/a" }, { draft: false }), {
    approvalPresses: new Map([["o/a#10", { repo: "o/a", pullRequestNumber: 10, atMs: NOW, sent: true }]]),
  });
  assert.equal(pressed.status.text, "queued — sent to yoke…");
});

test("work an engine is on says what the engine is doing to it", () => {
  const state = stateWith([prPair(7, 70)], "o/a", {
    cylinders: [cylinder({ actionType: "self-review", issueNumber: null, prNumber: 70 })],
  });
  const [work] = workViews(state, NOW);
  assert.equal(work?.status.text, "reviewing PR #70");
  assert.equal(work?.engine?.index, 1);
  assert.equal(work?.level, "burning");
  assert.equal(work?.color.hex, issueColor(7).hex, "at full saturation");
});

test("shut down, waiting work reads shut down rather than waiting for an engine that is not coming (#268)", () => {
  const dark = { shutdownRequested: true };
  assert.equal(only(issuePair(1), dark).status.text, "shut down");
  assert.equal(only(issuePair(1, { prPhase: "planning" }), dark).status.text, "shut down");
  assert.equal(only(prPair(1, 10), dark).status.text, "shut down");
  assert.equal(only(issuePair(1), dark).level, "cold");
  assert.equal(only(issuePair(1), dark).dark, true);
});

// ── what the field draws it with ─────────────────────────────────────────────

test("a piece of work goes by its issue, or by its PR when it closes none", () => {
  const withIssue = only(prPair(7, 70, { repo: "o/a" }));
  assert.equal(withIssue.number, 7);
  assert.equal(withIssue.title, "Issue 7");
  assert.equal(withIssue.issueUrl, "https://github.com/o/a/issues/7");
  assert.equal(withIssue.prUrl, "https://github.com/o/a/pull/70");

  const orphan = only({ issue: null, pr: { number: 300, title: "Orphan", state: "open" }, prPhase: "review", repo: "o/a" });
  assert.equal(orphan.number, 300);
  assert.equal(orphan.title, "Orphan");
  assert.equal(orphan.issueUrl, null);
  assert.equal(orphan.hue.hex, issueColor(300).hex, "never gray (#280)");
});

test("with one project the links come from the dashboard's own repository", () => {
  const state: DashboardState = { ...stateWith([issuePair(4)], ""), owner: "acme", repo: "app" };
  const [work] = workViews(state, NOW);
  assert.equal(work?.repo, "", "nothing to label it with");
  assert.equal(work?.issueUrl, "https://github.com/acme/app/issues/4");
});

test("the color of a piece of work is its issue's hue at its burn level", () => {
  const blocked = only(issuePair(9, { blockedByIssueNumbers: [8] }));
  assert.equal(blocked.level, "waiting");
  assert.equal(blocked.hue.hex, issueColor(9).hex);
  assert.equal(blocked.color.hex, burnColor(issueColor(9), "waiting").hex);
  assert.notEqual(blocked.color.hex, NEUTRAL_COLOR);
});

test("an engine's work is on the field even when GitHub's open lists no longer carry it", () => {
  const state = {
    ...initialState(),
    cylinders: [cylinder({ issueNumber: 402, issueTitle: "Closed mid-flight", repo: "o/a" })],
  };
  const [work] = workViews(state, NOW);
  assert.equal(work?.number, 402);
  assert.equal(work?.title, "Closed mid-flight");
  assert.equal(work?.engine?.index, 1);
});

test("the glyph at the end of a line says what the work is doing or waiting on", () => {
  const glyph = (pair: LifecyclePair, overrides: Partial<DashboardState> = {}) => workGlyph(only(pair, overrides));
  assert.equal(glyph(prPair(1, 10, { prPhase: "review", disabled: true }, { draft: false })), "person");
  assert.equal(glyph(prPair(1, 10, {}, { checksStatus: "pending" })), "checks");
  assert.equal(glyph(prPair(1, 10, { prPhase: "review" }, { draft: false })), "eye");
  assert.equal(glyph(prPair(1, 10, { prPhase: "review", approval: "approved" }, { draft: false })), "approved");
  assert.equal(glyph(prPair(1, 10, {}, { checksStatus: "failure" })), "failing");
  assert.equal(glyph(issuePair(1, { blockedByIssueNumbers: [2] })), "blocked");
  assert.equal(glyph(prPair(1, 10, { prPhase: "completed" })), "merged");
  assert.equal(glyph(issuePair(1)), null, "nothing to say: no glyph");
  assert.equal(glyph(prPair(7, 70), { cylinders: [cylinder({ issueNumber: 7 })] }), "engine");
});

test("within a stratum, work is ordered nearest to moving first, then by number, and stays put", () => {
  const pairs: LifecyclePair[] = [
    issuePair(9),
    issuePair(3),
    prPair(5, 50),
    prPair(6, 60, {}, { checksStatus: "pending" }),
    prPair(4, 40, { prPhase: "review", approval: "approved" }, { draft: false }),
    issuePair(2, { prPhase: "planning" }),
  ];
  const works = workViews(stateWith(pairs), NOW).filter((work) => work.level === "queued").sort(compareWork);
  assert.deepEqual(works.map((work) => work.number), [4, 6, 5, 2, 3, 9], "approved, checks running, drafts, claimed, then issues by number");
  const shuffled = [...works].reverse().sort(compareWork);
  assert.deepEqual(shuffled.map((work) => work.key), works.map((work) => work.key), "the same order whatever order it arrives in");
});

// ── engines ──────────────────────────────────────────────────────────────────

test("actionVerb and actionTarget name every action an engine runs", () => {
  assert.equal(actionVerb("start-implementation"), "implementing");
  assert.equal(actionVerb("self-review", "done"), "reviewed");
  assert.equal(actionVerb("address-failing-checks"), "fixing checks");
  assert.equal(actionVerb("resolve-conflicts", "done"), "resolved conflicts");
  assert.equal(actionVerb("squash-merge"), "merging");
  assert.equal(actionVerb("request-review"), "requesting review");
  assert.equal(actionVerb("something-new"), "something-new", "an action this dashboard has not heard of goes by its own name");
  assert.equal(actionVerb(null), "working");

  assert.equal(actionTarget({ actionType: "start-implementation", issueNumber: 40, prNumber: null }), "#40");
  assert.equal(actionTarget({ actionType: "self-review", issueNumber: 40, prNumber: 118 }), "PR #118");
  assert.equal(actionTarget({ actionType: "self-review", issueNumber: null, prNumber: null }), "");
});

test("an engine running an action says what, on what, and for how long", () => {
  const c = issueColor(7);
  const view = engineView(cylinder({ color: c.hex, colorRgb: c.rgb, model: "claude-opus-5-5", actionStartedAt: NOW - 84_000 }), NOW);
  assert.equal(view.index, 0, "counted from 0");
  assert.equal(view.verb, "implementing");
  assert.equal(view.target, "#7");
  assert.equal(view.clock, "1m 24s");
  assert.equal(view.line, "implementing #7 · 1m 24s");
  assert.equal(view.brief, "implementing #7");
  assert.equal(view.model, "Claude Opus 5.5");
  assert.equal(view.color.hex, c.hex, "burning: its work's color at full saturation");
  assert.equal(view.hasWork, true);
});

test("an engine whose action has ended says how it ended, in its work's color gone cold", () => {
  const c = issueColor(7);
  const done = engineView(cylinder({ color: c.hex, colorRgb: c.rgb, status: "done", actionType: "squash-merge", prNumber: 75 }), NOW);
  assert.equal(done.line, "✓ merged PR #75");
  assert.equal(done.color.hex, burnColor(c, "cold").hex);

  const failed = engineView(cylinder({ color: c.hex, colorRgb: c.rgb, status: "error", actionType: "self-review", prNumber: 119 }), NOW);
  assert.equal(failed.line, "✗ reviewing PR #119 failed");
});

test("an idle engine says what it is waiting on, in trim gray: a limit by name, else the time to its next cycle", () => {
  const idle = (overrides: Parameters<typeof cylinder>[0]) =>
    engineView(cylinder({ status: "idle", actionType: null, issueNumber: null, ...overrides }), NOW);

  const waiting = idle({ nextCycleAtMs: NOW + 42_000 });
  assert.equal(waiting.line, "idle · next cycle in 42s");
  assert.equal(waiting.brief, "idle · 42s");
  assert.equal(waiting.color.hex, NEUTRAL_COLOR);
  assert.equal(waiting.hasWork, false);

  const usage = idle({ idleStatusText: "claude-usage-limit", rateLimitedUntilMs: NOW + 134 * MINUTE, nextCycleAtMs: NOW + 134 * MINUTE });
  assert.equal(usage.parked, "usage-limit");
  assert.equal(usage.brief, "usage limit · 2h 14m", "a limit outranks the cycle timer");

  const rate = idle({ idleStatusText: "github-rate-limit", rateLimitedUntilMs: NOW + 5 * MINUTE });
  assert.equal(rate.parked, "rate-limit");
  assert.equal(rate.line, "⏸ rate limited · 5m 0s");

  assert.equal(idle({ idleStatusText: "nothing to do this cycle" }).line, "nothing to do this cycle");
  assert.equal(idle({ idleStatusText: "" }).line, "idle");
  assert.equal(idle({ nextCycleAtMs: NOW - 1 }).line, "idle", "a countdown that has run out is not shown at zero");

  const stopped = engineView(cylinder({ status: "shutdown" }), NOW);
  assert.equal(stopped.line, "shut down");
  assert.equal(stopped.hasWork, false);
});

test("engineViews keeps the pool's order", () => {
  const views = engineViews({ cylinders: [cylinder({ index: 1 }), cylinder({ index: 2, status: "idle" }), cylinder({ index: 3 })] }, NOW);
  assert.deepEqual(views.map((view) => view.index), [0, 1, 2]);
});

// ── the run's vitals ─────────────────────────────────────────────────────────

test("vitals: the cycle is the latest any engine has started, and the countdown the soonest any idle one will", () => {
  const state = {
    ...initialState(),
    cylinders: [
      cylinder({ index: 1, iterationNumber: 11 }),
      cylinder({ index: 2, iterationNumber: 12, status: "idle", nextCycleAtMs: NOW + 90_000 }),
      cylinder({ index: 3, iterationNumber: 9, status: "idle", nextCycleAtMs: NOW + 30_000 }),
    ],
  };
  const v = vitals(state, NOW);
  assert.equal(v.cycle, 12);
  assert.deepEqual(v.countdown, { label: "NEXT", value: "30s", held: false });
  assert.equal(v.engines, 3);
  assert.equal(v.burning, 1);
  assert.equal(v.phase, "running");
});

test("vitals: a hold outranks every engine's own countdown", () => {
  const untilMs = NOW + 134 * MINUTE;
  const state = {
    ...initialState(),
    hold: { kind: "claude-usage-limit", reason: "Claude usage limit", untilMs },
    cylinders: [cylinder({ status: "idle", nextCycleAtMs: NOW + 30_000 })],
  };
  const v = vitals(state, NOW);
  assert.deepEqual(v.countdown, { label: "WAITING", value: "2h 14m", held: true });
  assert.equal(v.hold?.remaining, "2h 14m");
  assert.equal(v.hold?.reason, "Claude usage limit");
  assert.equal(v.usage.percentText, "LIMIT");

  assert.equal(vitals(state, untilMs + 1).hold, null, "a hold that has run out is over, whatever the store still holds");
  assert.equal(liveHold(state.hold, untilMs + 1), null);
});

test("vitals: the subtitle is the one project's name, or how many share the dashboard", () => {
  const single = { ...initialState(), owner: "acme", repo: "app", title: "Acme" };
  assert.equal(vitals(single, NOW).subtitle, "acme/app");
  assert.equal(vitals(single, NOW).homeUrl, "https://github.com/acme/app");
  assert.equal(vitals(single, NOW).title, "Acme");

  let multi: DashboardState = { ...initialState(), multiProject: true };
  for (const repo of ["o/a", "o/b", "o/c"]) multi = dashboardReducer(multi, makeEvent("lifecycle-update", { repo, pairs: [] }));
  assert.equal(vitals(multi, NOW).subtitle, "3 projects");
  assert.equal(vitals({ ...initialState() }, NOW).title, "Yoke", "with no title configured it is yoke's own");
});

test("vitals: shutting down, then shut down", () => {
  assert.equal(vitals({ ...initialState(), shutdownRequested: true }, NOW).phase, "shutting-down");
  assert.equal(vitals({ ...initialState(), shutdownRequested: true, appShutdown: true }, NOW).phase, "shut-down");
});
