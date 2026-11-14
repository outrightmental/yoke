import { lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { runCommand, withCanonicalCloneLock } from "./claude-agent.js";
import { formatBytes, measureDirectoryBytes, readFreeBytes } from "./fs-utils.js";
import { issueClaimKey, pullRequestClaimKey, reserveUnclaimed } from "./scheduler.js";
import type { RepositorySnapshot } from "./types.js";

/**
 * Rolling cleanup of the per-issue and per-PR checkouts under
 * `~/.yoke/checkouts` (#288).
 *
 * Yoke used to delete nothing it put on disk. Every `issue-N` and `pr-N`
 * checkout it ever prepared stayed — 898 of them, 139 GB, on the day they
 * filled the disk — though a checkout is disposable by design:
 *
 * - every reuse starts with `git reset --hard HEAD` and `git clean -fd`, so
 *   nothing uncommitted in one survives to its next use anyway;
 * - each is a linked worktree of `<owner>-<repo>/_main`, so its branches and
 *   commits live in the canonical clone's ref store, not in the worktree;
 * - `ensureWorktreeCheckout` recreates a missing one on demand.
 *
 * So engine 0's maintenance removes a checkout once its issue or PR is no
 * longer open, or once it has sat unclaimed and untouched for the retention
 * period, and evicts idle ones least recently used first while the disk is
 * short of space. It never removes one an engine has claimed, nor one whose
 * detached HEAD only it still holds.
 */

export type CheckoutKind = "issue" | "pr";

/** One `issue-N` / `pr-N` checkout, as the reaper sees it. */
export interface CheckoutState {
  /** "owner/repo" of the project it belongs to. */
  repoKey: string;
  /** Its directory name: `issue-42`, `pr-7`. */
  name: string;
  dir: string;
  kind: CheckoutKind;
  /** The issue or PR number in its name. */
  number: number;
  /**
   * Whether its issue or PR is open, from the project's latest snapshot, or
   * undefined when that is not known — no snapshot yet, or its listing failed.
   * Unknown is never taken to mean closed.
   */
  open: boolean | undefined;
  /** Whether an engine holds a claim on its issue or PR. */
  claimed: boolean;
  /** Epoch millis it was last used. */
  lastUsedMs: number;
  /** Bytes it takes up on disk, or 0 when not measured. */
  sizeBytes: number;
  /**
   * False when its HEAD is detached at a commit no ref reaches — the leftovers
   * of an interrupted rebase, say — which removing it would lose for good.
   */
  headReachable: boolean;
  /** Its project's `checkout_retention_hours`, in milliseconds. */
  retentionMs: number;
}

/** Why a checkout is removed. */
export type RemovalReason =
  /** Its issue or PR is no longer open: closed, or merged. */
  | "closed"
  /** Unclaimed and untouched for longer than the retention period. */
  | "idle"
  /** Least recently used while the disk is short of space. */
  | "disk-pressure";

/** Why a checkout the reaper would otherwise consider is left alone. */
export type KeepReason = "claimed" | "unreachable-head";

export interface CheckoutRemoval {
  checkout: CheckoutState;
  reason: RemovalReason;
}

export interface CheckoutKept {
  checkout: CheckoutState;
  reason: KeepReason;
}

export interface ReapSelection {
  /** What to remove, in the order to remove it. */
  remove: CheckoutRemoval[];
  /** Checkouts left alone that are worth saying so about. */
  kept: CheckoutKept[];
  /** Free bytes once every removal is done, by the checkouts' sizes; undefined when free space is unknown. */
  projectedFreeBytes: number | undefined;
  /** True when free space is projected to stay below the minimum even after every removal. */
  stillLow: boolean;
}

/**
 * Decide which checkouts to remove. Pure: the state of every checkout and the
 * free space go in, the removals come out.
 *
 * A claimed checkout is never removed, nor one whose HEAD no ref reaches.
 * Every other checkout is removed when its issue or PR is no longer open, or
 * when it has gone unused for its project's retention period. If that leaves
 * free space below `minFreeBytes`, the rest are evicted least recently used
 * first until the checkouts' sizes say there will be enough. `minFreeBytes` of
 * 0, or free space that could not be read, turns that eviction off.
 */
export function selectCheckoutsToReap(input: {
  checkouts: readonly CheckoutState[];
  freeBytes: number | undefined;
  minFreeBytes: number;
  nowMs: number;
}): ReapSelection {
  const { checkouts, freeBytes, minFreeBytes, nowMs } = input;
  const remove: CheckoutRemoval[] = [];
  const kept: CheckoutKept[] = [];
  const evictable: CheckoutState[] = [];

  for (const checkout of checkouts) {
    if (checkout.claimed) {
      kept.push({ checkout, reason: "claimed" });
    } else if (!checkout.headReachable) {
      kept.push({ checkout, reason: "unreachable-head" });
    } else if (checkout.open === false) {
      remove.push({ checkout, reason: "closed" });
    } else if (nowMs - checkout.lastUsedMs >= checkout.retentionMs) {
      remove.push({ checkout, reason: "idle" });
    } else {
      evictable.push(checkout);
    }
  }

  if (freeBytes === undefined) {
    return { remove, kept, projectedFreeBytes: undefined, stillLow: false };
  }

  let projected = freeBytes + remove.reduce((sum, r) => sum + r.checkout.sizeBytes, 0);
  if (minFreeBytes > 0 && projected < minFreeBytes) {
    const leastRecentlyUsedFirst = [...evictable].sort(
      (a, b) => a.lastUsedMs - b.lastUsedMs || compareText(a.dir, b.dir),
    );
    for (const checkout of leastRecentlyUsedFirst) {
      if (projected >= minFreeBytes) break;
      remove.push({ checkout, reason: "disk-pressure" });
      projected += checkout.sizeBytes;
    }
  }
  return {
    remove,
    kept,
    projectedFreeBytes: projected,
    stillLow: minFreeBytes > 0 && projected < minFreeBytes,
  };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The claim key an engine working on this checkout's issue or PR holds. */
export function checkoutClaimKey(repoKey: string, kind: CheckoutKind, number: number): string {
  return kind === "issue" ? issueClaimKey(repoKey, number) : pullRequestClaimKey(repoKey, number);
}

const CHECKOUT_NAME = /^(issue|pr)-(\d+)$/;

/** What a project's checkouts need from its snapshot: which issues and PRs are open, if known. */
export interface OpenWork {
  /** Open issue numbers, or undefined when they could not be listed. */
  issueNumbers: ReadonlySet<number> | undefined;
  /** Open PR numbers, or undefined when they could not be listed. */
  pullRequestNumbers: ReadonlySet<number> | undefined;
}

/**
 * The open work a snapshot vouches for. A list whose fetch failed comes back
 * empty, and is reported as unknown here so that a GitHub hiccup cannot make
 * every checkout look finished.
 */
export function openWorkFromSnapshot(snapshot: RepositorySnapshot | null | undefined): OpenWork {
  if (!snapshot) return { issueNumbers: undefined, pullRequestNumbers: undefined };
  return {
    issueNumbers: snapshot.listingFailed?.issues
      ? undefined
      : new Set(snapshot.issues.filter((i) => i.state === "open").map((i) => i.number)),
    pullRequestNumbers: snapshot.listingFailed?.pullRequests
      ? undefined
      : new Set(snapshot.pullRequests.filter((p) => p.state === "open").map((p) => p.number)),
  };
}

/** One configured project, as the reaper needs it. */
export interface ReaperProject {
  repoKey: string;
  /** The project's canonical clone, `<checkout root>/<owner>-<repo>/_main`; its checkouts sit beside it. */
  canonicalDir: string;
  openWork: OpenWork;
  /** `checkout_retention_hours`, in milliseconds. */
  retentionMs: number;
}

/** Where a checkout's git state lives. */
type CheckoutGit =
  /** No `.git` at all: a directory left half-made or half-deleted. */
  | { kind: "none" }
  /** A linked worktree whose admin dir in `_main` is gone: nothing left to lose. */
  | { kind: "orphaned" }
  | { kind: "worktree"; gitDir: string }
  /** A standalone clone from before checkouts were worktrees, with refs of its own. */
  | { kind: "own-clone" };

async function readCheckoutGit(dir: string): Promise<CheckoutGit> {
  const gitPath = join(dir, ".git");
  let gitStat;
  try {
    gitStat = await lstat(gitPath);
  } catch {
    return { kind: "none" };
  }
  if (gitStat.isDirectory()) return { kind: "own-clone" };
  let content: string;
  try {
    content = await readFile(gitPath, "utf8");
  } catch {
    return { kind: "none" };
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!match) return { kind: "none" };
  // Relative when git is set to write relative worktree paths.
  const gitDir = resolve(dir, match[1]!);
  try {
    await stat(gitDir);
  } catch {
    return { kind: "orphaned" };
  }
  return { kind: "worktree", gitDir };
}

async function mtimeMs(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * When a checkout was last used: the latest of its directory's mtime (yoke
 * stamps it each time it prepares the checkout for a run) and of the files git
 * rewrites whenever the worktree is checked out, reset or committed to.
 */
async function lastUsedMs(dir: string, git: CheckoutGit): Promise<number> {
  const times = [await mtimeMs(dir)];
  if (git.kind === "worktree") {
    for (const file of ["index", "HEAD", join("logs", "HEAD")]) {
      times.push(await mtimeMs(join(git.gitDir, file)));
    }
  }
  return Math.max(...times);
}

async function gitSucceeds(dir: string, args: readonly string[]): Promise<boolean> {
  try {
    await runCommand("git", args, { cwd: dir, captureStdout: true, captureStderr: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether removing the worktree at `dir` loses no commits: its HEAD is on a
 * branch, or detached at a commit some ref reaches, or does not resolve to a
 * commit at all. A HEAD detached at a commit that only it holds — an
 * interrupted rebase's rewritten commits — is not, and when git cannot say,
 * the answer is no.
 */
export async function isHeadReachable(dir: string): Promise<boolean> {
  if (!(await gitSucceeds(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]))) return true;
  // On a branch: the branch ref in `_main` keeps the commit, and outlives the worktree.
  if (await gitSucceeds(dir, ["symbolic-ref", "-q", "HEAD"])) return true;
  try {
    const containing = await runCommand(
      "git",
      ["for-each-ref", "--contains", "HEAD", "--count=1", "--format=%(refname)"],
      { cwd: dir, captureStdout: true, captureStderr: true },
    );
    return containing.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * `isHeadReachable`, without spawning git for the usual case: a worktree whose
 * HEAD file names a branch keeps nothing that branch does not.
 */
async function worktreeHeadReachable(dir: string, gitDir: string): Promise<boolean> {
  try {
    if ((await readFile(join(gitDir, "HEAD"), "utf8")).startsWith("ref:")) return true;
  } catch {
    // Unreadable: let git decide.
  }
  return isHeadReachable(dir);
}

export interface ProjectCheckouts {
  checkouts: CheckoutState[];
  /** Standalone clones from older versions of yoke, left alone: their refs are their own. */
  ownClones: string[];
}

/** Every `issue-N` / `pr-N` checkout beside a project's canonical clone, with its state. */
export async function inspectProjectCheckouts(
  project: ReaperProject,
  claimedActions: ReadonlySet<string>,
): Promise<ProjectCheckouts> {
  const projectDir = dirname(project.canonicalDir);
  let names: string[];
  try {
    names = await readdir(projectDir);
  } catch {
    return { checkouts: [], ownClones: [] };
  }
  const checkouts: CheckoutState[] = [];
  const ownClones: string[] = [];
  for (const name of names.sort()) {
    const match = CHECKOUT_NAME.exec(name);
    if (!match) continue;
    const dir = join(projectDir, name);
    try {
      if (!(await lstat(dir)).isDirectory()) continue;
    } catch {
      continue;
    }
    const kind = match[1] as CheckoutKind;
    const number = Number.parseInt(match[2]!, 10);
    const git = await readCheckoutGit(dir);
    if (git.kind === "own-clone") {
      ownClones.push(dir);
      continue;
    }
    const openNumbers =
      kind === "issue" ? project.openWork.issueNumbers : project.openWork.pullRequestNumbers;
    checkouts.push({
      repoKey: project.repoKey,
      name,
      dir,
      kind,
      number,
      open: openNumbers === undefined ? undefined : openNumbers.has(number),
      claimed: claimedActions.has(checkoutClaimKey(project.repoKey, kind, number)),
      lastUsedMs: await lastUsedMs(dir, git),
      sizeBytes: 0,
      headReachable: git.kind === "worktree" ? await worktreeHeadReachable(dir, git.gitDir) : true,
      retentionMs: project.retentionMs,
    });
  }
  return { checkouts, ownClones };
}

/**
 * Remove one checkout, under the canonical-clone lock that already serializes
 * worktree add and prune for `_main`.
 *
 * A registered worktree is removed with `git worktree remove --force`, run from
 * `_main`, which deletes the directory — gitignored `node_modules` and all —
 * and its admin entry, and leaves its branch and commits in `_main`. A locked
 * worktree makes that fail, and is left as it is. A directory with no git state
 * of its own, or whose admin entry is already gone, holds nothing to lose and
 * is simply deleted.
 */
export async function removeCheckout(canonicalDir: string, dir: string): Promise<void> {
  await withCanonicalCloneLock(canonicalDir, async () => {
    const git = await readCheckoutGit(dir);
    if (git.kind === "own-clone") {
      throw new Error(`${dir} is a standalone clone, not a worktree of ${canonicalDir}`);
    }
    if (git.kind === "worktree") {
      await runCommand("git", ["worktree", "remove", "--force", dir], {
        cwd: canonicalDir,
        captureStdout: true,
        captureStderr: true,
      });
      return;
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await runCommand("git", ["worktree", "prune"], {
      cwd: canonicalDir,
      captureStdout: true,
      captureStderr: true,
    }).catch(() => {
      // No canonical clone to prune, or nothing registered: nothing to tidy.
    });
  });
}

/** What became of one checkout the reaper set out to remove. */
export interface RemovalOutcome {
  checkout: CheckoutState;
  reason: RemovalReason;
  /**
   * "removed"; "would-remove" in a dry run; "claimed" when an engine claimed
   * its work after it was chosen, so it was left; "failed" when removal threw.
   */
  status: "removed" | "would-remove" | "claimed" | "failed";
  /** Bytes it took up, freed when status is "removed". */
  sizeBytes: number;
  error?: string;
}

export interface CheckoutReaperReport {
  /** Checkouts found across every project, standalone clones excluded. */
  checkoutCount: number;
  /** Free bytes on the checkout root's filesystem before the pass; undefined when unreadable. */
  freeBytesBefore: number | undefined;
  /** Free bytes after the pass; undefined when unreadable. */
  freeBytesAfter: number | undefined;
  minFreeBytes: number;
  outcomes: RemovalOutcome[];
  /** Checkouts left because removing them would lose commits. */
  unreachable: CheckoutState[];
  /** Standalone clones from older versions of yoke, left alone. */
  ownClones: string[];
  /** Bytes freed by the removals. */
  freedBytes: number;
  /** Free space is still below the minimum after the pass. */
  low: boolean;
}

export interface CheckoutReaperOptions {
  projects: readonly ReaperProject[];
  /** The directory every project's checkouts live under. */
  checkoutRootDir: string;
  /** `min_free_disk_gb`, in bytes; 0 turns disk-pressure eviction off. */
  minFreeBytes: number;
  /** The engines' claims. A claimed checkout is never removed. */
  claimedActions: ReadonlySet<string>;
  /**
   * Shared with the planner (`claimNextAction`'s `reservedKeys`): the reaper
   * reserves a checkout's key for exactly as long as it is removing it, so no
   * engine can claim the work and start preparing that checkout meanwhile.
   */
  reservations: Set<string>;
  dryRun: boolean;
  nowMs?: number;
  /** Checked between removals: true stops the pass, so a shutdown is not kept waiting. */
  shouldStop?: () => boolean;
  /** Told of each removal as it happens, so a long pass shows progress. */
  onOutcome?: (outcome: RemovalOutcome) => void;
  /** Overridable for tests. */
  readFreeBytes?: (path: string) => Promise<number | undefined>;
  measureBytes?: (dir: string) => Promise<number>;
  remove?: (canonicalDir: string, dir: string) => Promise<void>;
}

/** One maintenance pass over every project's checkouts. */
export async function runCheckoutReaper(options: CheckoutReaperOptions): Promise<CheckoutReaperReport> {
  const readFree = options.readFreeBytes ?? readFreeBytes;
  const measure = options.measureBytes ?? measureDirectoryBytes;
  const remove = options.remove ?? removeCheckout;
  const nowMs = options.nowMs ?? Date.now();
  const { claimedActions, reservations, minFreeBytes } = options;

  await mkdir(options.checkoutRootDir, { recursive: true }).catch(() => {});

  const checkouts: CheckoutState[] = [];
  const ownClones: string[] = [];
  const canonicalDirByRepo = new Map<string, string>();
  for (const project of options.projects) {
    // Two projects naming one repository share its checkouts: look once.
    if (canonicalDirByRepo.has(project.repoKey)) continue;
    canonicalDirByRepo.set(project.repoKey, project.canonicalDir);
    const found = await inspectProjectCheckouts(project, claimedActions);
    checkouts.push(...found.checkouts);
    ownClones.push(...found.ownClones);
  }

  const freeBytesBefore = await readFree(options.checkoutRootDir);
  // Sizes cost a walk of each tree, so they are measured up front only when
  // the disk is short and they decide how much to evict.
  if (freeBytesBefore !== undefined && minFreeBytes > 0 && freeBytesBefore < minFreeBytes) {
    for (const checkout of checkouts) {
      if (!checkout.claimed && checkout.headReachable) {
        checkout.sizeBytes = await measure(checkout.dir);
      }
    }
  }

  const selection = selectCheckoutsToReap({
    checkouts,
    freeBytes: freeBytesBefore,
    minFreeBytes,
    nowMs,
  });

  const outcomes: RemovalOutcome[] = [];
  let freedBytes = 0;
  for (const { checkout, reason } of selection.remove) {
    if (options.shouldStop?.()) break;
    const report = (outcome: RemovalOutcome): void => {
      outcomes.push(outcome);
      options.onOutcome?.(outcome);
    };
    const sizeBytes = checkout.sizeBytes || (await measure(checkout.dir));
    const key = checkoutClaimKey(checkout.repoKey, checkout.kind, checkout.number);
    // Re-checked here, not trusted from the inspection above: an engine may
    // have claimed the work since. From this line until the reservation is
    // released, no engine can.
    if (!reserveUnclaimed(key, claimedActions, reservations)) {
      report({ checkout, reason, status: "claimed", sizeBytes });
      continue;
    }
    try {
      if (options.dryRun) {
        report({ checkout, reason, status: "would-remove", sizeBytes });
        continue;
      }
      await remove(canonicalDirByRepo.get(checkout.repoKey)!, checkout.dir);
      freedBytes += sizeBytes;
      report({ checkout, reason, status: "removed", sizeBytes });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const firstLine = message.split("\n").find((line) => line.trim() !== "") ?? message;
      report({ checkout, reason, status: "failed", sizeBytes, error: firstLine });
    } finally {
      reservations.delete(key);
    }
  }

  const freeBytesAfter = options.dryRun ? freeBytesBefore : await readFree(options.checkoutRootDir);
  return {
    checkoutCount: checkouts.length,
    freeBytesBefore,
    freeBytesAfter,
    minFreeBytes,
    outcomes,
    unreachable: selection.kept.filter((k) => k.reason === "unreachable-head").map((k) => k.checkout),
    ownClones,
    freedBytes,
    low: freeBytesAfter !== undefined && minFreeBytes > 0 && freeBytesAfter < minFreeBytes,
  };
}

function formatHours(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(0, Math.round(ms / 60_000))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Why a checkout was chosen for removal, in a few words. */
export function describeRemovalReason(
  removal: Pick<RemovalOutcome, "checkout" | "reason">,
  nowMs: number,
): string {
  const { checkout, reason } = removal;
  switch (reason) {
    case "closed":
      return checkout.kind === "issue"
        ? `issue #${checkout.number} is closed`
        : `PR #${checkout.number} is merged or closed`;
    case "idle":
      return `unused for ${formatHours(nowMs - checkout.lastUsedMs)} (keeps ${formatHours(checkout.retentionMs)})`;
    case "disk-pressure":
      return `least recently used (${formatHours(nowMs - checkout.lastUsedMs)} ago) while the disk is short of space`;
  }
}

/** One maintenance bullet for what became of a checkout the reaper set out to remove. */
export function describeRemovalOutcome(outcome: RemovalOutcome, nowMs: number): string {
  const label = `${outcome.checkout.repoKey} ${outcome.checkout.name}`;
  const why = describeRemovalReason(outcome, nowMs);
  switch (outcome.status) {
    case "removed":
      return `removed checkout ${label} — ${why} · freed ${formatBytes(outcome.sizeBytes)}`;
    case "would-remove":
      return `[dry-run] would remove checkout ${label} — ${why} · would free ${formatBytes(outcome.sizeBytes)}`;
    case "claimed":
      return `kept checkout ${label} — an engine claimed its work as it was about to be removed`;
    case "failed":
      return `could not remove checkout ${label} (${why}): ${outcome.error ?? "unknown error"}`;
  }
}

/** A reading of the checkout root's free space, for the hold and the dashboard. */
export interface DiskSpaceReading {
  /** The directory whose filesystem was read. */
  path: string;
  freeBytes: number;
  minFreeBytes: number;
}

/**
 * The hold that stops engines starting new work while the disk is short of
 * space even after every unclaimed checkout that could go has gone — rather
 * than let git, or a dependency install, fail partway through a run on a full
 * disk. Set and lifted by engine 0's maintenance; read by every engine before
 * it plans. Unlike the Claude quota hold it has no deadline: it lasts until a
 * pass finds enough room again.
 */
export class DiskSpaceHold {
  private reading: DiskSpaceReading | undefined;

  /** The reading that put the hold on, or undefined when there is none. */
  get active(): DiskSpaceReading | undefined {
    return this.reading;
  }

  /**
   * Record whether the disk is still short. Returns "held" when this puts the
   * hold on, "released" when it lifts it, and undefined when nothing changed —
   * so the change is announced once, not on every pass.
   */
  update(reading: DiskSpaceReading, low: boolean): "held" | "released" | undefined {
    const wasHeld = this.reading !== undefined;
    this.reading = low ? reading : undefined;
    if (low && !wasHeld) return "held";
    if (!low && wasHeld) return "released";
    return undefined;
  }
}
