import test from "node:test";
import assert from "node:assert/strict";
import {
  actionResourceKey,
  repoActionKey,
  claimsForRepo,
  claimedImplementationIssueNumbers,
  claimNextAction,
  claudeQuotaHoldWaitMs,
  clearToFire,
  HoldAnnouncer,
  PlanningMutex,
  tryClaimFromPlan,
  PoolWake,
  pullRequestClaimKey,
} from "../src/scheduler.js";
import type { OrchestratorAction } from "../src/types.js";

const impl = (issueNumber: number): OrchestratorAction => ({
  type: "start-implementation",
  issueNumber,
});
const review = (pullRequestNumber: number): OrchestratorAction => ({
  type: "self-review",
  issueNumber: undefined,
  pullRequestNumber,
  pullRequestHeadSha: "deadbeef",
});

// ── claim keys ────────────────────────────────────────────────────────────────

test("actionResourceKey keys by resource, not action type", () => {
  assert.equal(actionResourceKey(impl(7)), "issue:7");
  assert.equal(actionResourceKey(review(12)), "pr:12");
});

test("repoActionKey namespaces resource keys by project", () => {
  assert.equal(repoActionKey("o/a", impl(7)), "o/a issue:7");
  assert.equal(repoActionKey("o/b", impl(7)), "o/b issue:7");
  assert.notEqual(repoActionKey("o/a", impl(7)), repoActionKey("o/b", impl(7)));
});

// ── per-project claim accounting ────────────────────────────────────────────────

test("claimsForRepo counts only the named project's claims", () => {
  const claimed = new Set([
    "o/a issue:1",
    "o/a pr:2",
    "o/b issue:1",
  ]);
  assert.equal(claimsForRepo(claimed, "o/a"), 2);
  assert.equal(claimsForRepo(claimed, "o/b"), 1);
  assert.equal(claimsForRepo(claimed, "o/c"), 0);
});

test("claimsForRepo does not match a repo that is a prefix of another", () => {
  const claimed = new Set(["o/app issue:1"]);
  assert.equal(claimsForRepo(claimed, "o/app"), 1);
  assert.equal(claimsForRepo(claimed, "o/ap"), 0, "must not prefix-match o/app");
});

test("claimedImplementationIssueNumbers returns only that project's implementing issues", () => {
  const claimed = new Set([
    "o/a issue:7",
    "o/a pr:3",
    "o/b issue:9",
  ]);
  assert.deepEqual([...claimedImplementationIssueNumbers(claimed, "o/a")], [7]);
  assert.deepEqual([...claimedImplementationIssueNumbers(claimed, "o/b")], [9]);
});

// ── shared-pool allocation with per-project caps ────────────────────────────────

test("tryClaimFromPlan claims the first unclaimed action and records it", () => {
  const claimed = new Set<string>();
  const action = tryClaimFromPlan("o/a", 2, [impl(1), impl(2)], claimed);
  assert.deepEqual(action, impl(1));
  assert.ok(claimed.has("o/a issue:1"));
});

test("tryClaimFromPlan skips actions already claimed (no double-booking a resource)", () => {
  const claimed = new Set<string>(["o/a issue:1"]);
  const action = tryClaimFromPlan("o/a", 4, [impl(1), impl(2)], claimed);
  assert.deepEqual(action, impl(2), "should skip the already-claimed issue 1");
});

test("tryClaimFromPlan returns null once a project is at its cap", () => {
  // Cap of 2, already two cylinders on this project → no further claim allowed,
  // even though the plan still proposes work.
  const claimed = new Set<string>(["o/a issue:1", "o/a pr:9"]);
  const action = tryClaimFromPlan("o/a", 2, [impl(2), impl(3)], claimed);
  assert.equal(action, null);
  assert.equal(claimed.size, 2, "no new claim recorded");
});

test("per-project caps hold while the shared pool drains across projects in order", () => {
  // A cap 2, B cap 2, C cap 1. Configured order prefers A, then B, then C.
  // (The global pool size is enforced by the engine count, not by this helper;
  // here we exercise that each project never exceeds its own cap and that
  // earlier projects are filled first.)
  const projects = [
    { repoKey: "o/a", cap: 2, actions: [impl(1), impl(2), impl(3)] },
    { repoKey: "o/b", cap: 2, actions: [impl(10), impl(11), impl(12)] },
    { repoKey: "o/c", cap: 1, actions: [impl(20), impl(21)] },
  ];
  const claimed = new Set<string>();

  const grabOne = (): string | null => {
    for (const p of projects) {
      const a = tryClaimFromPlan(p.repoKey, p.cap, p.actions, claimed);
      if (a) return p.repoKey;
    }
    return null;
  };

  // First four cylinders fill A (×2) then B (×2) — C is untouched while earlier
  // projects still have headroom.
  assert.deepEqual([grabOne(), grabOne(), grabOne(), grabOne()], ["o/a", "o/a", "o/b", "o/b"]);
  assert.equal(claimsForRepo(claimed, "o/a"), 2);
  assert.equal(claimsForRepo(claimed, "o/b"), 2);
  assert.equal(claimsForRepo(claimed, "o/c"), 0);

  // A and B are now capped, so the next cylinder is the only one C may have.
  assert.equal(grabOne(), "o/c");
  assert.equal(claimsForRepo(claimed, "o/c"), 1);

  // Everything is at cap now — no project has headroom.
  assert.equal(grabOne(), null);
  assert.equal(claimsForRepo(claimed, "o/a"), 2);
  assert.equal(claimsForRepo(claimed, "o/b"), 2);
  assert.equal(claimsForRepo(claimed, "o/c"), 1);
});

test("releasing a claim frees a cap slot for the next cylinder", () => {
  const claimed = new Set<string>(["o/a issue:1", "o/a pr:2"]);
  assert.equal(tryClaimFromPlan("o/a", 2, [impl(3)], claimed), null, "at cap");
  claimed.delete("o/a pr:2"); // a cylinder finished its PR work
  assert.deepEqual(tryClaimFromPlan("o/a", 2, [impl(3)], claimed), impl(3), "slot freed");
});

// ── PlanningMutex ─────────────────────────────────────────────────────────────

test("PlanningMutex runs one critical section at a time, in arrival order", async () => {
  const mutex = new PlanningMutex();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const first = mutex.withLock(async () => {
    order.push("first:start");
    await new Promise<void>((resolve) => (releaseFirst = resolve));
    order.push("first:end");
  });
  const second = mutex.withLock(async () => {
    order.push("second");
  });
  await Promise.resolve();
  assert.deepEqual(order, ["first:start"], "the second section waits for the lock");
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

/**
 * Queue a critical section named `name` that runs until released. Records the
 * order sections start in, and fails if two ever run at once.
 */
function heldSection(
  mutex: PlanningMutex,
  log: { started: string[]; running: number; overlaps: number },
  name: string,
  options?: { priority?: boolean },
): { done: Promise<string>; release: () => void } {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const done = mutex.withLock(async () => {
    log.running += 1;
    if (log.running > 1) log.overlaps += 1;
    log.started.push(name);
    await released;
    log.running -= 1;
    return name;
  }, options);
  return { done, release };
}

/** Let every pending promise callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function sectionLog() {
  return { started: [] as string[], running: 0, overlaps: 0 };
}

test("PlanningMutex: a priority waiter queued behind ordinary ones runs right after the holder (#276)", async () => {
  const mutex = new PlanningMutex();
  const log = sectionLog();
  const holder = heldSection(mutex, log, "holder");
  const engines = [1, 2, 3].map((n) => heldSection(mutex, log, `engine ${n}`));
  const approval = heldSection(mutex, log, "approval", { priority: true });
  await settle();
  assert.deepEqual(log.started, ["holder"], "a priority request never interrupts the section running");

  holder.release();
  await settle();
  assert.deepEqual(log.started, ["holder", "approval"], "let in before every engine that queued first");

  approval.release();
  for (const engine of engines) {
    await settle();
    engine.release();
  }
  await Promise.all([holder.done, approval.done, ...engines.map((e) => e.done)]);
  assert.deepEqual(log.started, ["holder", "approval", "engine 1", "engine 2", "engine 3"], "the engines keep their order");
  assert.equal(log.overlaps, 0);
});

test("PlanningMutex: priority waiters run first in, first out among themselves", async () => {
  const mutex = new PlanningMutex();
  const log = sectionLog();
  const sections = [
    heldSection(mutex, log, "holder"),
    heldSection(mutex, log, "engine"),
    heldSection(mutex, log, "approval A", { priority: true }),
    heldSection(mutex, log, "approval B", { priority: true }),
    heldSection(mutex, log, "approval C", { priority: true }),
  ];
  for (let i = 0; i < sections.length; i += 1) {
    await settle();
    for (const section of sections) section.release();
  }
  await Promise.all(sections.map((s) => s.done));
  assert.deepEqual(log.started, ["holder", "approval A", "approval B", "approval C", "engine"]);
  assert.equal(log.overlaps, 0);
});

test("PlanningMutex: ordinary waiters keep their arrival order around priority ones", async () => {
  const mutex = new PlanningMutex();
  const log = sectionLog();
  const sections = [
    heldSection(mutex, log, "holder"),
    heldSection(mutex, log, "engine 1"),
    heldSection(mutex, log, "approval", { priority: true }),
    heldSection(mutex, log, "engine 2"),
    heldSection(mutex, log, "engine 3"),
  ];
  for (let i = 0; i < sections.length; i += 1) {
    await settle();
    for (const section of sections) section.release();
  }
  await Promise.all(sections.map((s) => s.done));
  assert.deepEqual(log.started, ["holder", "approval", "engine 1", "engine 2", "engine 3"]);
  assert.equal(log.overlaps, 0);
});

test("PlanningMutex: a priority request on a free lock runs at once", async () => {
  const mutex = new PlanningMutex();
  const log = sectionLog();
  const approval = heldSection(mutex, log, "approval", { priority: true });
  await Promise.resolve();
  assert.deepEqual(log.started, ["approval"]);

  const engine = heldSection(mutex, log, "engine");
  await settle();
  assert.deepEqual(log.started, ["approval"], "and holds it like any other section");
  approval.release();
  await settle();
  engine.release();
  assert.deepEqual(await Promise.all([approval.done, engine.done]), ["approval", "engine"]);
  assert.equal(log.overlaps, 0);
});

test("PlanningMutex: a priority request never runs alongside the holder", async () => {
  const mutex = new PlanningMutex();
  const log = sectionLog();
  const holder = heldSection(mutex, log, "holder");
  const approval = heldSection(mutex, log, "approval", { priority: true });
  for (let i = 0; i < 5; i += 1) await settle();
  assert.deepEqual(log.started, ["holder"]);
  assert.equal(log.running, 1);

  holder.release();
  await settle();
  approval.release();
  await Promise.all([holder.done, approval.done]);
  assert.equal(log.overlaps, 0);
});

test("PlanningMutex: free again after a mix of both kinds, with no lost wake-up and no double hold", async () => {
  const mutex = new PlanningMutex();
  const log = sectionLog();
  const sections: Array<{ done: Promise<string>; release: () => void }> = [];
  // Waiters of both kinds arrive while sections are running, in both queues.
  for (let i = 0; i < 12; i += 1) {
    sections.push(heldSection(mutex, log, `s${i}`, { priority: i % 3 === 0 }));
    if (i % 4 === 3) {
      await settle();
      const running = sections[Number(log.started.at(-1)!.slice(1))]!;
      running.release();
    }
  }
  for (let i = 0; i < sections.length; i += 1) {
    await settle();
    for (const section of sections) section.release();
  }
  await Promise.all(sections.map((s) => s.done));
  assert.equal(log.started.length, 12, "every waiter ran: no lost wake-up");
  assert.equal(new Set(log.started).size, 12, "each exactly once");
  assert.equal(log.overlaps, 0, "never two at once");

  // A section that throws still hands the lock on.
  await assert.rejects(mutex.withLock(async () => { throw new Error("boom"); }, { priority: true }), /boom/);
  let ran = false;
  await mutex.withLock(async () => { ran = true; });
  assert.ok(ran, "the lock is free once everyone is done");
});

// ── shutdown gating ──────────────────────────────────────────────────────────

interface TestProject {
  repoKey: string;
  cap: number;
  actions: OrchestratorAction[];
}

const project = (repoKey: string, cap: number, actions: OrchestratorAction[]): TestProject => ({
  repoKey,
  cap,
  actions,
});

test("claimNextAction claims the first claimable action, in project order", async () => {
  // o/a is already at its cap, so the claim falls through to o/b.
  const claimed = new Set<string>(["o/a issue:9"]);
  const result = await claimNextAction({
    projects: [project("o/a", 1, [impl(1)]), project("o/b", 1, [impl(2)])],
    loadPlan: async (p) => ({ actions: p.actions }),
    claimedActions: claimed,
    shutdownSignal: { requested: false },
  });
  assert.equal(result?.project.repoKey, "o/b");
  assert.deepEqual(result?.action, impl(2));
  assert.ok(claimed.has("o/b issue:2"));
});

test("claimNextAction skips a project whose plan could not be loaded", async () => {
  const claimed = new Set<string>();
  const result = await claimNextAction({
    projects: [project("o/a", 1, [impl(1)]), project("o/b", 1, [impl(2)])],
    loadPlan: async (p) => (p.repoKey === "o/a" ? undefined : { actions: p.actions }),
    claimedActions: claimed,
    shutdownSignal: { requested: false },
  });
  assert.equal(result?.project.repoKey, "o/b");
  assert.deepEqual([...claimed], ["o/b issue:2"]);
});

test("claimNextAction neither plans nor claims once shutdown is requested", async () => {
  const claimed = new Set<string>();
  let loads = 0;
  const result = await claimNextAction({
    projects: [project("o/a", 1, [impl(1)])],
    loadPlan: async (p) => {
      loads += 1;
      return { actions: p.actions };
    },
    claimedActions: claimed,
    shutdownSignal: { requested: true },
  });
  assert.equal(result, null);
  assert.equal(loads, 0, "no planning pass after the stop order");
  assert.equal(claimed.size, 0, "no claim after the stop order");
});

test("claimNextAction claims nothing when shutdown lands while a snapshot loads", async () => {
  const signal = { requested: false };
  const claimed = new Set<string>();
  const loaded: string[] = [];
  const result = await claimNextAction({
    projects: [project("o/a", 1, [impl(1)]), project("o/b", 1, [impl(2)])],
    loadPlan: async (p) => {
      loaded.push(p.repoKey);
      await Promise.resolve();
      signal.requested = true; // Escape arrives while GitHub is answering.
      return { actions: p.actions };
    },
    claimedActions: claimed,
    shutdownSignal: signal,
  });
  assert.equal(result, null);
  assert.equal(claimed.size, 0, "the plan that loaded across the order is not claimed from");
  assert.deepEqual(loaded, ["o/a"], "no further project is planned");
});

test("clearToFire lets an engine fire its claim while no shutdown is requested", () => {
  const claimed = new Set<string>(["o/a issue:1"]);
  assert.equal(clearToFire("o/a", impl(1), claimed, { requested: false }), true);
  assert.ok(claimed.has("o/a issue:1"), "the claim stays with the engine that will run it");
});

test("clearToFire releases the claim and holds fire once shutdown is requested", () => {
  const claimed = new Set<string>(["o/a issue:1", "o/a pr:2"]);
  assert.equal(clearToFire("o/a", impl(1), claimed, { requested: true }), false);
  assert.deepEqual([...claimed], ["o/a pr:2"], "only this engine's claim is released");
});

/**
 * One engine's plan-and-fire step, in the order `runEngine` performs it: plan
 * and claim under the shared lock, then pass the fire gate before executing.
 */
async function planAndFire(params: {
  mutex: PlanningMutex;
  projects: TestProject[];
  claimedActions: Set<string>;
  shutdownSignal: { requested: boolean };
  executed: OrchestratorAction[];
  onPlanned?: (p: TestProject) => void;
}): Promise<"fired" | "declined" | "nothing claimed"> {
  const { mutex, claimedActions, shutdownSignal } = params;
  const planned = await mutex.withLock(() =>
    claimNextAction({
      projects: params.projects,
      loadPlan: async (p) => ({ actions: p.actions }),
      ...(params.onPlanned ? { onPlanned: params.onPlanned } : {}),
      claimedActions,
      shutdownSignal,
    }),
  );
  if (!planned) return "nothing claimed";
  if (!clearToFire(planned.project.repoKey, planned.action, claimedActions, shutdownSignal)) {
    return "declined";
  }
  params.executed.push(planned.action);
  return "fired";
}

test("an engine queued behind another's planning pass does not fire once shutdown lands", async () => {
  const mutex = new PlanningMutex();
  const signal = { requested: false };
  const claimed = new Set<string>();
  const executed: OrchestratorAction[] = [];

  // Another engine is mid-planning and holds the lock…
  let releaseLock!: () => void;
  const holder = mutex.withLock(() => new Promise<void>((resolve) => (releaseLock = resolve)));
  // …so this one queues for it, having already passed the top of its cycle.
  const queued = planAndFire({
    mutex,
    projects: [project("o/a", 2, [impl(1)])],
    claimedActions: claimed,
    shutdownSignal: signal,
    executed,
  });

  signal.requested = true;
  releaseLock();
  await holder;

  assert.equal(await queued, "nothing claimed");
  assert.equal(claimed.size, 0, "no action claimed after the stop order");
  assert.deepEqual(executed, [], "no action executed after the stop order");
});

test("a claim the stop order lands on is released and declined, not fired", async () => {
  const signal = { requested: false };
  const claimed = new Set<string>();
  const executed: OrchestratorAction[] = [];
  const outcome = await planAndFire({
    mutex: new PlanningMutex(),
    projects: [project("o/a", 2, [impl(1)])],
    claimedActions: claimed,
    shutdownSignal: signal,
    executed,
    // Runs right after the claim — the narrowest window the order can hit.
    onPlanned: () => {
      signal.requested = true;
    },
  });
  assert.equal(outcome, "declined");
  assert.equal(claimed.size, 0, "the claim is not left held by an engine that will never run it");
  assert.deepEqual(executed, []);
});

test("engines plan and fire normally until shutdown, then none fires", async () => {
  const mutex = new PlanningMutex();
  const signal = { requested: false };
  const claimed = new Set<string>();
  const executed: OrchestratorAction[] = [];
  const projects = [project("o/a", 3, [impl(1), impl(2), impl(3)])];
  const cycle = () =>
    planAndFire({ mutex, projects, claimedActions: claimed, shutdownSignal: signal, executed });

  assert.equal(await cycle(), "fired");
  signal.requested = true;
  assert.deepEqual(await Promise.all([cycle(), cycle()]), ["nothing claimed", "nothing claimed"]);
  assert.deepEqual(executed, [impl(1)], "only the work started before the order ran");
  assert.deepEqual([...claimed], ["o/a issue:1"], "in-flight work keeps its claim until it finishes");
});

// ── claudeQuotaHoldWaitMs ───────────────────────────────────────────────────

test("claudeQuotaHoldWaitMs is 0 when no Claude usage-limit hold is active", () => {
  assert.equal(
    claudeQuotaHoldWaitMs({ blockedUntilMs: undefined, nowMs: 1_000, engineIndex: 1, cycleMinimumMs: 60_000 }),
    0,
  );
});

test("claudeQuotaHoldWaitMs is 0 once the hold has expired", () => {
  assert.equal(
    claudeQuotaHoldWaitMs({ blockedUntilMs: 1_000, nowMs: 1_000, engineIndex: 1, cycleMinimumMs: 60_000 }),
    0,
  );
  assert.equal(
    claudeQuotaHoldWaitMs({ blockedUntilMs: 1_000, nowMs: 5_000, engineIndex: 1, cycleMinimumMs: 60_000 }),
    0,
  );
});

test("claudeQuotaHoldWaitMs makes non-zero engines sleep out the whole hold", () => {
  const twoHours = 2 * 60 * 60 * 1000;
  assert.equal(
    claudeQuotaHoldWaitMs({ blockedUntilMs: 10_000 + twoHours, nowMs: 10_000, engineIndex: 3, cycleMinimumMs: 60_000 }),
    twoHours,
  );
});

test("claudeQuotaHoldWaitMs wakes engine 0 every cycle minimum so maintenance keeps running", () => {
  const twoHours = 2 * 60 * 60 * 1000;
  assert.equal(
    claudeQuotaHoldWaitMs({ blockedUntilMs: 10_000 + twoHours, nowMs: 10_000, engineIndex: 0, cycleMinimumMs: 60_000 }),
    60_000,
  );
  // Never past the end of the hold.
  assert.equal(
    claudeQuotaHoldWaitMs({ blockedUntilMs: 10_000 + 15_000, nowMs: 10_000, engineIndex: 0, cycleMinimumMs: 60_000 }),
    15_000,
  );
});

// ── HoldAnnouncer ───────────────────────────────────────────────────────────

test("HoldAnnouncer lets exactly one engine announce a hold", () => {
  const announcer = new HoldAnnouncer();
  const until = 1_700_000_000_000;
  assert.equal(announcer.enter("claude-usage-limit", until), true, "first engine announces");
  for (let engine = 1; engine < 6; engine += 1) {
    assert.equal(
      announcer.enter("claude-usage-limit", until),
      false,
      "every other engine on the same hold stays silent",
    );
  }
});

test("HoldAnnouncer re-announces when the deadline or the cause changes", () => {
  const announcer = new HoldAnnouncer();
  assert.equal(announcer.enter("claude-usage-limit", 1_000), true);
  assert.equal(announcer.enter("claude-usage-limit", 2_000), true, "a revised reset time is news");
  assert.equal(announcer.enter("github-rate-limit:o/r", 2_000), true, "a different cause is news");
  assert.equal(announcer.enter("github-rate-limit:o/r", 2_000), false);
});

test("HoldAnnouncer reports resuming once, and only after a hold", () => {
  const announcer = new HoldAnnouncer();
  assert.equal(announcer.exit(), false, "nothing to resume from when no hold was announced");
  announcer.enter("claude-usage-limit", 1_000);
  assert.deepEqual(announcer.current(), { key: "claude-usage-limit", untilMs: 1_000 });
  assert.equal(announcer.exit(), true, "first engine past the hold says so");
  assert.equal(announcer.exit(), false, "the rest stay silent");
  assert.equal(announcer.current(), undefined);
});

test("HoldAnnouncer announces again after a hold has been exited", () => {
  const announcer = new HoldAnnouncer();
  announcer.enter("claude-usage-limit", 1_000);
  announcer.exit();
  assert.equal(
    announcer.enter("claude-usage-limit", 1_000),
    true,
    "a fresh hold on the same deadline is a new event once work resumed",
  );
});

// ─── waking the pool for work a human asked for (#274) ───────────────────────

test("PoolWake: a sleep ends early only for a wake after it began", () => {
  const wake = new PoolWake();
  const earlier = wake.token();
  wake.wake();
  const later = wake.token();

  assert.equal(wake.wokenSince(earlier), true, "woken since the earlier sleep began");
  assert.equal(wake.wokenSince(later), false, "a sleep begun after the wake sleeps on");
  wake.wake();
  assert.equal(wake.wokenSince(later), true);
});

test("pullRequestClaimKey matches the claim any action on that PR holds", () => {
  const claimed = new Set<string>();
  tryClaimFromPlan(
    "o/a",
    3,
    [{ type: "self-review", issueNumber: 1, pullRequestNumber: 10, pullRequestHeadSha: "sha" }],
    claimed,
  );

  assert.equal(claimed.has(pullRequestClaimKey("o/a", 10)), true);
  assert.equal(claimed.has(pullRequestClaimKey("o/b", 10)), false, "another project's PR #10");
});
