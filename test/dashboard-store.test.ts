import test from "node:test";
import assert from "node:assert/strict";
import { dashboardReducer, initialState, DashboardStore } from "../src/dashboard/store/dashboard-store.js";
import type { DashboardState } from "../src/dashboard/store/dashboard-store.js";
import type { LifecyclePair } from "../src/dashboard/store/types.js";
import { issueColor, NEUTRAL_COLOR } from "../src/dashboard/shared/issue-colors.js";
import { workingCylinder } from "../src/dashboard/shared/working-cylinder.js";
import { pillActivity, pillKey, pillsDark, waitingOnChecks } from "../src/dashboard/shared/pill-activity.js";
import { LifecyclePill } from "../src/dashboard/components/lifecycle-pill.js";
import { formatClockTime } from "../src/dashboard/shared/format.js";

interface WireEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

function makeEvent(type: string, data: Record<string, unknown> = {}): WireEvent {
  return { type, timestamp: new Date().toISOString(), data };
}

// ── iteration-start ───────────────────────────────────────────────────────────

test("reducer: iteration-start initialises cylinder at engineIndex", () => {
  const s0 = initialState();
  const s1 = dashboardReducer(s0, makeEvent("iteration-start", { engineIndex: 0, iterationNumber: 5, maxConcurrency: 3 }));
  assert.equal(s1.cylinders[0]?.iterationNumber, 5);
  assert.equal(s1.cylinders[0]?.status, "idle");
  assert.equal(s1.maxConcurrency, 3);
});

test("reducer: iteration-start clears stale issue/PR mappings", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 1, totalActions: 1, type: "start-implementation", issueNumber: 7, description: "d" }));
  assert.equal(s.cylinderByIssue.get(7), 0, "cylinder 0 should own issue 7");

  s = dashboardReducer(s, makeEvent("iteration-start", { engineIndex: 0, iterationNumber: 2, maxConcurrency: 3 }));
  assert.equal(s.cylinderByIssue.has(7), false, "issue mapping should be cleared on iteration-start");
});

test("reducer: iteration-start with new maxConcurrency re-initialises all cylinders", () => {
  let s = initialState();
  assert.equal(s.cylinders.length, 3);
  s = dashboardReducer(s, makeEvent("iteration-start", { engineIndex: 0, iterationNumber: 1, maxConcurrency: 2 }));
  assert.equal(s.cylinders.length, 2);
});

test("reducer: cylinders are neutral when idle and adopt the working issue's stable color", () => {
  // Cylinders no longer own colors — color is keyed to the issue being worked
  // (issue #236), so any number of cylinders starts without a color.
  let s = initialState();
  s = dashboardReducer(s, makeEvent("iteration-start", { engineIndex: 0, iterationNumber: 1, maxConcurrency: 8 }));
  assert.equal(s.cylinders.length, 8);
  for (const cyl of s.cylinders) {
    assert.equal(cyl.color, null, "idle cylinder has no issue color");
    assert.equal(cyl.colorRgb, null, "idle cylinder has no issue color rgb");
  }

  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 1, totalActions: 1, type: "start-implementation", issueNumber: 42, description: "d" }));
  assert.equal(s.cylinders[0]?.color, issueColor(42).hex, "active cylinder shows its issue's stable color");
  assert.equal(s.cylinders[0]?.colorRgb, issueColor(42).rgb);

  s = dashboardReducer(s, makeEvent("engine-idle", { engineIndex: 0, reason: "done" }));
  assert.equal(s.cylinders[0]?.color, null, "idle cylinder returns to neutral");
});

test("reducer: the same issue keeps its color on whichever engine works it", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 1, totalActions: 3, type: "start-implementation", issueNumber: 7, description: "d" }));
  const first = s.cylinders[0]?.color;
  s = dashboardReducer(s, makeEvent("engine-idle", { engineIndex: 0, reason: "done" }));
  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 3, totalActions: 3, type: "start-implementation", issueNumber: 7, description: "d" }));
  assert.equal(s.cylinders[2]?.color, first, "issue #7 has the same color on engine 3 as on engine 1");
  assert.equal(first, issueColor(7).hex);
});

// ── action-start ──────────────────────────────────────────────────────────────

test("reducer: action-start sets cylinder to active", () => {
  const s0 = initialState();
  const s1 = dashboardReducer(s0, makeEvent("action-start", {
    actionIndex: 1,
    totalActions: 2,
    type: "start-implementation",
    issueNumber: 42,
    description: "implementing #42",
  }));
  assert.equal(s1.cylinders[0]?.status, "active");
  assert.equal(s1.cylinders[0]?.issueNumber, 42);
  assert.equal(s1.cylinders[0]?.actionType, "start-implementation");
  assert.equal(s1.cylinderByIssue.get(42), 0);
});

test("reducer: action-start preserves startedAt when provided", () => {
  const s0 = initialState();
  const startedAt = Date.now() - 60_000;
  const s1 = dashboardReducer(s0, makeEvent("action-start", {
    actionIndex: 1,
    totalActions: 1,
    type: "self-review",
    startedAt,
  }));
  assert.equal(s1.cylinders[0]?.actionStartedAt, startedAt);
});

// ── action-complete / action-error ────────────────────────────────────────────

test("reducer: action-complete sets cylinder to done", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 1, totalActions: 1, type: "self-review", description: "d" }));
  s = dashboardReducer(s, makeEvent("action-complete", { actionIndex: 1, totalActions: 1 }));
  assert.equal(s.cylinders[0]?.status, "done");
  assert.deepEqual(s.cylinders[0]?.thinkingLines, []);
});

test("reducer: action-error sets cylinder to error", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 1, totalActions: 1, type: "self-review", description: "d" }));
  s = dashboardReducer(s, makeEvent("action-error", { actionIndex: 1, totalActions: 1, error: "timeout" }));
  assert.equal(s.cylinders[0]?.status, "error");
});

// ── engine-idle ───────────────────────────────────────────────────────────────

test("reducer: engine-idle sets cylinder idle and preserves timing fields", () => {
  const nextCycleAtMs = Date.now() + 30_000;
  const rateLimitedUntilMs = Date.now() + 900_000;
  let s = initialState();
  s = dashboardReducer(s, makeEvent("engine-idle", { engineIndex: 0, nextCycleAtMs, rateLimitedUntilMs }));
  assert.equal(s.cylinders[0]?.status, "idle");
  assert.equal(s.cylinders[0]?.nextCycleAtMs, nextCycleAtMs);
  assert.equal(s.cylinders[0]?.rateLimitedUntilMs, rateLimitedUntilMs);
});

test("reducer: engine-idle clears cylinder issue/PR mappings", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 1, totalActions: 1, type: "start-implementation", issueNumber: 5, description: "d" }));
  assert.ok(s.cylinderByIssue.has(5));
  s = dashboardReducer(s, makeEvent("engine-idle", { engineIndex: 0, reason: "done" }));
  assert.equal(s.cylinderByIssue.has(5), false);
});

// ── engine-shutdown ───────────────────────────────────────────────────────────

test("reducer: engine-shutdown sets cylinder to shutdown", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("engine-shutdown", { engineIndex: 1 }));
  assert.equal(s.cylinders[1]?.status, "shutdown");
});

// ── shutdown-requested / app-shutdown ─────────────────────────────────────────

test("reducer: shutdown-requested sets shutdownRequested flag", () => {
  const s = dashboardReducer(initialState(), makeEvent("shutdown-requested", {}));
  assert.equal(s.shutdownRequested, true);
});

test("reducer: app-shutdown sets appShutdown flag", () => {
  const s = dashboardReducer(initialState(), makeEvent("app-shutdown", {}));
  assert.equal(s.appShutdown, true);
});

// ── snapshot-update ───────────────────────────────────────────────────────────

test("reducer: snapshot-update populates issueCards and prCards", () => {
  const s = dashboardReducer(initialState(), makeEvent("snapshot-update", {
    issueCount: 2,
    prCount: 1,
    sessionCount: 3,
    issues: [{ number: 1, title: "Bug", state: "open" }, { number: 2, title: "Feat", state: "open" }],
    pullRequests: [{ number: 10, title: "Fix", state: "open" }],
  }));
  assert.equal(s.issueCards.size, 2);
  assert.equal(s.prCards.size, 1);
  assert.equal(s.sessionCount, 3);
});

// ── lifecycle-update ──────────────────────────────────────────────────────────

test("reducer: lifecycle-update stores lastLifecyclePairs", () => {
  const pairs = [
    { issue: { number: 1, title: "A", state: "open" }, prPhase: "active" },
  ];
  const s = dashboardReducer(initialState(), makeEvent("lifecycle-update", { pairs }));
  assert.equal(s.lastLifecyclePairs.length, 1);
  assert.equal(s.lastLifecyclePairs[0]?.prPhase, "active");
});

// ── broadcast events ──────────────────────────────────────────────────────────

test("reducer: broadcast-commit adds to broadcastQueue", () => {
  const s = dashboardReducer(initialState(), makeEvent("broadcast-commit", {
    stateBefore: "old",
    changeHow: "merged",
    stateAfter: "new",
  }));
  assert.equal(s.broadcastQueue.length, 1);
  assert.equal(s.broadcastQueue[0]?.category, "commit");
});

test("reducer: broadcast-pr-update adds to broadcastQueue with correct label", () => {
  const s = dashboardReducer(initialState(), makeEvent("broadcast-pr-update", {
    stateBefore: "draft",
    changeHow: "marked ready",
    stateAfter: "ready",
  }));
  assert.equal(s.broadcastQueue[0]?.label, "PR UPDATE");
});

test("reducer: workflow-approval adds to broadcastQueue with WORKFLOW label", () => {
  const s = dashboardReducer(initialState(), makeEvent("workflow-approval", {
    runName: "CI",
    runId: "abc123",
  }));
  assert.equal(s.broadcastQueue.length, 1);
  assert.equal(s.broadcastQueue[0]?.label, "WORKFLOW");
});

// ── cylinder-cancel ───────────────────────────────────────────────────────────

test("reducer: cylinder-cancel sets idleStatusText to 'cancelling…' and clears nextCycleAtMs", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("engine-idle", { engineIndex: 0, nextCycleAtMs: Date.now() + 30_000 }));
  s = dashboardReducer(s, makeEvent("cylinder-cancel", { engineIndex: 0 }));
  assert.equal(s.cylinders[0]?.idleStatusText, "cancelling…");
  assert.equal(s.cylinders[0]?.nextCycleAtMs, null);
  assert.ok(s.eventStream.at(-1)?.text.includes("cancel"), "event stream should mention cancel");
  assert.equal(s.eventStream.at(-1)?.level, "warning");
});

// ── github-rate-limit / github-rate-limit-cleared ─────────────────────────────

test("reducer: github-rate-limit adds warning to eventStream", () => {
  const s = dashboardReducer(initialState(), makeEvent("github-rate-limit", {
    kind: "secondary",
    api: "rest",
    message: "secondary rate limited",
    waitMs: 60000,
  }));
  assert.equal(s.eventCount, 1);
  assert.ok(s.eventStream[0]?.text.includes("rate limit"), "should mention rate limit");
  assert.equal(s.eventStream[0]?.level, "warning");
});

test("reducer: github-rate-limit-cleared adds success message to eventStream", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("github-rate-limit", { message: "limited" }));
  s = dashboardReducer(s, makeEvent("github-rate-limit-cleared", {}));
  assert.equal(s.eventCount, 2);
  assert.ok(s.eventStream[1]?.text.includes("cleared"), "should mention cleared");
  assert.equal(s.eventStream[1]?.level, "success");
});

// ── claude-thinking ───────────────────────────────────────────────────────────

test("reducer: claude-thinking appends thinking lines up to 200", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 1, totalActions: 1, type: "self-review", description: "d" }));
  s = dashboardReducer(s, makeEvent("claude-thinking", { engineIndex: 0, excerpt: "line1\nline2\nline3" }));
  assert.equal(s.cylinders[0]?.thinkingLines.length, 3);
  assert.equal(s.cylinders[0]?.thinkingLines[0], "line1");
});

// ── eventStream / eventCount ──────────────────────────────────────────────────

test("reducer: events increment eventCount", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("log-message", { message: "hello", level: "info" }));
  s = dashboardReducer(s, makeEvent("log-message", { message: "world", level: "info" }));
  assert.equal(s.eventCount, 2);
  assert.equal(s.eventStream.length, 2);
});

// ── phase-update ──────────────────────────────────────────────────────────────

test("reducer: phase-update adds to eventStream", () => {
  const s = dashboardReducer(initialState(), makeEvent("phase-update", { phase: "planning" }));
  assert.equal(s.eventCount, 1);
  assert.ok(s.eventStream[0]?.text.includes("planning"), "event text should include phase name");
});

// ── default handler (cycle-start, plan-update, iteration-complete) ────────────

test("reducer: unknown/default event type adds to eventStream", () => {
  const s = dashboardReducer(initialState(), makeEvent("cycle-start", {}));
  assert.equal(s.eventCount, 1);
  assert.ok(s.eventStream[0]?.text.includes("cycle-start"), "should include event type in text");
});

// ── broadcast-ci-status ───────────────────────────────────────────────────────

test("reducer: broadcast-ci-status adds to broadcastQueue with ci category", () => {
  const s = dashboardReducer(initialState(), makeEvent("broadcast-ci-status", {
    stateBefore: "failing",
    changeHow: "fixed tests",
    stateAfter: "passing",
  }));
  assert.equal(s.broadcastQueue.length, 1);
  assert.equal(s.broadcastQueue[0]?.category, "ci");
  assert.equal(s.broadcastQueue[0]?.label, "CI STATUS");
});

// ── broadcast-review-comment ──────────────────────────────────────────────────

test("reducer: broadcast-review-comment adds to broadcastQueue", () => {
  const s = dashboardReducer(initialState(), makeEvent("broadcast-review-comment", {
    stateBefore: "pending review",
    changeHow: "reviewer approved",
    stateAfter: "approved",
  }));
  assert.equal(s.broadcastQueue.length, 1);
  assert.equal(s.broadcastQueue[0]?.label, "REVIEW COMMENT");
});

// ── broadcast-issue-update ────────────────────────────────────────────────────

test("reducer: broadcast-issue-update adds to broadcastQueue with issue category", () => {
  const s = dashboardReducer(initialState(), makeEvent("broadcast-issue-update", {
    stateBefore: "open",
    changeHow: "closed by PR",
    stateAfter: "closed",
  }));
  assert.equal(s.broadcastQueue.length, 1);
  assert.equal(s.broadcastQueue[0]?.category, "issue");
  assert.equal(s.broadcastQueue[0]?.label, "ISSUE UPDATE");
});

// ── broadcast-github-activity ─────────────────────────────────────────────────

test("reducer: broadcast-github-activity adds to broadcastQueue", () => {
  const s = dashboardReducer(initialState(), makeEvent("broadcast-github-activity", {
    stateBefore: "quiet",
    changeHow: "push happened",
    stateAfter: "active",
  }));
  assert.equal(s.broadcastQueue.length, 1);
  assert.equal(s.broadcastQueue[0]?.label, "GITHUB ACTIVITY");
});

// ── stable per-issue broadcast colors (issue #236) ────────────────────────────

test("reducer: broadcast events keyed to an issue use its stable color regardless of engine", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 1, totalActions: 2, type: "start-implementation", issueNumber: 7, description: "d" }));
  s = dashboardReducer(s, makeEvent("broadcast-issue-update", { issueNumber: 7, stateBefore: "a", changeHow: "b", stateAfter: "c" }));
  const first = s.broadcastQueue.at(-1)?.color;
  assert.equal(first, issueColor(7).hex, "color derives from the issue, not the engine");

  // Move issue 7 to a different engine — the color must not change.
  s = dashboardReducer(s, makeEvent("engine-idle", { engineIndex: 0, reason: "done" }));
  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 2, totalActions: 2, type: "start-implementation", issueNumber: 7, description: "d" }));
  s = dashboardReducer(s, makeEvent("broadcast-issue-update", { issueNumber: 7, stateBefore: "a", changeHow: "b", stateAfter: "c" }));
  assert.equal(s.broadcastQueue.at(-1)?.color, first, "issue keeps its color forever");
});

test("reducer: broadcast PR events inherit the stable color of the issue the PR closes", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("snapshot-update", {
    issueCount: 1, prCount: 1, sessionCount: 0,
    issues: [{ number: 7, title: "X", state: "open" }],
    pullRequests: [{ number: 10, title: "Fix", state: "open", closingIssueNumbers: [7], linkedIssueNumbers: [] }],
  }));
  s = dashboardReducer(s, makeEvent("broadcast-pr-update", { prNumber: 10, stateBefore: "a", changeHow: "b", stateAfter: "c" }));
  const item = s.broadcastQueue.at(-1);
  assert.equal(item?.color, issueColor(7).hex, "PR activity renders in its issue's color");
  assert.equal(item?.issueNumber, 7, "resolved issue is recorded on the feed item");
});

test("reducer: broadcast PR events fall back to the working cylinder's issue", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 1, totalActions: 1, type: "self-review", issueNumber: 9, pullRequestNumber: 33, description: "d" }));
  s = dashboardReducer(s, makeEvent("broadcast-ci-status", { prNumber: 33, stateBefore: "a", changeHow: "b", stateAfter: "c" }));
  assert.equal(s.broadcastQueue.at(-1)?.color, issueColor(9).hex);
});

test("reducer: broadcast events with no associated issue are neutral gray", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("broadcast-commit", { hash: "abc1234", stateBefore: "a", changeHow: "b", stateAfter: "c" }));
  assert.equal(s.broadcastQueue.at(-1)?.color, NEUTRAL_COLOR);
  s = dashboardReducer(s, makeEvent("workflow-approval", { runName: "CI", runId: "1" }));
  assert.equal(s.broadcastQueue.at(-1)?.color, NEUTRAL_COLOR);
});

test("reducer: broadcast labels distinguish action types without color", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("broadcast-issue-update", { issueNumber: 1, action: "opened", state: "open", stateBefore: "a", changeHow: "b", stateAfter: "c" }));
  assert.equal(s.broadcastQueue.at(-1)?.label, "NEW ISSUE");
  s = dashboardReducer(s, makeEvent("broadcast-issue-update", { issueNumber: 1, action: "updated", state: "closed", stateBefore: "a", changeHow: "b", stateAfter: "c" }));
  assert.equal(s.broadcastQueue.at(-1)?.label, "ISSUE CLOSED");
  s = dashboardReducer(s, makeEvent("broadcast-pr-update", { prNumber: 2, action: "opened", state: "open", stateBefore: "a", changeHow: "b", stateAfter: "c" }));
  assert.equal(s.broadcastQueue.at(-1)?.label, "PR OPENED");
  s = dashboardReducer(s, makeEvent("broadcast-pr-update", { prNumber: 2, action: "monitoring", state: "closed", stateBefore: "a", changeHow: "b", stateAfter: "c" }));
  assert.equal(s.broadcastQueue.at(-1)?.label, "PR CLOSED");
});

// ── full replay sequence ──────────────────────────────────────────────────────

test("reducer: applying a sequence of cached events produces consistent state", () => {
  const events: WireEvent[] = [
    makeEvent("iteration-start", { engineIndex: 0, iterationNumber: 1, maxConcurrency: 2 }),
    makeEvent("action-start", { actionIndex: 1, totalActions: 2, type: "start-implementation", issueNumber: 10, description: "d" }),
    makeEvent("snapshot-update", { issueCount: 1, prCount: 0, sessionCount: 1, issues: [{ number: 10, title: "X", state: "open" }], pullRequests: [] }),
    makeEvent("lifecycle-update", { pairs: [{ issue: { number: 10, title: "X", state: "open" }, prPhase: "planning" }] }),
  ];
  let s: DashboardState = initialState();
  for (const ev of events) s = dashboardReducer(s, ev);

  assert.equal(s.maxConcurrency, 2);
  assert.equal(s.cylinders[0]?.status, "active");
  assert.equal(s.cylinderByIssue.get(10), 0);
  assert.equal(s.issueCards.get(10)?.title, "X");
  assert.equal(s.lastLifecyclePairs[0]?.prPhase, "planning");
});

// ── DashboardStore.bootstrap() connection preservation ────────────────────────

function withMockFetch<T>(response: unknown, fn: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = async () =>
    ({ json: async () => response } as unknown as Response);
  return fn().finally(() => { globalThis.fetch = saved; });
}

const MOCK_STATE_RESPONSE = {
  owner: "test",
  repo: "repo",
  dashboardTitle: "Test",
  maxConcurrency: 2,
  cachedEvents: [] as WireEvent[],
};

test("DashboardStore.bootstrap() preserves 'connecting' status on initial load", async () => {
  await withMockFetch(MOCK_STATE_RESPONSE, async () => {
    const store = new DashboardStore();
    assert.equal(store.getState().connection, "connecting");
    await store.bootstrap();
    assert.equal(store.getState().connection, "connecting",
      "bootstrap() must not change connection status during initial load");
  });
});

test("DashboardStore.bootstrap() preserves 'disconnected' status during reconnect", async () => {
  await withMockFetch(MOCK_STATE_RESPONSE, async () => {
    const store = new DashboardStore();

    // Simulate post-disconnect state by forcing the internal state directly.
    // This is the state the store is in when onConnectionChange(false) fires.
    (store as unknown as { _state: DashboardState })._state = {
      ...store.getState(),
      connection: "disconnected",
    };
    assert.equal(store.getState().connection, "disconnected");

    // bootstrap() is called by the reconnect handler — it must not reset
    // connection back to 'connecting' before the new WebSocket has opened.
    await store.bootstrap();
    assert.equal(store.getState().connection, "disconnected",
      "bootstrap() must not reset 'disconnected' to 'connecting' during reconnect");
  });
});

// ── multi-project labeling (one shared dashboard across projects) ───────────────

test("reducer: action-start records the cylinder's project repo; engine-idle clears it", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("action-start", {
    actionIndex: 1, totalActions: 4, type: "start-implementation",
    issueNumber: 210, repo: "outrightmental/yoke", description: "d",
  }));
  assert.equal(s.cylinders[0]?.repo, "outrightmental/yoke");

  s = dashboardReducer(s, makeEvent("engine-idle", { engineIndex: 0, reason: "nothing to do this cycle" }));
  assert.equal(s.cylinders[0]?.repo, null, "idle cylinder shows no project");
});

test("reducer: lifecycle-update is scoped per repo and does not clobber other projects", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("lifecycle-update", {
    repo: "o/a",
    pairs: [{ issue: { number: 1, title: "A1", state: "open" }, pr: null, prPhase: "absent" }],
  }));
  s = dashboardReducer(s, makeEvent("lifecycle-update", {
    repo: "o/b",
    pairs: [{ issue: { number: 1, title: "B1", state: "open" }, pr: null, prPhase: "absent" }],
  }));

  // Both projects' pairs coexist (issue #1 in two different repos).
  assert.equal(s.lastLifecyclePairs.length, 2);
  assert.equal(s.lifecycleByRepo.get("o/a")?.length, 1);
  assert.equal(s.lifecycleByRepo.get("o/b")?.length, 1);
  // Each pair is tagged with its owning project.
  const repos = s.lastLifecyclePairs.map((p) => p.repo).sort();
  assert.deepEqual(repos, ["o/a", "o/b"]);
});

test("reducer: lifecycle-update replaces only the updated project's slice", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("lifecycle-update", {
    repo: "o/a",
    pairs: [{ issue: { number: 1, title: "A1", state: "open" }, pr: null, prPhase: "absent" }],
  }));
  s = dashboardReducer(s, makeEvent("lifecycle-update", {
    repo: "o/b",
    pairs: [{ issue: { number: 9, title: "B9", state: "open" }, pr: null, prPhase: "absent" }],
  }));
  // Re-update only o/a — o/b's slice must survive.
  s = dashboardReducer(s, makeEvent("lifecycle-update", {
    repo: "o/a",
    pairs: [
      { issue: { number: 1, title: "A1", state: "open" }, pr: null, prPhase: "absent" },
      { issue: { number: 2, title: "A2", state: "open" }, pr: null, prPhase: "planning" },
    ],
  }));
  assert.equal(s.lifecycleByRepo.get("o/a")?.length, 2);
  assert.equal(s.lifecycleByRepo.get("o/b")?.length, 1, "o/b slice preserved");
  assert.equal(s.lastLifecyclePairs.length, 3);
});

test("reducer: snapshot-update sums session counts across projects", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("snapshot-update", { repo: "o/a", sessionCount: 2, issueCount: 1, prCount: 0 }));
  assert.equal(s.sessionCount, 2);
  s = dashboardReducer(s, makeEvent("snapshot-update", { repo: "o/b", sessionCount: 3, issueCount: 1, prCount: 0 }));
  assert.equal(s.sessionCount, 5, "sessions summed across projects");
  // Updating one project re-sums rather than double-counting.
  s = dashboardReducer(s, makeEvent("snapshot-update", { repo: "o/a", sessionCount: 0, issueCount: 1, prCount: 0 }));
  assert.equal(s.sessionCount, 3);
});

test("reducer: broadcast events carry their project repo", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("broadcast-commit", {
    repo: "o/a", hash: "abc1234", author: "Dev", stateBefore: "x", changeHow: "y", stateAfter: "z",
  }));
  const item = s.broadcastQueue[s.broadcastQueue.length - 1];
  assert.equal(item?.repo, "o/a");
});

test("reducer: log-message carries its project repo onto the event line", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("log-message", { level: "info", message: "hello", repo: "o/a" }));
  const line = s.eventStream[s.eventStream.length - 1];
  assert.equal(line?.repo, "o/a");
});

// ── work-hold (issue #243) ────────────────────────────────────────────────────

test("reducer: work-hold records the global hold and logs it once", () => {
  const untilMs = Date.now() + 2 * 60 * 60 * 1000;
  let s = initialState();
  assert.equal(s.hold, null, "no hold to start with");

  s = dashboardReducer(s, makeEvent("work-hold", {
    kind: "claude-usage-limit",
    reason: "Claude usage limit",
    untilMs,
  }));
  assert.deepEqual(s.hold, { kind: "claude-usage-limit", reason: "Claude usage limit", untilMs });
  const logged = s.eventStream.filter((l) => l.text.includes("Waiting"));
  assert.equal(logged.length, 1, "one log line for the hold");
  assert.match(logged[0]!.text, /for Claude usage limit$/);
  assert.equal(logged[0]!.level, "warning");

  // A reconnecting browser replays the cached event; it must not re-log it.
  s = dashboardReducer(s, makeEvent("work-hold", {
    kind: "claude-usage-limit",
    reason: "Claude usage limit",
    untilMs,
  }));
  assert.equal(s.eventStream.filter((l) => l.text.includes("Waiting")).length, 1);
});

test("reducer: work-hold ignores a deadline that has already passed", () => {
  const s = dashboardReducer(initialState(), makeEvent("work-hold", {
    kind: "claude-usage-limit",
    reason: "Claude usage limit",
    untilMs: Date.now() - 1,
  }));
  assert.equal(s.hold, null, "a lapsed hold must never show a waiting banner");
});

test("reducer: work-hold-cleared drops the hold and says work resumed", () => {
  let s = dashboardReducer(initialState(), makeEvent("work-hold", {
    kind: "github-rate-limit",
    reason: "GitHub rate limit \u00b7 o/r",
    untilMs: Date.now() + 60_000,
  }));
  s = dashboardReducer(s, makeEvent("work-hold-cleared", {}));
  assert.equal(s.hold, null);
  assert.equal(s.eventStream.at(-1)?.text, "\u25b6 Done waiting \u2014 resuming work");

  // Nothing to clear is not an event.
  const before = s.eventStream.length;
  s = dashboardReducer(s, makeEvent("work-hold-cleared", {}));
  assert.equal(s.eventStream.length, before);
});

test("reducer: a hold survives the engine-idle events every parked engine emits", () => {
  const untilMs = Date.now() + 90 * 60 * 1000;
  let s = dashboardReducer(initialState(), makeEvent("work-hold", {
    kind: "claude-usage-limit",
    reason: "Claude usage limit",
    untilMs,
  }));
  for (let engineIndex = 0; engineIndex < 3; engineIndex += 1) {
    s = dashboardReducer(s, makeEvent("engine-idle", {
      engineIndex,
      reason: "claude-usage-limit",
      rateLimitedUntilMs: untilMs,
      nextCycleAtMs: untilMs,
    }));
  }
  assert.deepEqual(s.hold, { kind: "claude-usage-limit", reason: "Claude usage limit", untilMs });
  for (const cyl of s.cylinders) {
    assert.equal(cyl.rateLimitedUntilMs, untilMs, "each cylinder also shows what it waits on");
    assert.equal(cyl.idleStatusText, "claude-usage-limit");
  }
});

// ── usage-update (issue #254) ─────────────────────────────────────────────────

test("reducer: usage starts unknown until the first reading arrives", () => {
  assert.equal(initialState().usage, null);
});

test("reducer: usage-update stores the latest reading without logging it", () => {
  const resetsAtMs = Date.now() + 2 * 60 * 60 * 1000;
  let s = dashboardReducer(initialState(), makeEvent("usage-update", {
    status: "ok",
    fiveHourPercent: 37,
    resetsAtMs,
    fetchedAtMs: 1_000,
    reason: "",
  }));
  assert.deepEqual(s.usage, { status: "ok", fiveHourPercent: 37, resetsAtMs, fetchedAtMs: 1_000, reason: "" });

  // A new reading every minute only moves the gauge — never the event log.
  s = dashboardReducer(s, makeEvent("usage-update", {
    status: "ok",
    fiveHourPercent: 41,
    resetsAtMs,
    fetchedAtMs: 61_000,
    reason: "",
  }));
  assert.equal(s.usage?.fiveHourPercent, 41);
  assert.equal(s.eventStream.length, 0);
  assert.equal(s.eventCount, 0);
});

test("reducer: usage-update keeps the gauge's unconfigured and unavailable states", () => {
  let s = dashboardReducer(initialState(), makeEvent("usage-update", {
    status: "unconfigured",
    fiveHourPercent: null,
    resetsAtMs: null,
    fetchedAtMs: 1_000,
    reason: "set anthropic_usage_token in env.yaml to show live Claude usage",
  }));
  assert.equal(s.usage?.status, "unconfigured");
  assert.match(s.usage?.reason ?? "", /anthropic_usage_token/);

  s = dashboardReducer(s, makeEvent("usage-update", {
    status: "unavailable",
    fiveHourPercent: null,
    resetsAtMs: null,
    fetchedAtMs: 2_000,
    reason: "Anthropic is rate-limiting usage reads (HTTP 429)",
  }));
  assert.deepEqual(s.usage, {
    status: "unavailable",
    fiveHourPercent: null,
    resetsAtMs: null,
    fetchedAtMs: 2_000,
    reason: "Anthropic is rate-limiting usage reads (HTTP 429)",
  });
});

test("reducer: a failed usage-update that holds the last good numbers keeps them on the gauge (#261)", () => {
  const resetsAtMs = Date.now() + 2 * 60 * 60 * 1000;
  let s = dashboardReducer(initialState(), makeEvent("usage-update", {
    status: "ok", fiveHourPercent: 15, resetsAtMs, fetchedAtMs: 1_000, reason: "",
  }));
  s = dashboardReducer(s, makeEvent("usage-update", {
    status: "unavailable",
    fiveHourPercent: 15,
    resetsAtMs,
    fetchedAtMs: 61_000,
    reason: "Anthropic is overloaded (HTTP 529)",
    heldFromMs: 1_000,
  }));
  assert.deepEqual(s.usage, {
    status: "unavailable",
    fiveHourPercent: 15,
    resetsAtMs,
    fetchedAtMs: 61_000,
    reason: "Anthropic is overloaded (HTTP 529)",
    heldFromMs: 1_000,
  });
});

test("reducer: heldFromMs is dropped from readings that hold nothing over", () => {
  const ok = dashboardReducer(initialState(), makeEvent("usage-update", {
    status: "ok", fiveHourPercent: 15, resetsAtMs: null, fetchedAtMs: 1_000, reason: "", heldFromMs: 500,
  }));
  assert.ok(ok.usage !== null && !("heldFromMs" in ok.usage));

  const noNumbers = dashboardReducer(initialState(), makeEvent("usage-update", {
    status: "unavailable", fiveHourPercent: null, resetsAtMs: 5_000, fetchedAtMs: 1_000, reason: "x", heldFromMs: 500,
  }));
  assert.equal(noNumbers.usage?.resetsAtMs, null);
  assert.ok(noNumbers.usage !== null && !("heldFromMs" in noNumbers.usage));

  const numbersWithoutHold = dashboardReducer(initialState(), makeEvent("usage-update", {
    status: "unavailable", fiveHourPercent: 15, resetsAtMs: 5_000, fetchedAtMs: 1_000, reason: "x",
  }));
  assert.equal(numbersWithoutHold.usage?.fiveHourPercent, null);
  assert.equal(numbersWithoutHold.usage?.resetsAtMs, null);

  const unconfigured = dashboardReducer(initialState(), makeEvent("usage-update", {
    status: "unconfigured", fiveHourPercent: 15, resetsAtMs: 5_000, fetchedAtMs: 1_000, reason: "x", heldFromMs: 500,
  }));
  assert.equal(unconfigured.usage?.fiveHourPercent, null);
  assert.ok(unconfigured.usage !== null && !("heldFromMs" in unconfigured.usage));
});

test("DashboardStore.bootstrap() restores held usage numbers from the replayed reading", async () => {
  const resetsAtMs = Date.now() + 2 * 60 * 60 * 1000;
  const usageEvent = makeEvent("usage-update", {
    status: "unavailable",
    fiveHourPercent: 15,
    resetsAtMs,
    fetchedAtMs: 61_000,
    reason: "Anthropic is overloaded (HTTP 529)",
    heldFromMs: 1_000,
  });
  await withMockFetch({ ...MOCK_STATE_RESPONSE, cachedEvents: [usageEvent] }, async () => {
    const store = new DashboardStore();
    await store.bootstrap();
    assert.equal(store.getState().usage?.fiveHourPercent, 15);
    assert.equal(store.getState().usage?.heldFromMs, 1_000);
  });
});

test("reducer: a malformed usage-update degrades to unavailable rather than a bogus number", () => {
  const unknownStatus = dashboardReducer(initialState(), makeEvent("usage-update", {
    status: "bogus",
    fiveHourPercent: 50,
    fetchedAtMs: 1_000,
  }));
  assert.equal(unknownStatus.usage?.status, "unavailable");
  assert.equal(unknownStatus.usage?.fiveHourPercent, null);

  const okWithoutNumber = dashboardReducer(initialState(), makeEvent("usage-update", {
    status: "ok",
    fiveHourPercent: "37",
    resetsAtMs: "soon",
    fetchedAtMs: 1_000,
  }));
  assert.equal(okWithoutNumber.usage?.status, "unavailable");
  assert.equal(okWithoutNumber.usage?.fiveHourPercent, null);
  assert.equal(okWithoutNumber.usage?.resetsAtMs, null);
  assert.equal(okWithoutNumber.usage?.reason, "");
});

// ── pills being worked by an engine cylinder (issue #262) ─────────────────────

function pillFor(s: DashboardState, issueNumber: number, repo?: string) {
  const pair = s.lastLifecyclePairs.find((p) => p.issue?.number === issueNumber && (repo === undefined || p.repo === repo));
  assert.ok(pair, `pill for issue #${issueNumber} should exist`);
  return pair;
}

function withPills(s: DashboardState, repo: string, pairs: unknown[]): DashboardState {
  return dashboardReducer(s, makeEvent("lifecycle-update", { repo, pairs }));
}

test("workingCylinder: a pill is worked only while a cylinder is running an action on its issue", () => {
  let s = withPills(initialState(), "o/a", [
    { issue: { number: 7, title: "Seven", state: "open" }, pr: null, prPhase: "planning" },
    { issue: { number: 8, title: "Eight", state: "open" }, pr: null, prPhase: "absent" },
  ]);
  assert.equal(workingCylinder(pillFor(s, 7), s.cylinders), null, "nothing is working anything yet");

  s = dashboardReducer(s, makeEvent("action-start", {
    actionIndex: 2, totalActions: 3, type: "start-implementation", issueNumber: 7, repo: "o/a", description: "d",
  }));
  assert.equal(workingCylinder(pillFor(s, 7), s.cylinders)?.index, 2, "engine 2 is working issue #7");
  assert.equal(workingCylinder(pillFor(s, 8), s.cylinders), null, "issue #8 is untouched");
});

test("workingCylinder: a cylinder that finished, failed or went idle no longer works the pill", () => {
  const start = makeEvent("action-start", {
    actionIndex: 1, totalActions: 3, type: "start-implementation", issueNumber: 7, repo: "o/a", description: "d",
  });
  const base = dashboardReducer(withPills(initialState(), "o/a", [
    { issue: { number: 7, title: "Seven", state: "open" }, pr: null, prPhase: "planning" },
  ]), start);
  assert.ok(workingCylinder(pillFor(base, 7), base.cylinders));

  const done = dashboardReducer(base, makeEvent("action-complete", { actionIndex: 1, totalActions: 3, repo: "o/a" }));
  assert.equal(done.cylinders[0]?.issueNumber, 7, "a done cylinder still remembers its issue");
  assert.equal(workingCylinder(pillFor(done, 7), done.cylinders), null, "but is not working it");

  const failed = dashboardReducer(base, makeEvent("action-error", { actionIndex: 1, totalActions: 3, error: "boom" }));
  assert.equal(workingCylinder(pillFor(failed, 7), failed.cylinders), null);

  const idle = dashboardReducer(base, makeEvent("engine-idle", { engineIndex: 0, reason: "done" }));
  assert.equal(workingCylinder(pillFor(idle, 7), idle.cylinders), null);

  const shutdown = dashboardReducer(base, makeEvent("engine-shutdown", { engineIndex: 0 }));
  assert.equal(workingCylinder(pillFor(shutdown, 7), shutdown.cylinders), null);
});

test("workingCylinder: a cylinder working the pill's PR without an issue number still works the pill", () => {
  let s = withPills(initialState(), "o/a", [
    {
      issue: { number: 7, title: "Seven", state: "open" },
      pr: { number: 30, title: "Fix seven", state: "open" },
      prPhase: "active",
    },
    { issue: null, pr: { number: 31, title: "Orphan", state: "open" }, prPhase: "active" },
  ]);
  s = dashboardReducer(s, makeEvent("action-start", {
    actionIndex: 1, totalActions: 3, type: "self-review", issueNumber: null, pullRequestNumber: 30, repo: "o/a", description: "d",
  }));
  s = dashboardReducer(s, makeEvent("action-start", {
    actionIndex: 3, totalActions: 3, type: "resolve-conflicts", pullRequestNumber: 31, repo: "o/a", description: "d",
  }));

  assert.equal(workingCylinder(pillFor(s, 7), s.cylinders)?.index, 1, "matched through PR #30");
  const orphan = s.lastLifecyclePairs.find((p) => p.pr?.number === 31);
  assert.ok(orphan);
  assert.equal(workingCylinder(orphan, s.cylinders)?.index, 3, "an issue-less pill is matched through its PR");
});

test("workingCylinder: projects sharing the dashboard never light each other's pills", () => {
  let s = withPills(initialState(), "o/a", [
    { issue: { number: 1, title: "A1", state: "open" }, pr: null, prPhase: "planning" },
  ]);
  s = withPills(s, "o/b", [
    { issue: { number: 1, title: "B1", state: "open" }, pr: null, prPhase: "absent" },
  ]);
  s = dashboardReducer(s, makeEvent("action-start", {
    actionIndex: 1, totalActions: 3, type: "start-implementation", issueNumber: 1, repo: "o/a", description: "d",
  }));

  assert.equal(workingCylinder(pillFor(s, 1, "o/a"), s.cylinders)?.index, 1);
  assert.equal(workingCylinder(pillFor(s, 1, "o/b"), s.cylinders), null, "same issue number, other project");
});

test("workingCylinder: matches by number when either side does not know its project", () => {
  // Single-project setups may emit lifecycle updates or actions without a repo.
  let s = withPills(initialState(), "", [
    { issue: { number: 4, title: "Four", state: "open" }, pr: null, prPhase: "planning" },
  ]);
  s = dashboardReducer(s, makeEvent("action-start", {
    actionIndex: 1, totalActions: 3, type: "start-implementation", issueNumber: 4, repo: "o/a", description: "d",
  }));
  assert.equal(workingCylinder(pillFor(s, 4), s.cylinders)?.index, 1);
});

// ── what each pill is doing or waiting on (issue #262) ────────────────────────

function prPill(prNumber: number, overrides: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) {
  return {
    issue: { number: prNumber - 20, title: `Issue for PR ${prNumber}`, state: "open" },
    pr: { number: prNumber, title: `PR ${prNumber}`, state: "open", draft: false, checksStatus: "success", ...pr },
    prPhase: "review",
    ...overrides,
  };
}

function pillForPR(s: DashboardState, prNumber: number) {
  const pair = s.lastLifecyclePairs.find((p) => p.pr?.number === prNumber);
  assert.ok(pair, `pill for PR #${prNumber} should exist`);
  return pair;
}

test("waitingOnChecks: an open PR whose checks are queued or running is waiting on GitHub Actions", () => {
  const s = withPills(initialState(), "o/a", [
    prPill(30, {}, { checksStatus: "pending" }),
    prPill(31, { prPhase: "active" }, { draft: true, checksStatus: "pending" }),
    { issue: null, pr: { number: 32, title: "Orphan", state: "open", checksStatus: "pending" }, prPhase: "review" },
  ]);
  assert.equal(waitingOnChecks(pillForPR(s, 30)), true, "a ready PR");
  assert.equal(waitingOnChecks(pillForPR(s, 31)), true, "a draft PR");
  assert.equal(waitingOnChecks(pillForPR(s, 32)), true, "an issue-less PR");
});

test("waitingOnChecks: finished, absent or irrelevant checks are not waited on", () => {
  const s = withPills(initialState(), "o/a", [
    prPill(30, {}, { checksStatus: "success" }),
    prPill(31, {}, { checksStatus: "failure" }),
    prPill(32, {}, { checksStatus: "none" }),
    prPill(33, {}, { checksStatus: undefined }),
    prPill(34, { prPhase: "completed" }, { checksStatus: "pending" }),
    prPill(35, {}, { state: "closed", checksStatus: "pending" }),
    { issue: { number: 9, title: "Nine", state: "open" }, pr: null, prPhase: "planning" },
  ]);
  for (const n of [30, 31, 32, 33]) {
    assert.equal(waitingOnChecks(pillForPR(s, n)), false, `PR #${n}: checks are not running`);
  }
  assert.equal(waitingOnChecks(pillForPR(s, 34)), false, "a merged PR waits on nothing");
  assert.equal(waitingOnChecks(pillForPR(s, 35)), false, "a closed PR waits on nothing");
  assert.equal(waitingOnChecks(pillFor(s, 9)), false, "no PR, no checks");
});

test("pillActivity: each state gets its own activity, and pills in none of them get none", () => {
  let s = withPills(initialState(), "o/a", [
    prPill(30),
    prPill(31, {}, { checksStatus: "pending" }),
    prPill(32, { disabled: true }),
    prPill(33, { prPhase: "active" }, { draft: true }),
    prPill(34, { prPhase: "completed" }),
    { issue: { number: 1, title: "Planned", state: "open" }, pr: null, prPhase: "planning" },
    { issue: { number: 2, title: "Untouched", state: "open" }, pr: null, prPhase: "absent" },
    { issue: { number: 3, title: "Backlog", state: "open" }, pr: null, prPhase: "inactive", projectStatus: "Backlog" },
    { issue: { number: 4, title: "Blocked", state: "open" }, pr: null, prPhase: "absent", blockedByIssueNumbers: [2] },
    { issue: { number: 5, title: "Implementing", state: "open" }, pr: null, prPhase: "planning" },
  ]);
  s = dashboardReducer(s, makeEvent("action-start", {
    actionIndex: 1, totalActions: 3, type: "start-implementation", issueNumber: 5, repo: "o/a", description: "d",
  }));

  assert.equal(pillActivity(pillFor(s, 5), s.cylinders), "working");
  assert.equal(pillActivity(pillForPR(s, 30), s.cylinders), "review");
  assert.equal(pillActivity(pillForPR(s, 31), s.cylinders), "waiting-ci");
  assert.equal(pillActivity(pillForPR(s, 32), s.cylinders), "manual");
  assert.equal(pillActivity(pillForPR(s, 33), s.cylinders), null, "a draft with nothing running");
  assert.equal(pillActivity(pillForPR(s, 34), s.cylinders), null, "merged");
  for (const n of [1, 2, 3, 4]) {
    assert.equal(pillActivity(pillFor(s, n), s.cylinders), null, `issue #${n} has no activity`);
  }
});

test("pillActivity: a working cylinder beats every other state", () => {
  // Checks that ran too long are handed to a cylinder while still pending.
  let s = withPills(initialState(), "o/a", [
    prPill(30, {}, { checksStatus: "pending" }),
    prPill(31, { disabled: true }, { checksStatus: "pending" }),
    prPill(32),
  ]);
  for (const [actionIndex, pullRequestNumber] of [[1, 30], [2, 31], [3, 32]] as const) {
    s = dashboardReducer(s, makeEvent("action-start", {
      actionIndex, totalActions: 3, type: "address-failing-checks", pullRequestNumber, repo: "o/a", description: "d",
    }));
  }
  for (const n of [30, 31, 32]) {
    assert.equal(pillActivity(pillForPR(s, n), s.cylinders), "working", `PR #${n}`);
  }
});

test("pillActivity: a manual PR is manual whatever its checks or phase say", () => {
  const s = withPills(initialState(), "o/a", [
    prPill(30, { disabled: true }, { checksStatus: "pending" }),
    prPill(31, { disabled: true, prPhase: "active" }, { draft: true }),
  ]);
  assert.equal(pillActivity(pillForPR(s, 30), s.cylinders), "manual");
  assert.equal(pillActivity(pillForPR(s, 31), s.cylinders), "manual");
});

test("pillActivity: follows a PR through its checks, an engine's action and review", () => {
  const pill = (checksStatus: string) => withPills(initialState(), "o/a", [prPill(30, {}, { checksStatus })]);
  let s = pill("pending");
  assert.equal(pillActivity(pillForPR(s, 30), s.cylinders), "waiting-ci", "checks queued after a push");

  s = withPills(s, "o/a", [prPill(30, {}, { checksStatus: "success" })]);
  assert.equal(pillActivity(pillForPR(s, 30), s.cylinders), "review", "checks passed");

  s = dashboardReducer(s, makeEvent("action-start", {
    actionIndex: 2, totalActions: 3, type: "self-review", pullRequestNumber: 30, repo: "o/a", description: "d",
  }));
  assert.equal(pillActivity(pillForPR(s, 30), s.cylinders), "working", "an engine picks it up");

  s = withPills(s, "o/a", [prPill(30, {}, { checksStatus: "pending" })]);
  assert.equal(pillActivity(pillForPR(s, 30), s.cylinders), "working", "its push restarted the checks mid-action");

  s = dashboardReducer(s, makeEvent("action-complete", { actionIndex: 2, totalActions: 3, repo: "o/a" }));
  assert.equal(pillActivity(pillForPR(s, 30), s.cylinders), "waiting-ci", "the engine is done; now it waits on CI");
});

// ── dimming every pill no engine is working (issue #262) ──────────────────────

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

/** The classes on a pill rendered for `pair` the way the lifecycle list renders it. */
function renderedPillClasses(s: DashboardState, pair: LifecyclePair): string[] {
  const pill = new LifecyclePill();
  Object.assign(pill, { pair, activity: pillActivity(pair, s.cylinders) });
  const match = /class="(lifecycle-pill\b[^"]*)"/.exec(flatten(pill.render()));
  assert.ok(match, "the pill renders its outer element");
  return match[1]!.split(/\s+/);
}

test("lifecycle pill: the stylesheet dims every pill without the working class", () => {
  const css = LifecyclePill.styles.toString().replace(/\s+/g, " ");
  const rule = /\.lifecycle-pill:not\(\.working\) \{ opacity: ([\d.]+); \}/.exec(css);
  assert.ok(rule, "a pill no engine is working is rendered at a lowered opacity");
  const opacity = Number(rule[1]);
  assert.ok(opacity > 0 && opacity < 1, `dimmed, not hidden (opacity ${opacity})`);
});

test("lifecycle pill: only the pills an engine is working stay undimmed, whatever their phase or icon", () => {
  let s = withPills(initialState(), "o/a", [
    { issue: { number: 5, title: "Implementing", state: "open" }, pr: null, prPhase: "planning" },
    prPill(30),
    { issue: null, pr: { number: 40, title: "Orphan", state: "open", draft: false, checksStatus: "pending" }, prPhase: "review" },
    prPill(31),
    prPill(32, {}, { checksStatus: "pending" }),
    prPill(33, { disabled: true }),
    prPill(34, { prPhase: "completed" }),
    prPill(35, { prPhase: "active" }, { draft: true }),
    { issue: { number: 2, title: "Untouched", state: "open" }, pr: null, prPhase: "absent" },
    { issue: { number: 3, title: "Backlog", state: "open" }, pr: null, prPhase: "inactive", projectStatus: "Backlog" },
    { issue: { number: 4, title: "Blocked", state: "open" }, pr: null, prPhase: "absent", blockedByIssueNumbers: [2] },
    { issue: { number: 6, title: "Finished", state: "open" }, pr: null, prPhase: "planning" },
  ]);
  s = dashboardReducer(s, makeEvent("action-start", {
    actionIndex: 1, totalActions: 4, type: "start-implementation", issueNumber: 5, repo: "o/a", description: "d",
  }));
  s = dashboardReducer(s, makeEvent("action-start", {
    actionIndex: 2, totalActions: 4, type: "self-review", pullRequestNumber: 30, repo: "o/a", description: "d",
  }));
  s = dashboardReducer(s, makeEvent("action-start", {
    actionIndex: 3, totalActions: 4, type: "address-failing-checks", pullRequestNumber: 40, repo: "o/a", description: "d",
  }));
  s = dashboardReducer(s, makeEvent("action-start", {
    actionIndex: 4, totalActions: 4, type: "start-implementation", issueNumber: 6, repo: "o/a", description: "d",
  }));
  s = dashboardReducer(s, makeEvent("action-complete", { actionIndex: 4, totalActions: 4, repo: "o/a" }));

  const worked = [pillFor(s, 5), pillForPR(s, 30), pillForPR(s, 40)];
  for (const pair of worked) {
    const classes = renderedPillClasses(s, pair);
    assert.ok(classes.includes("working"), `#${pair.issue?.number ?? pair.pr?.number} is worked: full opacity`);
  }

  const idle = [
    pillForPR(s, 31), pillForPR(s, 32), pillForPR(s, 33), pillForPR(s, 34), pillForPR(s, 35),
    pillFor(s, 2), pillFor(s, 3), pillFor(s, 4), pillFor(s, 6),
  ];
  for (const pair of idle) {
    const classes = renderedPillClasses(s, pair);
    assert.ok(!classes.includes("working"), `#${pair.issue?.number ?? pair.pr?.number} is not worked: dimmed`);
  }
});

// ── every pill going dark at shutdown (issue #268) ────────────────────────────

test("pillsDark: every pill goes dark once a shutdown is requested, and stays dark", () => {
  let s = withPills(initialState(), "o/a", [
    { issue: { number: 5, title: "Implementing", state: "open" }, pr: null, prPhase: "planning" },
    prPill(30),
  ]);
  s = dashboardReducer(s, makeEvent("action-start", {
    actionIndex: 1, totalActions: 3, type: "start-implementation", issueNumber: 5, repo: "o/a", description: "d",
  }));
  assert.equal(pillsDark(s), false, "yoke is running");

  s = dashboardReducer(s, makeEvent("shutdown-requested", {}));
  assert.equal(pillsDark(s), true, "dark at once, while in-flight work still finishes");

  s = dashboardReducer(s, makeEvent("action-complete", { actionIndex: 1, totalActions: 3, repo: "o/a" }));
  s = dashboardReducer(s, makeEvent("engine-shutdown", { engineIndex: 0 }));
  s = withPills(s, "o/a", [
    { issue: { number: 5, title: "Implementing", state: "open" }, pr: null, prPhase: "planning" },
    prPill(30),
  ]);
  assert.equal(pillsDark(s), true, "a later lifecycle update does not bring the pills back to life");

  s = dashboardReducer(s, makeEvent("app-shutdown", {}));
  assert.equal(pillsDark(s), true);
});

test("pillsDark: a dashboard that only hears app-shutdown still goes dark", () => {
  const s = dashboardReducer(initialState(), makeEvent("app-shutdown", {}));
  assert.equal(s.shutdownRequested, false);
  assert.equal(pillsDark(s), true);
});

test("frozenPillActivity: a dark pill's status icon stays frozen as it was while the engines drain", () => {
  let s = withPills(initialState(), "o/a", [prPill(30, {}, { checksStatus: "pending" }), prPill(31)]);
  s = dashboardReducer(s, makeEvent("action-start", {
    actionIndex: 1, totalActions: 3, type: "self-review", pullRequestNumber: 31, repo: "o/a", description: "d",
  }));
  assert.equal(s.frozenPillActivity, null, "nothing is frozen while yoke is running");

  s = dashboardReducer(s, makeEvent("shutdown-requested", {}));
  assert.equal(pillsDark(s), true);
  assert.equal(s.frozenPillActivity?.get(pillKey(pillForPR(s, 30))), "waiting-ci");
  assert.equal(s.frozenPillActivity?.get(pillKey(pillForPR(s, 31))), "working");

  // The in-flight action finishes, its engine retires, and a last lifecycle
  // update says the checks passed: live, both pills would now show the
  // review eye, but the dark pills keep the icons they had.
  s = dashboardReducer(s, makeEvent("action-complete", { actionIndex: 1, totalActions: 3, repo: "o/a" }));
  s = dashboardReducer(s, makeEvent("engine-shutdown", { engineIndex: 0 }));
  s = withPills(s, "o/a", [prPill(30, {}, { checksStatus: "success" }), prPill(31)]);
  assert.equal(pillActivity(pillForPR(s, 30), s.cylinders), "review", "live, the checks are done");
  assert.equal(pillActivity(pillForPR(s, 31), s.cylinders), "review", "live, nothing is working it anymore");
  s = dashboardReducer(s, makeEvent("app-shutdown", {}));
  assert.equal(s.frozenPillActivity?.get(pillKey(pillForPR(s, 30))), "waiting-ci");
  assert.equal(s.frozenPillActivity?.get(pillKey(pillForPR(s, 31))), "working");
});

test("frozenPillActivity: a pill first seen after the pills went dark is frozen as it appears", () => {
  let s = withPills(initialState(), "o/a", [prPill(30, {}, { checksStatus: "pending" })]);
  s = dashboardReducer(s, makeEvent("shutdown-requested", {}));
  // Another project's first lifecycle update (or a reconnecting dashboard's
  // replay) arrives only after the shutdown request.
  s = withPills(s, "o/b", [prPill(40, {}, { checksStatus: "pending" })]);
  assert.equal(s.frozenPillActivity?.get(pillKey(pillForPR(s, 40))), "waiting-ci");

  // Its checks then pass, but it keeps the icon it went dark with, and the
  // pill frozen before it is left as it was.
  s = withPills(s, "o/b", [prPill(40)]);
  s = withPills(s, "o/a", [prPill(30)]);
  assert.equal(s.frozenPillActivity?.get(pillKey(pillForPR(s, 40))), "waiting-ci");
  assert.equal(s.frozenPillActivity?.get(pillKey(pillForPR(s, 30))), "waiting-ci");
});

test("frozenPillActivity: a dashboard that only hears app-shutdown freezes the pills then", () => {
  let s = withPills(initialState(), "o/a", [prPill(30, {}, { checksStatus: "pending" })]);
  s = dashboardReducer(s, makeEvent("app-shutdown", {}));
  assert.equal(s.frozenPillActivity?.get(pillKey(pillForPR(s, 30))), "waiting-ci");
});

test("lifecycle pill: a dark pill renders dimmed and still, keeping its frozen icon", () => {
  let s = withPills(initialState(), "o/a", [
    { issue: { number: 5, title: "Implementing", state: "open" }, pr: null, prPhase: "planning" },
    prPill(30, {}, { checksStatus: "pending" }),
  ]);
  s = dashboardReducer(s, makeEvent("action-start", {
    actionIndex: 1, totalActions: 1, type: "start-implementation", issueNumber: 5, repo: "o/a", description: "d",
  }));
  s = dashboardReducer(s, makeEvent("shutdown-requested", {}));

  const render = (pair: LifecyclePair) => {
    const pill = new LifecyclePill();
    Object.assign(pill, { pair, activity: s.frozenPillActivity?.get(pillKey(pair)) ?? null, dark: pillsDark(s) });
    return flatten(pill.render());
  };

  const worked = render(pillFor(s, 5));
  const classes = /class="(lifecycle-pill\b[^"]*)"/.exec(worked)![1]!.split(/\s+/);
  assert.ok(classes.includes("shutdown"), "dark");
  assert.ok(!classes.includes("working"), "no working pulse, though an engine was on it");
  assert.ok(worked.includes("shut down") && !worked.includes("implementing…"), "the planned PR half reads shut down");
  assert.ok(worked.includes('class="meteor"'), "the meteor stays, frozen");

  const waiting = render(pillForPR(s, 30));
  assert.ok(waiting.includes("lifecycle-pill shutdown has-status"), "dark, with its icon");
  assert.ok(waiting.includes('class="hourglass"'), "the hourglass stays, frozen");

  const css = LifecyclePill.styles.toString().replace(/\s+/g, " ");
  assert.match(css, /\.lifecycle-pill\.shutdown \{ opacity: 0\.5; \}/, "the shut-down cylinder row's opacity");
  assert.match(css, /\.lifecycle-pill\.shutdown \.pill-issue-half \{ border-left-color: #ff6600; \}/, "and its orange accent");
  assert.match(css, /\.lifecycle-pill\.shutdown \.pill-status \* \{ animation-play-state: paused; \}/, "icons freeze in place");
});

// ── action-start carries issue/PR titles for unlisted-work pills ──────────────

test("reducer: action-start stores the worked issue and PR titles on the cylinder", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("action-start", {
    actionIndex: 1, totalActions: 1, type: "address-failing-checks",
    issueNumber: 402, pullRequestNumber: 404,
    issueTitle: "Never lapse an approval", pullRequestTitle: "Fix approvals", description: "d",
  }));
  assert.equal(s.cylinders[0]?.issueTitle, "Never lapse an approval");
  assert.equal(s.cylinders[0]?.prTitle, "Fix approvals");

  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 1, totalActions: 1, type: "start-implementation", issueNumber: 7, description: "d" }));
  assert.equal(s.cylinders[0]?.issueTitle, null, "an action without titles leaves none behind");
  assert.equal(s.cylinders[0]?.prTitle, null);
});

test("reducer: engine-idle clears the worked titles", () => {
  let s = initialState();
  s = dashboardReducer(s, makeEvent("action-start", { actionIndex: 1, totalActions: 1, type: "start-implementation", issueNumber: 7, issueTitle: "t", description: "d" }));
  assert.equal(s.cylinders[0]?.issueTitle, "t");
  s = dashboardReducer(s, makeEvent("engine-idle", { engineIndex: 0, reason: "nothing to do this cycle" }));
  assert.equal(s.cylinders[0]?.issueTitle, null);
});

// ── times in the viewer's time zone (issue #272) ────────────────────────────────

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

function eventAt(atMs: number, type: string, data: Record<string, unknown> = {}): WireEvent {
  return { type, timestamp: new Date(atMs).toISOString(), data };
}

test("reducer: an event-stream line keeps its event's own instant, not when the browser saw it", () => {
  // A replayed cached event, or one that arrives late, is stamped with when it
  // happened; the line is drawn from that instant in the viewer's zone.
  const atMs = Date.parse("2026-10-18T22:45:07Z");
  let s = dashboardReducer(initialState(), eventAt(atMs, "log-message", { level: "info", message: "hello" }));
  s = dashboardReducer(s, eventAt(atMs + 1_000, "action-start", { actionIndex: 1, totalActions: 1, type: "t", issueNumber: 7, description: "d" }));
  s = dashboardReducer(s, eventAt(atMs + 2_000, "shutdown-requested"));
  assert.deepEqual(s.eventStream.map((line) => line.atMs), [atMs, atMs + 1_000, atMs + 2_000]);
});

test("reducer: a line whose event has no usable timestamp is stamped when it arrives", () => {
  const before = Date.now();
  const s = dashboardReducer(initialState(), { type: "log-message", timestamp: "", data: { message: "hello" } });
  const atMs = s.eventStream[0]!.atMs;
  assert.ok(atMs >= before && atMs <= Date.now());
});

test("reducer: broadcast cards keep their event's own instant", () => {
  const atMs = Date.parse("2026-10-18T22:45:07Z");
  let s = dashboardReducer(initialState(), eventAt(atMs, "broadcast-commit", { hash: "abc1234", stateAfter: "advanced" }));
  s = dashboardReducer(s, eventAt(atMs + 1_000, "workflow-approval", { runName: "CI", runId: "9" }));
  assert.deepEqual(s.broadcastQueue.map((card) => card.atMs), [atMs, atMs + 1_000]);
});

test("reducer: a server log line keeps the server's rendering of any time it names", () => {
  // Issue #272: log text stays as the server wrote it, even when it carries clockTimes.
  const untilMs = Date.parse("2026-10-18T22:45:00Z");
  const served = formatClockTime(untilMs, "America/New_York");
  const message = `⏸ waiting 2h until ${served} for Claude usage limit`;
  const s = asViewerIn("Asia/Tokyo", () => dashboardReducer(initialState(), makeEvent("log-message", {
    level: "info", message, clockTimes: [{ text: served, atMs: untilMs }],
  })));
  assert.equal(s.eventStream[0]?.text, message);
});

test("reducer: a usage reason with no usable clockTimes keeps the server's text", () => {
  const reason = "the Claude CLI login expired at Oct 18, 6:45 PM — claude renews it the next time it runs";
  for (const clockTimes of [undefined, "Oct 18, 6:45 PM", [null, { text: "Oct 18, 6:45 PM" }, { text: "Oct 18, 6:45 PM", atMs: Number.NaN }]]) {
    const s = asViewerIn("Asia/Tokyo", () => dashboardReducer(initialState(), makeEvent("usage-update", {
      status: "unavailable", fiveHourPercent: null, resetsAtMs: null, fetchedAtMs: 1_000, reason,
      ...(clockTimes !== undefined ? { clockTimes } : {}),
    })));
    assert.equal(s.usage?.reason, reason);
  }
});

test("reducer: the work-hold line names the deadline in the viewer's zone", () => {
  const untilMs = Date.now() + 2 * 60 * 60 * 1000;
  const s = asViewerIn("Asia/Tokyo", () => dashboardReducer(initialState(), makeEvent("work-hold", {
    kind: "claude-usage-limit", reason: "Claude usage limit", untilMs,
  })));
  assert.match(s.eventStream[0]?.text ?? "", new RegExp(` until ${formatClockTime(untilMs, "Asia/Tokyo")} for Claude usage limit$`));
});

test("reducer: a usage reason that names a time shows it in the viewer's zone", () => {
  const expiredAtMs = Date.parse("2026-10-18T22:45:00Z");
  const served = formatClockTime(expiredAtMs, "America/New_York");
  const s = asViewerIn("Asia/Tokyo", () => dashboardReducer(initialState(), makeEvent("usage-update", {
    status: "unavailable",
    fiveHourPercent: null,
    resetsAtMs: null,
    fetchedAtMs: 1_000,
    reason: `the Claude CLI login expired at ${served} — claude renews it the next time it runs`,
    clockTimes: [{ text: served, atMs: expiredAtMs }],
  })));
  assert.equal(
    s.usage?.reason,
    `the Claude CLI login expired at ${formatClockTime(expiredAtMs, "Asia/Tokyo")} — claude renews it the next time it runs`,
  );
});

test("DashboardStore.bootstrap() stamps replayed events with when they happened", async () => {
  const atMs = Date.parse("2026-10-18T22:45:07Z");
  await withMockFetch({ ...MOCK_STATE_RESPONSE, cachedEvents: [eventAt(atMs, "phase-update", { phase: "planning" })] }, async () => {
    const store = new DashboardStore();
    try {
      await store.bootstrap();
      assert.equal(store.getState().eventStream[0]?.atMs, atMs);
    } finally {
      store.disconnect();
    }
  });
});

// ── dashboard approvals (#276) ────────────────────────────────────────────────

function approvalEvent(repo: string, pullRequestNumber: number, state: string, extra: Record<string, unknown> = {}): WireEvent {
  return makeEvent("pull-request-approval", {
    repo, pullRequestNumber, requestedAt: "2026-10-28T23:21:15.000Z", state, ...extra,
  });
}

test("reducer: pull-request-approval fills and updates each PR's approval, keyed like the pill", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  let s = dashboardReducer(initialState(), approvalEvent("o/a", 10, "loading"));
  s = dashboardReducer(s, approvalEvent("o/a", 11, "waiting"));
  s = dashboardReducer(s, approvalEvent("o/b", 10, "refused", { reason: "its checks are failing" }));
  t.mock.timers.tick(5_000);
  const approved = approvalEvent("o/a", 10, "approved", { checksPending: true, alreadyApproved: false });
  s = dashboardReducer(s, approved);

  assert.deepEqual([...s.approvals.keys()].sort(), ["o/a#10", "o/a#11", "o/b#10"]);
  assert.deepEqual(s.approvals.get("o/a#10"), {
    repo: "o/a", pullRequestNumber: 10, requestedAt: "2026-10-28T23:21:15.000Z",
    state: "approved", checksPending: true, alreadyApproved: false,
    emittedAt: approved.timestamp, receivedAtMs: 1_005_000,
  });
  assert.equal(s.approvals.get("o/a#11")?.state, "waiting");
  assert.equal(s.approvals.get("o/b#10")?.reason, "its checks are failing", "another project's PR #10 is its own");
  assert.equal(s.approvals.get("o/a#11")?.receivedAtMs, 1_000_000, "the local time each arrived");
  assert.equal(s.eventStream.length, 0, "the event log has its own line for each step");
});

test("reducer: every arrival counts afresh, so a re-sent state answers a second press", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  let s = dashboardReducer(initialState(), approvalEvent("o/a", 10, "waiting"));
  t.mock.timers.tick(20_000);
  s = dashboardReducer(s, approvalEvent("o/a", 10, "waiting"));

  assert.equal(s.approvals.get("o/a#10")?.receivedAtMs, 1_020_000);
});

test("reducer: the same event replayed on a reconnect is not a new answer, so a refusal never comes back", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const refused = approvalEvent("o/a", 10, "refused", { reason: "its checks are failing" });
  const before = dashboardReducer(initialState(), refused);
  t.mock.timers.tick(30_000);
  const after = dashboardReducer(before, refused);

  assert.equal(after, before);
  assert.equal(after.approvals.get("o/a#10")?.receivedAtMs, 1_000_000, "it keeps the time it first arrived");
});

test("reducer: pull-request-approve, the relayed click itself, is still ignored", () => {
  const before = initialState();
  const after = dashboardReducer(before, makeEvent("pull-request-approve", { repo: "o/a", pullRequestNumber: 10 }));

  assert.equal(after, before);
});

test("reducer: a malformed pull-request-approval changes nothing", () => {
  const before = initialState();
  for (const data of [
    { repo: "o/a", state: "waiting" },
    { repo: "o/a", pullRequestNumber: "10", state: "waiting" },
    { repo: "o/a", pullRequestNumber: 10, state: "pondering" },
  ]) {
    assert.equal(dashboardReducer(before, makeEvent("pull-request-approval", data)), before);
  }
});

test("reducer: stale outcomes are dropped, approvals under way never", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  let s = dashboardReducer(initialState(), approvalEvent("o/a", 10, "refused", { reason: "it is not open" }));
  s = dashboardReducer(s, approvalEvent("o/a", 11, "failed", { reason: "GitHub said 502" }));
  s = dashboardReducer(s, approvalEvent("o/a", 12, "waiting"));
  t.mock.timers.tick(30_000);
  s = dashboardReducer(s, approvalEvent("o/a", 13, "approved"));
  t.mock.timers.tick(31_000);
  s = dashboardReducer(s, approvalEvent("o/a", 14, "loading"));

  assert.deepEqual([...s.approvals.keys()].sort(), ["o/a#12", "o/a#13", "o/a#14"]);
});

test("DashboardStore.bootstrap() on a reconnect keeps when each approval status first arrived", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const refused = approvalEvent("o/a", 10, "refused", { reason: "its checks are failing" });
  await withMockFetch({ ...MOCK_STATE_RESPONSE, cachedEvents: [refused] }, async () => {
    const store = new DashboardStore();
    try {
      store.applyEvent(refused);
      t.mock.timers.tick(59_000);
      await store.bootstrap();
      assert.equal(store.getState().approvals.get("o/a#10")?.receivedAtMs, 1_000_000, "the replay is an old answer");
      t.mock.timers.tick(1_000);
      await store.bootstrap();
      assert.equal(store.getState().approvals.has("o/a#10"), false, "so it goes stale on time, and never comes back");
    } finally {
      store.disconnect();
    }
  });
});

test("DashboardStore.bootstrap() restores an approval under way from the replayed cache", async () => {
  await withMockFetch(
    { ...MOCK_STATE_RESPONSE, cachedEvents: [approvalEvent("o/a", 10, "waiting")] },
    async () => {
      const store = new DashboardStore();
      try {
        await store.bootstrap();
        assert.equal(store.getState().approvals.get("o/a#10")?.state, "waiting", "a reloaded page still shows it");
      } finally {
        store.disconnect();
      }
    },
  );
});
