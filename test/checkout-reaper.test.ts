import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CheckoutState,
  DiskSpaceHold,
  inspectProjectCheckouts,
  isHeadReachable,
  openWorkFromSnapshot,
  removeCheckout,
  runCheckoutReaper,
  selectCheckoutsToReap,
} from "../src/checkout-reaper.js";
import { issueClaimKey, pullRequestClaimKey, tryClaimFromPlan } from "../src/scheduler.js";
import type { OrchestratorAction, RepositorySnapshot } from "../src/types.js";

const HOUR = 3_600_000;
const GB = 1024 ** 3;
const NOW = 1_800_000_000_000;

function checkout(overrides: Partial<CheckoutState> & { name: string }): CheckoutState {
  const match = /^(issue|pr)-(\d+)$/.exec(overrides.name)!;
  return {
    repoKey: "acme/widgets",
    dir: `/checkouts/acme-widgets/${overrides.name}`,
    kind: match[1] as "issue" | "pr",
    number: Number(match[2]),
    open: true,
    claimed: false,
    lastUsedMs: NOW - HOUR,
    sizeBytes: 0,
    headReachable: true,
    retentionMs: 24 * HOUR,
    ...overrides,
  };
}

function names(selection: ReturnType<typeof selectCheckoutsToReap>): Array<[string, string]> {
  return selection.remove.map((r) => [r.checkout.name, r.reason]);
}

// ── selectCheckoutsToReap ────────────────────────────────────────────────────

test("a checkout whose issue is closed, or whose PR is merged or closed, is removed whatever its age", () => {
  const selection = selectCheckoutsToReap({
    checkouts: [
      checkout({ name: "issue-1", open: false, lastUsedMs: NOW - 60_000 }),
      checkout({ name: "pr-2", open: false, lastUsedMs: NOW }),
      checkout({ name: "issue-3", open: true }),
    ],
    freeBytes: 100 * GB,
    minFreeBytes: 10 * GB,
    nowMs: NOW,
  });
  assert.deepEqual(names(selection), [["issue-1", "closed"], ["pr-2", "closed"]]);
  assert.equal(selection.stillLow, false);
});

test("an open item whose state is unknown is never taken for closed", () => {
  const selection = selectCheckoutsToReap({
    checkouts: [checkout({ name: "issue-1", open: undefined })],
    freeBytes: 100 * GB,
    minFreeBytes: 10 * GB,
    nowMs: NOW,
  });
  assert.deepEqual(names(selection), []);
});

test("a checkout for open work is aged out once untouched for its project's retention period", () => {
  const selection = selectCheckoutsToReap({
    checkouts: [
      checkout({ name: "issue-1", lastUsedMs: NOW - 25 * HOUR }),
      checkout({ name: "issue-2", lastUsedMs: NOW - 23 * HOUR }),
      checkout({ name: "pr-3", lastUsedMs: NOW - 3 * HOUR, retentionMs: 2 * HOUR }),
    ],
    freeBytes: 100 * GB,
    minFreeBytes: 10 * GB,
    nowMs: NOW,
  });
  assert.deepEqual(names(selection), [["issue-1", "idle"], ["pr-3", "idle"]]);
});

test("a claimed checkout is never removed: not closed, not idle, not under disk pressure", () => {
  const selection = selectCheckoutsToReap({
    checkouts: [
      checkout({ name: "issue-1", claimed: true, open: false }),
      checkout({ name: "issue-2", claimed: true, lastUsedMs: NOW - 100 * HOUR }),
      checkout({ name: "pr-3", claimed: true, sizeBytes: 50 * GB }),
    ],
    freeBytes: 1 * GB,
    minFreeBytes: 10 * GB,
    nowMs: NOW,
  });
  assert.deepEqual(names(selection), []);
  assert.deepEqual(
    selection.kept.map((k) => [k.checkout.name, k.reason]),
    [["issue-1", "claimed"], ["issue-2", "claimed"], ["pr-3", "claimed"]],
  );
  assert.equal(selection.stillLow, true);
});

test("a checkout whose detached HEAD no ref reaches is kept, even when its work is closed", () => {
  const selection = selectCheckoutsToReap({
    checkouts: [
      checkout({ name: "pr-1", open: false, headReachable: false }),
      checkout({ name: "pr-2", headReachable: false, sizeBytes: 50 * GB, lastUsedMs: NOW - 100 * HOUR }),
    ],
    freeBytes: 1 * GB,
    minFreeBytes: 10 * GB,
    nowMs: NOW,
  });
  assert.deepEqual(names(selection), []);
  assert.deepEqual(
    selection.kept.map((k) => [k.checkout.name, k.reason]),
    [["pr-1", "unreachable-head"], ["pr-2", "unreachable-head"]],
  );
});

test("under disk pressure, idle checkouts are evicted least recently used first until there is room", () => {
  const selection = selectCheckoutsToReap({
    checkouts: [
      checkout({ name: "issue-1", lastUsedMs: NOW - 1 * HOUR, sizeBytes: 3 * GB }),
      checkout({ name: "issue-2", lastUsedMs: NOW - 5 * HOUR, sizeBytes: 3 * GB }),
      checkout({ name: "pr-3", lastUsedMs: NOW - 3 * HOUR, sizeBytes: 3 * GB }),
      checkout({ name: "pr-4", open: false, sizeBytes: 2 * GB }),
    ],
    freeBytes: 4 * GB,
    minFreeBytes: 10 * GB,
    nowMs: NOW,
  });
  // 4 free + 2 from the closed PR = 6; the oldest idle one brings it to 9,
  // the next to 12, and the most recently used is spared.
  assert.deepEqual(names(selection), [
    ["pr-4", "closed"],
    ["issue-2", "disk-pressure"],
    ["pr-3", "disk-pressure"],
  ]);
  assert.equal(selection.projectedFreeBytes, 12 * GB);
  assert.equal(selection.stillLow, false);
});

test("disk pressure that even evicting everything cannot relieve is reported as still low", () => {
  const selection = selectCheckoutsToReap({
    checkouts: [checkout({ name: "issue-1", sizeBytes: 1 * GB })],
    freeBytes: 2 * GB,
    minFreeBytes: 10 * GB,
    nowMs: NOW,
  });
  assert.deepEqual(names(selection), [["issue-1", "disk-pressure"]]);
  assert.equal(selection.stillLow, true);
});

test("no disk-pressure eviction when the floor is 0 or free space is unknown", () => {
  for (const [freeBytes, minFreeBytes] of [[1 * GB, 0], [undefined, 10 * GB]] as const) {
    const selection = selectCheckoutsToReap({
      checkouts: [checkout({ name: "issue-1", sizeBytes: 1 * GB })],
      freeBytes,
      minFreeBytes,
      nowMs: NOW,
    });
    assert.deepEqual(names(selection), []);
    assert.equal(selection.stillLow, false);
  }
});

// ── openWorkFromSnapshot ─────────────────────────────────────────────────────

test("a snapshot whose listing failed vouches for nothing, so no checkout looks finished", () => {
  const snapshot = {
    issues: [{ number: 5, state: "open" }],
    pullRequests: [],
    agentSessions: [],
    listingFailed: { issues: false, pullRequests: true },
  } as unknown as RepositorySnapshot;
  const work = openWorkFromSnapshot(snapshot);
  assert.deepEqual([...work.issueNumbers!], [5]);
  assert.equal(work.pullRequestNumbers, undefined);
  assert.deepEqual(openWorkFromSnapshot(null), { issueNumbers: undefined, pullRequestNumbers: undefined });
});

// ── runCheckoutReaper ────────────────────────────────────────────────────────

async function makeCheckoutDirs(root: string, names: readonly string[]): Promise<string> {
  const canonicalDir = join(root, "acme-widgets", "_main");
  await mkdir(canonicalDir, { recursive: true });
  for (const name of names) {
    await mkdir(join(root, "acme-widgets", name), { recursive: true });
  }
  return canonicalDir;
}

test("the reaper removes finished checkouts, honours dry-run, and leaves claimed ones", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yoke-reaper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalDir = await makeCheckoutDirs(root, ["issue-1", "issue-2", "pr-3"]);
  const project = {
    repoKey: "acme/widgets",
    canonicalDir,
    openWork: { issueNumbers: new Set([2]), pullRequestNumbers: new Set<number>() },
    retentionMs: 24 * HOUR,
  };
  const claimed = new Set([pullRequestClaimKey("acme/widgets", 3)]);

  for (const dryRun of [true, false]) {
    const removed: string[] = [];
    const report = await runCheckoutReaper({
      projects: [project],
      checkoutRootDir: root,
      minFreeBytes: 10 * GB,
      claimedActions: claimed,
      reservations: new Set(),
      dryRun,
      readFreeBytes: async () => 100 * GB,
      measureBytes: async () => 1024,
      remove: async (_canonical, dir) => { removed.push(dir); },
    });
    assert.deepEqual(
      report.outcomes.map((o) => [o.checkout.name, o.status]),
      [["issue-1", dryRun ? "would-remove" : "removed"]],
    );
    assert.deepEqual(removed, dryRun ? [] : [join(root, "acme-widgets", "issue-1")]);
    assert.equal(report.freedBytes, dryRun ? 0 : 1024);
  }
});

test("an engine cannot claim work while its checkout is being removed, and the reaper skips work claimed since it looked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yoke-reaper-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalDir = await makeCheckoutDirs(root, ["issue-1", "issue-2"]);
  const claimedActions = new Set<string>();
  const reservations = new Set<string>();
  const implement = (issueNumber: number) =>
    ({ type: "start-implementation", issueNumber }) as unknown as OrchestratorAction;

  let claimDuringRemoval: OrchestratorAction | null | undefined;
  const report = await runCheckoutReaper({
    projects: [{
      repoKey: "acme/widgets",
      canonicalDir,
      openWork: { issueNumbers: new Set(), pullRequestNumbers: new Set() },
      retentionMs: 24 * HOUR,
    }],
    checkoutRootDir: root,
    minFreeBytes: 0,
    claimedActions,
    reservations,
    dryRun: false,
    readFreeBytes: async () => 100 * GB,
    measureBytes: async (dir) => {
      // An engine claims issue 2 after the reaper inspected the checkouts but
      // before it got round to removing issue-2.
      if (dir.endsWith("issue-2")) claimedActions.add(issueClaimKey("acme/widgets", 2));
      return 0;
    },
    remove: async () => {
      // Mid-removal of issue-1: the planner passes it over.
      assert.equal(reservations.has(issueClaimKey("acme/widgets", 1)), true);
      claimDuringRemoval = tryClaimFromPlan(
        "acme/widgets", 5, [implement(1)], claimedActions, undefined, Date.now(), reservations,
      );
    },
  });

  assert.equal(claimDuringRemoval, null);
  assert.deepEqual(
    report.outcomes.map((o) => [o.checkout.name, o.status]),
    [["issue-1", "removed"], ["issue-2", "claimed"]],
  );
  assert.equal(reservations.size, 0, "reservations are released once removal is done");
  assert.notEqual(
    tryClaimFromPlan("acme/widgets", 5, [implement(1)], claimedActions, undefined, Date.now(), reservations),
    null,
  );
});

test("a disk still short after the pass is reported low, and the hold announces each change once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yoke-reaper-low-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalDir = await makeCheckoutDirs(root, ["issue-1"]);
  const report = await runCheckoutReaper({
    projects: [{
      repoKey: "acme/widgets",
      canonicalDir,
      openWork: { issueNumbers: new Set([1]), pullRequestNumbers: new Set() },
      retentionMs: 24 * HOUR,
    }],
    checkoutRootDir: root,
    minFreeBytes: 10 * GB,
    claimedActions: new Set(),
    reservations: new Set(),
    dryRun: false,
    readFreeBytes: async () => 1 * GB,
    measureBytes: async () => 1024,
    remove: async () => {},
  });
  assert.deepEqual(report.outcomes.map((o) => [o.checkout.name, o.reason]), [["issue-1", "disk-pressure"]]);
  assert.equal(report.low, true);

  const hold = new DiskSpaceHold();
  const reading = { path: root, freeBytes: 1 * GB, minFreeBytes: 10 * GB };
  assert.equal(hold.update(reading, true), "held");
  assert.equal(hold.update(reading, true), undefined);
  assert.notEqual(hold.active, undefined);
  assert.equal(hold.update(reading, false), "released");
  assert.equal(hold.active, undefined);
});

// ── real git ─────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

test("a worktree on a branch, or detached at a reachable commit, is reachable; one detached at its own commit is not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yoke-reaper-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canonicalDir = join(root, "acme-widgets", "_main");
  await mkdir(canonicalDir, { recursive: true });
  git(canonicalDir, "init", "-b", "main");
  git(canonicalDir, "config", "user.name", "Test");
  git(canonicalDir, "config", "user.email", "test@example.com");
  await writeFile(join(canonicalDir, "README.md"), "# test\n");
  git(canonicalDir, "add", "README.md");
  git(canonicalDir, "commit", "-m", "initial");

  const onBranch = join(root, "acme-widgets", "issue-1");
  const detachedReachable = join(root, "acme-widgets", "pr-2");
  const detachedOwn = join(root, "acme-widgets", "pr-3");
  git(canonicalDir, "worktree", "add", "-b", "yoke/issue-1", onBranch, "main");
  git(canonicalDir, "worktree", "add", "--detach", detachedReachable, "main");
  git(canonicalDir, "worktree", "add", "--detach", detachedOwn, "main");
  await writeFile(join(detachedOwn, "lost.txt"), "only here\n");
  git(detachedOwn, "add", "lost.txt");
  git(detachedOwn, "commit", "-m", "a commit no ref holds");

  assert.equal(await isHeadReachable(onBranch), true);
  assert.equal(await isHeadReachable(detachedReachable), true);
  assert.equal(await isHeadReachable(detachedOwn), false);

  const { checkouts } = await inspectProjectCheckouts(
    {
      repoKey: "acme/widgets",
      canonicalDir,
      openWork: { issueNumbers: new Set(), pullRequestNumbers: new Set() },
      retentionMs: 24 * HOUR,
    },
    new Set(),
  );
  assert.deepEqual(
    checkouts.map((c) => [c.name, c.open, c.headReachable]),
    [["issue-1", false, true], ["pr-2", false, true], ["pr-3", false, false]],
  );

  // Removal goes through git: the directory and its admin entry go, the branch stays.
  await removeCheckout(canonicalDir, onBranch);
  await assert.rejects(stat(onBranch));
  assert.equal(git(canonicalDir, "rev-parse", "--verify", "--quiet", "refs/heads/yoke/issue-1") !== "", true);
  assert.equal(git(canonicalDir, "worktree", "list", "--porcelain").includes(onBranch), false);
});
