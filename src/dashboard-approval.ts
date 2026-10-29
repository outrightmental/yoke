import { ALREADY_APPROVED_REASON, approvePullRequest, type ActionSessionStore } from "./actions.js";
import type { EventEmitter } from "./event-emitter.js";
import { latestSessionIsApproval } from "./orchestrator.js";
import { pullRequestClaimKey, type ShutdownSignal } from "./scheduler.js";
import type { AgentSession, RepositorySnapshot } from "./types.js";

/**
 * Dashboard approvals (#274) as the dashboard sees them (#276).
 *
 * Pressing Approve used to leave the pill guessing: yoke wrote what became of
 * the request only to the log, so after a fixed 20 s the button went back to
 * Approve whether the approval was still queued, refused or failed — and a
 * second press, made because the first looked lost, was refused because of the
 * first. Now every attempt reports where it stands, in a `pull-request-approval`
 * event, from the moment it is received until it ends, and a PR has at most one
 * attempt in flight.
 */

/** Where one dashboard approval of one PR stands. */
export type PullRequestApprovalState =
  /** Received; reading the PR from GitHub. */
  | "loading"
  /** PR read; waiting for the planning mutex. */
  | "waiting"
  /** Recorded: an engine will squash-merge it, or already is. */
  | "approved"
  /** Not approved, for `reason`. */
  | "refused"
  /** An unexpected error; `reason` is its first line. */
  | "failed";

/** The `pull-request-approval` event's data. */
export type PullRequestApproval = {
  /** "owner/repo". */
  repo: string;
  pullRequestNumber: number;
  /** ISO time the server received the request that started this attempt. */
  requestedAt: string;
  state: PullRequestApprovalState;
  /** For `refused` and `failed`: the same words the log line uses. */
  reason?: string;
  /** For `approved`: the merge waits for checks. */
  checksPending?: boolean;
  /** For `approved`: an earlier approval stands, so this press changed nothing. */
  alreadyApproved?: boolean;
};

/** How an attempt came out, decided under the planning mutex. */
export type ApprovalDecision =
  | {
      state: "approved";
      checksPending: boolean;
      /** False when this attempt recorded the approval. */
      alreadyApproved: boolean;
      /** For an earlier approval: an engine is already carrying it out. */
      merging?: boolean;
    }
  | { state: "refused"; reason: string };

export const SHUTTING_DOWN_REASON = "yoke is shutting down and will start no new work";
export const ENGINE_WORKING_REASON = "an engine is working on it";

/** The key one PR's approval is known by, here and on the dashboard. */
export function approvalKey(repo: string, pullRequestNumber: number): string {
  return `${repo}#${pullRequestNumber}`;
}

/**
 * Under the planning mutex, so no engine can claim the PR between these checks
 * and the approval being recorded: decide a dashboard approval, recording it
 * when it goes through. Reads the session store into `snapshot` first, and
 * again after recording.
 *
 * A press that finds the PR already approved is not a refusal (#276): it is
 * what a second press, or a press on another dashboard, sees once the first
 * has gone through — whether that approval is still waiting for an engine or
 * an engine is already squash-merging the PR because of it.
 */
export async function decideApproval(params: {
  repoKey: string;
  pullRequestNumber: number;
  snapshot: RepositorySnapshot;
  sessionStore: ActionSessionStore & { load(): Promise<AgentSession[]> };
  claimedActions: ReadonlySet<string>;
  shutdownSignal: ShutdownSignal;
  projectModeEnabled: boolean;
  dryRun: boolean;
}): Promise<ApprovalDecision> {
  const { repoKey, pullRequestNumber, snapshot, sessionStore } = params;
  if (params.shutdownSignal.requested) {
    return { state: "refused", reason: SHUTTING_DOWN_REASON };
  }
  snapshot.agentSessions = await sessionStore.load();
  const pullRequest = snapshot.pullRequests.find((candidate) => candidate.number === pullRequestNumber);
  const checksPending = pullRequest?.checksStatus === "pending";
  if (params.claimedActions.has(pullRequestClaimKey(repoKey, pullRequestNumber))) {
    const approved = latestSessionIsApproval(
      { number: pullRequestNumber, linkedIssueNumbers: pullRequest?.linkedIssueNumbers ?? [] },
      snapshot.agentSessions,
    );
    return approved
      ? { state: "approved", checksPending, alreadyApproved: true, merging: true }
      : { state: "refused", reason: ENGINE_WORKING_REASON };
  }
  const outcome = await approvePullRequest(sessionStore, snapshot, pullRequestNumber, {
    projectModeEnabled: params.projectModeEnabled,
    dryRun: params.dryRun,
  });
  if (outcome.approved) {
    snapshot.agentSessions = await sessionStore.load();
    return { state: "approved", checksPending: outcome.checksPending, alreadyApproved: false };
  }
  if (outcome.reason === ALREADY_APPROVED_REASON) {
    return { state: "approved", checksPending, alreadyApproved: true };
  }
  return { state: "refused", reason: outcome.reason };
}

/** What one attempt needs from the engine pool, in the order it uses them. */
export interface ApprovalSteps<Snapshot> {
  /** The PR's GitHub URL, for the request's log line. */
  url: string;
  /** Write one line to the log. */
  log(line: string): void;
  /** Log an unexpected failure, which may run to several lines. */
  logFailure(text: string): void;
  shutdownSignal: ShutdownSignal;
  /** Read the PR as GitHub has it now. Runs before the lock. */
  loadSnapshot(): Promise<Snapshot>;
  /** Run `fn` under the planning mutex, ahead of the engines' planning passes. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Under the lock: decide the approval, recording it when it goes through. */
  decide(snapshot: Snapshot): Promise<ApprovalDecision>;
  /** After the lock, for an approval this attempt recorded: show it on the pill,
   *  wake the pool, comment on the PR. */
  announce(snapshot: Snapshot, checksPending: boolean): Promise<void>;
}

/** "41s", "3m 11s". */
function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const remainder = seconds % 60;
  return remainder === 0 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 60)}m ${remainder}s`;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]?.trim() || "unknown error";
}

/**
 * The dashboard approvals an engine pool has in flight: at most one per PR.
 *
 * Each attempt emits a `pull-request-approval` at every step — `loading`
 * before reading the PR, `waiting` before taking the planning mutex, and
 * exactly one of `approved`, `refused` or `failed` when it ends, on every
 * path. A press on a PR that already has an attempt in flight starts nothing:
 * it gets that attempt's state again, so the second press has its answer too.
 */
export class DashboardApprovals {
  private readonly inFlight = new Map<string, PullRequestApproval>();

  constructor(
    private readonly emitter: Pick<EventEmitter, "emit">,
    private readonly nowMs: () => number = Date.now,
  ) {}

  /** The state of the attempt in flight for a PR, if there is one. */
  inFlightFor(repo: string, pullRequestNumber: number): PullRequestApproval | undefined {
    return this.inFlight.get(approvalKey(repo, pullRequestNumber));
  }

  /** Handle one confirmed press of Approve. Resolves when its attempt ends; never rejects. */
  request<Snapshot>(repo: string, pullRequestNumber: number, steps: ApprovalSteps<Snapshot>): Promise<void> {
    const key = approvalKey(repo, pullRequestNumber);
    const label = `${repo} PR #${pullRequestNumber}`;
    const current = this.inFlight.get(key);
    if (current !== undefined) {
      const ageMs = this.nowMs() - Date.parse(current.requestedAt);
      steps.log(
        `Approve requested on the dashboard: ${label} — already in progress (requested ${formatElapsed(ageMs)} ago)`,
      );
      this.emit(current);
      return Promise.resolve();
    }
    return this.attempt(key, label, { repo, pullRequestNumber }, steps);
  }

  private emit(status: PullRequestApproval): void {
    this.emitter.emit("pull-request-approval", { ...status });
  }

  private async attempt<Snapshot>(
    key: string,
    label: string,
    pr: { repo: string; pullRequestNumber: number },
    steps: ApprovalSteps<Snapshot>,
  ): Promise<void> {
    const startedMs = this.nowMs();
    let status: PullRequestApproval = { ...pr, requestedAt: new Date(startedMs).toISOString(), state: "loading" };
    // Registered before the first await, so a press handled meanwhile finds it.
    this.inFlight.set(key, status);
    let ended = false;
    const update = (next: Omit<PullRequestApproval, "repo" | "pullRequestNumber" | "requestedAt">) => {
      status = { ...pr, requestedAt: status.requestedAt, ...next };
      this.inFlight.set(key, status);
      this.emit(status);
    };
    const end = (next: Omit<PullRequestApproval, "repo" | "pullRequestNumber" | "requestedAt">) => {
      if (ended) return;
      ended = true;
      update(next);
    };

    let waitingSinceMs: number | undefined;
    let lockedAtMs: number | undefined;
    // "after 41s (waited 30s for the planner)", so a slow approval can be
    // diagnosed from the log alone.
    const timing = (): string => {
      const nowMs = this.nowMs();
      const total = `after ${formatElapsed(nowMs - startedMs)}`;
      if (waitingSinceMs === undefined) return total;
      return `${total} (waited ${formatElapsed((lockedAtMs ?? nowMs) - waitingSinceMs)} for the planner)`;
    };

    try {
      steps.log(`Approve requested on the dashboard: ${label} (${steps.url})`);
      if (steps.shutdownSignal.requested) {
        steps.log(`  ✗ not approved: ${SHUTTING_DOWN_REASON}.`);
        end({ state: "refused", reason: SHUTTING_DOWN_REASON });
        return;
      }
      update({ state: "loading" });
      const snapshot = await steps.loadSnapshot();
      waitingSinceMs = this.nowMs();
      update({ state: "waiting" });
      const decision = await steps.withLock(async () => {
        lockedAtMs = this.nowMs();
        return steps.decide(snapshot);
      });
      if (decision.state === "refused") {
        steps.log(`  ✗ not approved ${timing()}: ${decision.reason}.`);
        end({ state: "refused", reason: decision.reason });
        return;
      }
      const next = decision.merging
        ? "an engine is merging it"
        : decision.checksPending
          ? "it will be squash-merged once its checks pass"
          : "an engine will squash-merge it next";
      steps.log(`  ✓ ${decision.alreadyApproved ? "already approved" : "approved"} ${timing()} — ${next}.`);
      end({ state: "approved", checksPending: decision.checksPending, alreadyApproved: decision.alreadyApproved });
      if (!decision.alreadyApproved) await steps.announce(snapshot, decision.checksPending);
    } catch (error) {
      steps.logFailure(
        `  ✗ approving ${label} failed ${timing()}: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }`,
      );
      end({ state: "failed", reason: firstLine(error) });
    } finally {
      this.inFlight.delete(key);
    }
  }
}
