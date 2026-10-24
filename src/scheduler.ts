import type { OrchestratorAction } from "./types.js";

/**
 * Shared-pool scheduling primitives.
 *
 * Yoke runs a single global pool of `max_concurrency` engine cylinders that
 * roam across every configured project. Each project additionally declares its
 * own concurrency cap — the maximum number of those shared cylinders that may
 * work that project at any one time. These pure helpers encode the claim
 * accounting that enforces both limits; `index.ts` drives them with live
 * GitHub snapshots, and they are unit-tested in isolation.
 */

/**
 * Stable key for the *resource* an action operates on (an issue or a PR),
 * deliberately NOT the action type — so two cylinders can never run different
 * actions against the same PR concurrently.
 */
export function actionResourceKey(action: OrchestratorAction): string {
  if (action.type === "start-implementation") {
    return `issue:${action.issueNumber}`;
  }
  return pullRequestResourceKey(action.pullRequestNumber);
}

function pullRequestResourceKey(pullRequestNumber: number): string {
  return `pr:${pullRequestNumber}`;
}

/**
 * Claim key namespaced by project. The same issue/PR number can exist in two
 * repositories; the repo prefix keeps their claims distinct and lets us count,
 * per project, how many of the shared cylinders are busy on it.
 */
export function repoActionKey(repoKey: string, action: OrchestratorAction): string {
  return `${repoKey} ${actionResourceKey(action)}`;
}

/** The claim key any action on a project's PR holds — see `repoActionKey`. */
export function pullRequestClaimKey(repoKey: string, pullRequestNumber: number): string {
  return `${repoKey} ${pullRequestResourceKey(pullRequestNumber)}`;
}

/** Number of currently-claimed actions belonging to a given project. */
export function claimsForRepo(claimedActions: ReadonlySet<string>, repoKey: string): number {
  const prefix = `${repoKey} `;
  let count = 0;
  for (const key of claimedActions) {
    if (key.startsWith(prefix)) count += 1;
  }
  return count;
}

/**
 * Issue numbers with a currently-claimed `start-implementation` action for a
 * given project. Used to keep in-flight implementations rendering as "planning"
 * in that project's lifecycle pane even after the planner drops the issue.
 */
export function claimedImplementationIssueNumbers(
  claimedActions: ReadonlySet<string>,
  repoKey: string,
): Set<number> {
  const prefix = `${repoKey} issue:`;
  const issueNumbers = new Set<number>();
  for (const key of claimedActions) {
    if (key.startsWith(prefix)) {
      const n = Number.parseInt(key.slice(prefix.length), 10);
      if (!Number.isNaN(n)) issueNumbers.add(n);
    }
  }
  return issueNumbers;
}

/**
 * Try to claim the first not-yet-claimed action from a project's plan, provided
 * the project is still below its concurrency cap. Mutates `claimedActions` by
 * adding the chosen key and returns the claimed action, or null when the
 * project is at its cap or has no unclaimed actions.
 *
 * Callers iterate projects in configured order and stop at the first claim, so
 * earlier projects are preferred and no project ever exceeds its cap.
 */
export function tryClaimFromPlan(
  repoKey: string,
  cap: number,
  actions: readonly OrchestratorAction[],
  claimedActions: Set<string>,
  /**
   * Action key → epoch millis before which the action must not be retried.
   * Without this a failing action is re-claimed immediately: after a long
   * action the cycle-minimum wait computes to zero, so six cylinders re-picked
   * the same six timed-out issues roughly twenty seconds later and burned
   * another full timeout on each.
   */
  cooldownUntilMs?: ReadonlyMap<string, number>,
  now: number = Date.now(),
): OrchestratorAction | null {
  if (claimsForRepo(claimedActions, repoKey) >= cap) {
    return null;
  }
  for (const action of actions) {
    const key = repoActionKey(repoKey, action);
    if (claimedActions.has(key)) continue;
    const until = cooldownUntilMs?.get(key);
    if (until !== undefined && now < until) continue;
    claimedActions.add(key);
    return action;
  }
  return null;
}

/**
 * The pool-wide stop order, set by Escape or the first Ctrl-C. Once it is set
 * no engine may begin new Claude work — no planning pass, no claim, no fresh
 * action — while work already under way is left to finish.
 */
export interface ShutdownSignal {
  readonly requested: boolean;
}

/** Serialises planning across all engines to prevent double-booking. */
export class PlanningMutex {
  private locked = false;
  private waiting: Array<() => void> = [];

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (this.locked) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.locked = true;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.locked = false;
      }
    }
  }
}

/**
 * Scan every project (in configured order) for the first claimable action,
 * honouring each project's concurrency cap. Run under the planning mutex so the
 * claim it makes is visible to the next engine before it plans.
 *
 * The stop order is re-read before each project and again after each plan
 * loads, immediately before the (synchronous) claim. Checking it only at the
 * top of the engine cycle let a pass that was already under way — queued
 * behind other engines for the mutex, or awaiting GitHub for a snapshot — go on
 * to claim an issue and launch a fresh Claude run after the order was given.
 */
export async function claimNextAction<
  P extends { repoKey: string; cap: number },
  Plan extends { actions: readonly OrchestratorAction[] },
>(params: {
  projects: readonly P[];
  /** Load a project's current plan, or undefined to skip it this pass. */
  loadPlan: (project: P) => Promise<Plan | undefined>;
  /** Called for each project planned this pass, after any claim on it. */
  onPlanned?: (project: P, plan: Plan) => void;
  claimedActions: Set<string>;
  cooldownUntilMs?: ReadonlyMap<string, number>;
  shutdownSignal: ShutdownSignal;
}): Promise<{ project: P; plan: Plan; action: OrchestratorAction } | null> {
  const { projects, loadPlan, onPlanned, claimedActions, cooldownUntilMs, shutdownSignal } = params;
  for (const project of projects) {
    if (shutdownSignal.requested) return null;
    if (claimsForRepo(claimedActions, project.repoKey) >= project.cap) continue;
    const plan = await loadPlan(project);
    if (shutdownSignal.requested) return null;
    if (plan === undefined) continue;
    const action = tryClaimFromPlan(project.repoKey, project.cap, plan.actions, claimedActions, cooldownUntilMs);
    onPlanned?.(project, plan);
    if (action) return { project, plan, action };
  }
  return null;
}

/**
 * The last gate before an engine fires an action it has claimed. If the stop
 * order has landed since the claim, the claim is released — so the resource is
 * not left held by an engine that will never run it — and the engine must not
 * fire. Returns true when the engine may go ahead.
 */
export function clearToFire(
  repoKey: string,
  action: OrchestratorAction,
  claimedActions: Set<string>,
  shutdownSignal: ShutdownSignal,
): boolean {
  if (!shutdownSignal.requested) return true;
  claimedActions.delete(repoActionKey(repoKey, action));
  return false;
}

/**
 * Wakes the engines sleeping out their cycle minimum, so they plan again on
 * their next poll rather than at the end of the wait — for work that appears
 * between cycles because a human asked for it, like the squash-merge of a PR
 * approved on the dashboard (#274). Each sleep takes a token when it starts
 * and ends early once `wake()` has been called since.
 */
export class PoolWake {
  private generation = 0;

  wake(): void {
    this.generation += 1;
  }

  token(): number {
    return this.generation;
  }

  wokenSince(token: number): boolean {
    return this.generation !== token;
  }
}

/**
 * How long an engine should sleep before re-checking the shared Claude usage
 * limit, or 0 when no hold is active.
 *
 * While the CLI reports its subscription quota exhausted, every Claude action
 * is doomed until the reset, so engines pause instead of claiming work,
 * preparing checkouts and failing on every cycle. Engine 0 still owns the
 * between-cycle maintenance (workflow approvals, reconciliation, the feed), so
 * it sleeps at most one cycle minimum at a time; the others sleep out the hold.
 */
export function claudeQuotaHoldWaitMs(params: {
  blockedUntilMs: number | undefined;
  nowMs: number;
  engineIndex: number;
  cycleMinimumMs: number;
}): number {
  const { blockedUntilMs, nowMs, engineIndex, cycleMinimumMs } = params;
  if (blockedUntilMs === undefined || blockedUntilMs <= nowMs) return 0;
  const remainingMs = blockedUntilMs - nowMs;
  return engineIndex === 0 ? Math.min(remainingMs, Math.max(cycleMinimumMs, 1)) : remainingMs;
}

/**
 * One voice for a hold that every engine can see.
 *
 * A usage limit or a rate limit is a single shared deadline, so on the cycle it
 * trips, every engine in the pool discovers the same hold at the same moment.
 * Letting each narrate it is what produced the duplicate failures this
 * replaced. Routing the announcement through one of these makes the CLI log and
 * the dashboard say it once — and say "resumed" once — however many engines are
 * parked on it, while still re-announcing when the cause or the deadline
 * actually changes.
 */
export class HoldAnnouncer {
  private announced: { key: string; untilMs: number } | undefined;

  /** True for the one caller that should announce this hold. */
  enter(key: string, untilMs: number): boolean {
    if (this.announced?.key === key && this.announced.untilMs === untilMs) return false;
    this.announced = { key, untilMs };
    return true;
  }

  /** True for the one caller that should announce work resuming. */
  exit(): boolean {
    if (this.announced === undefined) return false;
    this.announced = undefined;
    return true;
  }

  /** The hold currently announced, if any. */
  current(): { key: string; untilMs: number } | undefined {
    return this.announced;
  }
}
