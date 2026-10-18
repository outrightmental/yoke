import type { RepositorySnapshot } from "./types.js";

/**
 * How long the issues a just-merged PR closes stay hidden from planning while
 * GitHub gets around to closing them.
 *
 * GitHub closes a PR's linked issues asynchronously, a second or two after the
 * merge. A planner that fetched a snapshot inside that window saw the PR gone
 * but the issue still open — an open issue with no PR — and started a fresh
 * implementation of work that had just shipped (butterfly #402, 2026-10-18).
 */
export const MERGED_ISSUE_GRACE_MS = 2 * 60_000;

/**
 * Per-project memory of issues whose closing PR was just merged. Until GitHub
 * reports each one closed (or the grace window lapses), snapshots are served
 * without it, so no engine can re-plan it.
 */
export class MergedIssueGrace {
  private readonly expiresAtMs = new Map<number, number>();

  constructor(private readonly graceMs: number = MERGED_ISSUE_GRACE_MS) {}

  /** Remember that a merge just closed these issues. */
  add(issueNumbers: Iterable<number>, now: number = Date.now()): void {
    for (const n of issueNumbers) this.expiresAtMs.set(n, now + this.graceMs);
  }

  /** Issue numbers still inside their grace window, ascending. */
  pending(now: number = Date.now()): number[] {
    this.prune(now);
    return [...this.expiresAtMs.keys()].sort((a, b) => a - b);
  }

  /**
   * Hide from `snapshot` every issue GitHub still lists as open although a PR
   * closing it was just merged. An issue that has left the open list is
   * forgotten — GitHub caught up — as is one whose grace window has lapsed, so
   * a merge whose PR did not actually close its issue cannot park that issue
   * for good. Returns the (possibly same) snapshot and the issues it dropped.
   */
  apply(
    snapshot: RepositorySnapshot,
    now: number = Date.now(),
  ): { snapshot: RepositorySnapshot; dropped: number[] } {
    this.prune(now);
    if (this.expiresAtMs.size === 0) return { snapshot, dropped: [] };

    const stillOpen = new Set(snapshot.issues.map((issue) => issue.number));
    for (const n of [...this.expiresAtMs.keys()]) {
      if (!stillOpen.has(n)) this.expiresAtMs.delete(n);
    }

    const dropped = snapshot.issues
      .filter((issue) => this.expiresAtMs.has(issue.number))
      .map((issue) => issue.number);
    if (dropped.length === 0) return { snapshot, dropped };
    return {
      snapshot: {
        ...snapshot,
        issues: snapshot.issues.filter((issue) => !this.expiresAtMs.has(issue.number)),
      },
      dropped,
    };
  }

  private prune(now: number): void {
    for (const [n, expiresAt] of this.expiresAtMs) {
      if (expiresAt <= now) this.expiresAtMs.delete(n);
    }
  }
}
