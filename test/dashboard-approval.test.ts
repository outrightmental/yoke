import test from "node:test";
import assert from "node:assert/strict";

import {
  DashboardApprovals,
  decideApproval,
  ENGINE_WORKING_REASON,
  SHUTTING_DOWN_REASON,
  type ApprovalDecision,
  type ApprovalSteps,
  type PullRequestApproval,
} from "../src/dashboard-approval.js";
import { EventEmitter } from "../src/event-emitter.js";
import { REVIEW_LABEL } from "../src/orchestrator.js";
import { PlanningMutex, pullRequestClaimKey } from "../src/scheduler.js";
import type { AgentSession, PullRequest, RepositorySnapshot } from "../src/types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function session(id: string, phase: AgentSession["phase"], updatedAt: string, status: AgentSession["status"] = "completed"): AgentSession {
  return { id, issueNumber: 1, pullRequestNumber: 10, phase, status, createdAt: updatedAt, updatedAt };
}

/** o/a PR #10 on issue #1, parked by the review label awaiting approval. */
function parkedSnapshot(pr: Partial<PullRequest> = {}, extraSessions: AgentSession[] = []): RepositorySnapshot {
  return {
    issues: [{
      number: 1, title: "Add the thing", body: "", state: "open", createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z", type: null, labels: [REVIEW_LABEL],
    }],
    pullRequests: [{
      number: 10, title: "Add the thing", body: "Closes #1", headSha: "sha-10", headRefName: "branch-10",
      baseRefName: "main", state: "open", draft: false, hasMergeConflicts: false, hasCleanReviewOnHead: false,
      unresolvedReviewCommentCount: 0, checksStatus: "success", pendingChecksStartedAt: undefined,
      createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z", labels: [REVIEW_LABEL],
      linkedIssueNumbers: [1], closingIssueNumbers: [1], ...pr,
    }],
    agentSessions: [session("s1", "request-review", "2024-01-02T00:00:00.000Z"), ...extraSessions],
  };
}

/** A session store holding `sessions`, which records new ones the way FileSessionStore does. */
function fakeSessionStore(sessions: AgentSession[]) {
  const store = {
    sessions: [...sessions],
    loads: 0,
    async load(): Promise<AgentSession[]> {
      store.loads += 1;
      return store.sessions.map((s) => ({ ...s }));
    },
    async createSession(input: { issueNumber?: number | undefined; pullRequestNumber?: number; phase: AgentSession["phase"]; status?: AgentSession["status"] }) {
      store.sessions.push({
        id: `new-${store.sessions.length}`,
        issueNumber: input.issueNumber,
        ...(input.pullRequestNumber !== undefined ? { pullRequestNumber: input.pullRequestNumber } : {}),
        phase: input.phase,
        status: input.status ?? "in_progress",
        createdAt: "2024-01-05T00:00:00.000Z",
        updatedAt: "2024-01-05T00:00:00.000Z",
      });
    },
  };
  return store;
}

function decide(
  snapshot: RepositorySnapshot,
  options: { claimed?: boolean; shuttingDown?: boolean; dryRun?: boolean; projectMode?: boolean; pullRequestNumber?: number } = {},
) {
  const sessionStore = fakeSessionStore(snapshot.agentSessions);
  const decision = decideApproval({
    repoKey: "o/a",
    pullRequestNumber: options.pullRequestNumber ?? 10,
    snapshot,
    sessionStore,
    claimedActions: new Set(options.claimed ? [pullRequestClaimKey("o/a", options.pullRequestNumber ?? 10)] : []),
    shutdownSignal: { requested: options.shuttingDown ?? false },
    projectModeEnabled: options.projectMode ?? false,
    dryRun: options.dryRun ?? false,
  });
  return { decision, sessionStore };
}

/** A pool's approvals, with the events it emits and a clock the test moves. */
function harness() {
  const emitter = new EventEmitter();
  const events: PullRequestApproval[] = [];
  emitter.subscribe((event) => {
    if (event.type === "pull-request-approval") events.push(event.data as PullRequestApproval);
  });
  const clock = { nowMs: Date.parse("2026-10-28T23:21:15.000Z") };
  const approvals = new DashboardApprovals(emitter, () => clock.nowMs);
  return { approvals, events, clock, emitter };
}

/** Steps whose every stage can be held open, recording what ran. */
function steps(overrides: Partial<ApprovalSteps<RepositorySnapshot>> = {}) {
  const lines: string[] = [];
  const ran = { loads: 0, decides: 0, announces: 0 };
  const shutdownSignal = { requested: false };
  const value: ApprovalSteps<RepositorySnapshot> = {
    url: "https://github.com/o/a/pull/10",
    log: (line) => lines.push(line),
    logFailure: (text) => lines.push(...text.split("\n")),
    shutdownSignal,
    loadSnapshot: async () => {
      ran.loads += 1;
      return parkedSnapshot();
    },
    withLock: (fn) => fn(),
    decide: async () => {
      ran.decides += 1;
      return { state: "approved", checksPending: false, alreadyApproved: false };
    },
    announce: async () => {
      ran.announces += 1;
    },
    ...overrides,
  };
  return { steps: value, lines, ran, shutdownSignal };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

const states = (events: PullRequestApproval[]) => events.map((e) => e.state);

// ── decideApproval: what an attempt comes to under the lock ──────────────────

test("decideApproval records an approval on a parked PR", async () => {
  const { decision, sessionStore } = decide(parkedSnapshot());

  assert.deepEqual(await decision, { state: "approved", checksPending: false, alreadyApproved: false });
  assert.equal(sessionStore.sessions.at(-1)?.phase, "approval");
});

test("decideApproval approves a merge that waits while checks run", async () => {
  assert.deepEqual(await decide(parkedSnapshot({ checksStatus: "pending" })).decision, {
    state: "approved", checksPending: true, alreadyApproved: false,
  });
});

test("decideApproval refuses, with its reason, a PR it cannot approve", async () => {
  const notGated = parkedSnapshot({ labels: [] });
  notGated.issues[0]!.labels = [];
  const cases: Array<[string, Promise<ApprovalDecision>, string]> = [
    ["no such PR", decide(parkedSnapshot(), { pullRequestNumber: 11 }).decision, "it is not open"],
    ["closed", decide(parkedSnapshot({ state: "closed" })).decision, "it is not open"],
    ["not review-gated", decide(notGated).decision, "it is not waiting on approval"],
    ["failing checks", decide(parkedSnapshot({ checksStatus: "failure" })).decision, "its checks are failing"],
    ["dry run", decide(parkedSnapshot(), { dryRun: true }).decision, "--dry-run records nothing"],
    ["shutting down", decide(parkedSnapshot(), { shuttingDown: true }).decision, SHUTTING_DOWN_REASON],
    ["an engine on it", decide(parkedSnapshot(), { claimed: true }).decision, ENGINE_WORKING_REASON],
  ];

  for (const [description, decision, reason] of cases) {
    assert.deepEqual(await decision, { state: "refused", reason }, description);
  }
});

test("decideApproval: a PR an earlier approval covers reads as approved, not refused (#276)", async () => {
  const approved = parkedSnapshot({}, [session("s2", "approval", "2024-01-03T00:00:00.000Z")]);
  const { decision, sessionStore } = decide(approved);

  assert.deepEqual(await decision, { state: "approved", checksPending: false, alreadyApproved: true });
  assert.equal(sessionStore.sessions.filter((s) => s.phase === "approval").length, 1, "nothing new recorded");
});

test("decideApproval: an engine claimed on a PR because of its approval is merging it, not refusing it (#276)", async () => {
  const merging = parkedSnapshot({}, [
    session("s2", "approval", "2024-01-03T00:00:00.000Z"),
    session("s3", "squash-merge", "2024-01-04T00:00:00.000Z", "in_progress"),
  ]);

  assert.deepEqual(await decide(merging, { claimed: true }).decision, {
    state: "approved", checksPending: false, alreadyApproved: true, merging: true,
  });

  const otherWork = parkedSnapshot({}, [session("s2", "resolve-conflicts", "2024-01-03T00:00:00.000Z", "in_progress")]);
  assert.deepEqual(await decide(otherWork, { claimed: true }).decision, {
    state: "refused", reason: ENGINE_WORKING_REASON,
  }, "an engine doing anything else to it is still a refusal");
});

test("decideApproval judges the claim against the session store as it is now", async () => {
  // The pre-lock snapshot predates the approval; the store has it.
  const snapshot = parkedSnapshot();
  const sessionStore = fakeSessionStore([...snapshot.agentSessions, session("s2", "approval", "2024-01-03T00:00:00.000Z")]);
  const decision = await decideApproval({
    repoKey: "o/a", pullRequestNumber: 10, snapshot, sessionStore,
    claimedActions: new Set([pullRequestClaimKey("o/a", 10)]),
    shutdownSignal: { requested: false }, projectModeEnabled: false, dryRun: false,
  });

  assert.equal(decision.state, "approved");
  assert.equal(snapshot.agentSessions.length, 2, "the snapshot now carries the store's sessions");
});

// ── DashboardApprovals: one attempt, reported at every step ──────────────────

test("an approval reports loading, then waiting, then approved, with its timing in the log", async () => {
  const { approvals, events, clock } = harness();
  const load = gate();
  const lock = gate();
  const s = steps({
    loadSnapshot: async () => {
      await load.opened;
      return parkedSnapshot();
    },
    withLock: async (fn) => {
      await lock.opened;
      return fn();
    },
  });

  const done = approvals.request("o/a", 10, s.steps);
  assert.deepEqual(states(events), ["loading"], "loading before the PR is read");
  assert.equal(events[0]?.requestedAt, "2026-10-28T23:21:15.000Z");

  clock.nowMs += 11_000;
  load.open();
  await settle();
  assert.deepEqual(states(events), ["loading", "waiting"], "waiting for the planner once it is read");

  clock.nowMs += 30_000;
  lock.open();
  await done;
  assert.deepEqual(states(events), ["loading", "waiting", "approved"]);
  assert.deepEqual(events.at(-1), {
    repo: "o/a", pullRequestNumber: 10, requestedAt: "2026-10-28T23:21:15.000Z",
    state: "approved", checksPending: false, alreadyApproved: false,
  });
  assert.equal(s.ran.announces, 1, "a new approval is shown, the pool woken and the PR commented on");
  assert.deepEqual(s.lines, [
    "Approve requested on the dashboard: o/a PR #10 (https://github.com/o/a/pull/10)",
    "  ✓ approved after 41s (waited 30s for the planner) — an engine will squash-merge it next.",
  ]);
  assert.equal(approvals.inFlightFor("o/a", 10), undefined, "and it is no longer in flight");
});

test("an approval that waits for checks says so", async () => {
  const { approvals, events } = harness();
  const s = steps({ decide: async () => ({ state: "approved", checksPending: true, alreadyApproved: false }) });

  await approvals.request("o/a", 10, s.steps);

  assert.equal(events.at(-1)?.checksPending, true);
  assert.match(s.lines.at(-1) ?? "", /✓ approved after 0s \(waited 0s for the planner\) — it will be squash-merged once its checks pass\.$/);
});

test("a refused approval reports refused with the log line's reason, once", async () => {
  for (const reason of [
    "it is not open",
    "it is not waiting on approval",
    "its checks are failing",
    "--dry-run records nothing",
    SHUTTING_DOWN_REASON,
    ENGINE_WORKING_REASON,
  ]) {
    const { approvals, events } = harness();
    const s = steps({ decide: async () => ({ state: "refused", reason }) });

    await approvals.request("o/a", 10, s.steps);

    assert.deepEqual(states(events), ["loading", "waiting", "refused"], reason);
    assert.equal(events.at(-1)?.reason, reason);
    assert.equal(s.lines.at(-1), `  ✗ not approved after 0s (waited 0s for the planner): ${reason}.`);
    assert.equal(s.ran.announces, 0, "nothing to announce");
    assert.equal(approvals.inFlightFor("o/a", 10), undefined);
  }
});

test("an approval whose PR cannot be read reports failed with the error's first line", async () => {
  const { approvals, events } = harness();
  const s = steps({
    loadSnapshot: async () => {
      throw new Error("GitHub said 502\n<html>Bad gateway</html>");
    },
  });

  await approvals.request("o/a", 10, s.steps);

  assert.deepEqual(states(events), ["loading", "failed"]);
  assert.equal(events.at(-1)?.reason, "GitHub said 502");
  assert.match(s.lines[1] ?? "", /^  ✗ approving o\/a PR #10 failed after 0s: Error: GitHub said 502$/);
  assert.equal(s.ran.decides, 0);
  assert.equal(approvals.inFlightFor("o/a", 10), undefined, "cleared after an error too");
});

test("an approval that fails under the lock says how long it waited", async () => {
  const { approvals, events } = harness();
  const s = steps({
    decide: async () => {
      throw new Error("session store is unreadable");
    },
  });

  await approvals.request("o/a", 10, s.steps);

  assert.deepEqual(states(events), ["loading", "waiting", "failed"]);
  assert.match(s.lines[1] ?? "", /failed after 0s \(waited 0s for the planner\): Error: session store is unreadable/);
});

test("an approval requested while yoke shuts down is refused at once", async () => {
  const { approvals, events } = harness();
  const s = steps();
  s.shutdownSignal.requested = true;

  await approvals.request("o/a", 10, s.steps);

  assert.deepEqual(states(events), ["refused"]);
  assert.equal(events[0]?.reason, SHUTTING_DOWN_REASON);
  assert.equal(s.ran.loads, 0);
  assert.equal(s.lines.at(-1), `  ✗ not approved: ${SHUTTING_DOWN_REASON}.`);
  assert.equal(approvals.inFlightFor("o/a", 10), undefined);
});

test("a shutdown while an approval waits for the planner refuses it", async () => {
  const { approvals, events } = harness();
  const signal = { requested: false };
  const s = steps({
    shutdownSignal: signal,
    loadSnapshot: async () => {
      signal.requested = true; // Escape pressed while GitHub was being read
      return parkedSnapshot();
    },
    decide: (snapshot) => decideApproval({
      repoKey: "o/a", pullRequestNumber: 10, snapshot, sessionStore: fakeSessionStore(snapshot.agentSessions),
      claimedActions: new Set(), shutdownSignal: signal, projectModeEnabled: false, dryRun: false,
    }),
  });

  await approvals.request("o/a", 10, s.steps);

  assert.deepEqual(states(events), ["loading", "waiting", "refused"]);
  assert.equal(events.at(-1)?.reason, SHUTTING_DOWN_REASON);
});

test("a second press while an approval is in flight starts nothing and gets its state (#276)", async () => {
  const { approvals, events, clock } = harness();
  const lock = gate();
  const s = steps({
    withLock: async (fn) => {
      await lock.opened;
      return fn();
    },
  });

  const first = approvals.request("o/a", 10, s.steps);
  await settle();
  assert.deepEqual(states(events), ["loading", "waiting"]);

  clock.nowMs += 39_000;
  const second = approvals.request("o/a", 10, s.steps);
  await second;
  assert.deepEqual(states(events), ["loading", "waiting", "waiting"], "the second press is told the first is waiting");
  assert.equal(events[2]?.requestedAt, events[0]?.requestedAt, "it is the same attempt");
  assert.equal(s.ran.loads, 1, "no second attempt");
  assert.equal(
    s.lines.at(-1),
    "Approve requested on the dashboard: o/a PR #10 — already in progress (requested 39s ago)",
  );

  lock.open();
  await first;
  assert.deepEqual(states(events), ["loading", "waiting", "waiting", "approved"], "and no refusal for it");
  assert.equal(s.ran.decides, 1);
  assert.ok(!s.lines.some((line) => line.includes("not approved")));
});

test("a press while an approval is being announced is told it is approved", async () => {
  const { approvals, events } = harness();
  const comment = gate();
  const s = steps({ announce: () => comment.opened });

  const first = approvals.request("o/a", 10, s.steps);
  await settle();
  assert.equal(events.at(-1)?.state, "approved");

  await approvals.request("o/a", 10, s.steps);
  assert.deepEqual(states(events), ["loading", "waiting", "approved", "approved"]);
  comment.open();
  await first;
  assert.equal(approvals.inFlightFor("o/a", 10), undefined);
});

test("approvals of different PRs and projects run side by side", async () => {
  const { approvals, events } = harness();
  const lock = gate();
  const s = steps({
    withLock: async (fn) => {
      await lock.opened;
      return fn();
    },
  });

  const all = [
    approvals.request("o/a", 10, s.steps),
    approvals.request("o/a", 11, s.steps),
    approvals.request("o/b", 10, s.steps),
  ];
  await settle();
  assert.equal(s.ran.loads, 3, "each is its own attempt");
  lock.open();
  await Promise.all(all);
  const outcomes = events.filter((e) => e.state === "approved").map((e) => `${e.repo}#${e.pullRequestNumber}`);
  assert.deepEqual(outcomes.sort(), ["o/a#10", "o/a#11", "o/b#10"]);
});

test("pressing again after an approval ends starts a new attempt", async () => {
  const { approvals, events } = harness();
  const s = steps({ decide: async () => ({ state: "refused", reason: "its checks are failing" }) });

  await approvals.request("o/a", 10, s.steps);
  await approvals.request("o/a", 10, s.steps);

  assert.equal(s.ran.loads, 2);
  assert.deepEqual(states(events), ["loading", "waiting", "refused", "loading", "waiting", "refused"]);
});

test("a press that finds the PR already approved reports approved, logs it as such, and announces nothing again", async () => {
  const { approvals, events } = harness();
  const merging = steps({ decide: async () => ({ state: "approved", checksPending: false, alreadyApproved: true, merging: true }) });

  await approvals.request("o/a", 10, merging.steps);

  assert.deepEqual(events.at(-1), {
    repo: "o/a", pullRequestNumber: 10, requestedAt: events[0]!.requestedAt,
    state: "approved", checksPending: false, alreadyApproved: true,
  });
  assert.match(merging.lines.at(-1) ?? "", /✓ already approved after 0s \(waited 0s for the planner\) — an engine is merging it\.$/);
  assert.equal(merging.ran.announces, 0, "no second PR comment");

  const waiting = steps({ decide: async () => ({ state: "approved", checksPending: false, alreadyApproved: true }) });
  await approvals.request("o/a", 10, waiting.steps);
  assert.match(waiting.lines.at(-1) ?? "", /✓ already approved .* — an engine will squash-merge it next\.$/);
});

test("an error after the approval is recorded is logged without a second outcome", async () => {
  const { approvals, events } = harness();
  const s = steps({
    announce: async () => {
      throw new Error("lifecycle broadcast blew up");
    },
  });

  await approvals.request("o/a", 10, s.steps);

  assert.deepEqual(states(events), ["loading", "waiting", "approved"], "exactly one outcome");
  assert.ok(s.lines.some((line) => line.includes("lifecycle broadcast blew up")));
  assert.equal(approvals.inFlightFor("o/a", 10), undefined);
});

test("with every engine idle and queued for the planner, an approval waits for only the pass in progress", async () => {
  const mutex = new PlanningMutex();
  const order: string[] = [];
  const passes: Array<() => void> = [];
  // Six idle engines, each pass holding the lock until the test ends it.
  const engines = Array.from({ length: 6 }, (_, i) =>
    mutex.withLock(async () => {
      order.push(`engine ${i + 1}`);
      await new Promise<void>((resolve) => passes.push(resolve));
    }),
  );
  await settle();
  assert.deepEqual(order, ["engine 1"]);

  const { approvals, events } = harness();
  const s = steps({
    withLock: (fn) => mutex.withLock(fn, { priority: true }),
    decide: async () => {
      order.push("approval");
      return { state: "approved", checksPending: false, alreadyApproved: false };
    },
  });
  const approval = approvals.request("o/a", 10, s.steps);
  await settle();
  assert.equal(events.at(-1)?.state, "waiting");

  passes.shift()!(); // engine 1's pass ends
  await approval;
  assert.deepEqual(order.slice(0, 2), ["engine 1", "approval"], "recorded straight after the pass in progress");

  while (order.length < 7) {
    await settle();
    passes.shift()?.();
  }
  await Promise.all(engines);
  assert.deepEqual(order, ["engine 1", "approval", "engine 2", "engine 3", "engine 4", "engine 5", "engine 6"]);
});
