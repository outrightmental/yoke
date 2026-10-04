import { setTimeout as delay } from "node:timers/promises";
import * as fs from "node:fs";
import * as path from "node:path";

import { executeAction, type ExecuteActionResult } from "./actions.js";
import {
  announceWait,
  CLAUDE_QUOTA_WAIT_KEY,
  clearWait,
  createClaudeAgentClient,
  DEFAULT_COMMIT_MODEL,
  formatWaitStatusLine,
  getClaudeQuotaHold,
  isClaudeUsageLimitMessage,
  validateClaudeAuth,
  writeLogLine,
  setLogSink,
  countLiveClaudeRuns,
} from "./claude-agent.js";
import { loadEnvConfig, resolveGitHubToken, applyProjectDefaults, type EnvConfig, type ProjectEnvConfig } from "./env-config.js";
import {
  buildDefaultSessionStorePath,
  buildLegacySessionStorePath,
  GitHubClient,
  loadSnapshot,
} from "./github.js";
import { GitHubApiGateway } from "./github-gateway.js";
import { buildPlan, FOCUS_LABEL, REVIEW_LABEL, type ProjectModeConfig } from "./orchestrator.js";
import {
  repoActionKey,
  claimsForRepo,
  claimedImplementationIssueNumbers,
  claudeQuotaHoldWaitMs,
  HoldAnnouncer,
  tryClaimFromPlan,
} from "./scheduler.js";
import { reconcileSessions } from "./reconcile.js";
import { FileSessionStore, migrateLegacySessionStore } from "./session-store.js";
import { DashboardServer } from "./dashboard-server.js";
import { resolveDashboardTitle } from "./dashboard-title.js";
import { globalEventEmitter, EventEmitter } from "./event-emitter.js";
import {
  broadcastRepositorySnapshot,
  broadcastPullRequestUpdate,
  broadcastIssueUpdate,
  broadcastCommit,
  broadcastReviewComment,
  broadcastLifecycleUpdate,
  emitLogMessage,
  hasPrStateChanged,
  filterNewCommits,
} from "./dashboard-utils.js";
import type {
  AgentSession,
  OrchestratorAction,
  RepositorySnapshot,
} from "./types.js";

const RULE = "─".repeat(80);
const HEAVY_RULE = "═".repeat(80);

/**
 * How long a project's snapshot may be reused across engine planning passes
 * before it is reloaded. Several engines plan in quick succession under the
 * shared planning mutex; this lets them reuse one fetch instead of each hitting
 * GitHub. Kept short so freshly-completed work disappears from plans quickly.
 */
const SNAPSHOT_FRESH_MS = 8000;

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ─── Exit diagnostics ────────────────────────────────────────────────────────
//
// Four different code paths used to end this process silently, three of them
// with status 0: Ctrl-C, SIGTERM/SIGHUP, and a normal finish. That made a
// deliberate stop, an external kill and a fatal error indistinguishable — from
// the terminal, from `npm`, and from anything left on disk afterwards. An
// incident that destroyed six in-flight agent runs had to be reconstructed from
// the mtime of an npm debug log, because yoke itself wrote nothing.

let exitReason: string | undefined;

/** Record why the process is about to end, for the exit banner and the log. */
export function setExitReason(reason: string): void {
  exitReason = exitReason ?? reason;
}

/**
 * Install the process-level diagnostics: a persistent log file, an exit banner
 * naming the reason, and handlers for the two failure modes that previously
 * died with nothing but whatever Node printed to a terminal nobody kept.
 */
function installExitDiagnostics(): void {
  let appendToLog: ((line: string) => void) | undefined;
  try {
    const logDir = path.join(process.cwd(), ".yoke");
    fs.mkdirSync(logDir, { recursive: true });
    const stream = fs.createWriteStream(path.join(logDir, "yoke.log"), { flags: "a" });
    stream.on("error", () => {});
    appendToLog = (line: string) => stream.write(`[${timestamp()}] ${line}\n`);
    setLogSink(appendToLog);
  } catch {
    // Running somewhere unwritable is not a reason to refuse to run.
  }

  const record = (line: string): void => {
    try {
      appendToLog?.(line);
    } catch {
      // Ignore: diagnostics must never throw from a handler.
    }
    process.stderr.write(`${line}\n`);
  };

  process.on("uncaughtException", (error) => {
    setExitReason("uncaughtException");
    record(`[yoke] FATAL uncaughtException: ${error?.stack ?? String(error)}`);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    setExitReason("unhandledRejection");
    record(
      `[yoke] FATAL unhandledRejection: ${
        reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
      }`,
    );
    process.exit(1);
  });

  process.on("exit", (code) => {
    const live = countLiveClaudeRuns();
    record(
      `[yoke] exiting code=${code} reason=${exitReason ?? "normal"}` +
        (live > 0 ? ` (killing ${live} in-flight child process(es))` : ""),
    );
  });
}

// All terminal output goes through writeLogLine rather than console.log: the
// Claude status board owns the bottom rows of the terminal and erases whatever
// it finds there every 500 ms, which silently destroyed every error yoke
// printed while any run was in flight.
function write(line: string): void {
  writeLogLine(line);
  emitLogMessage("info", line);
}

function blank(): void {
  writeLogLine("");
}

/** Log a failure at top level, one line per line so nothing is swallowed. */
function failure(text: string): void {
  for (const line of String(text).split("\n")) write(line);
}

function createLogger(emitter: EventEmitter, repo = "") {
  function write(line: string): void {
    writeLogLine(line);
    emitLogMessage("info", line, emitter, repo);
  }
  function blank(): void { writeLogLine(""); }
  function section(title: string): void { blank(); write(title); write(RULE); }
  function bullet(text: string, indent = 1): void { write(`${"  ".repeat(indent)}• ${text}`); }
  function note(text: string, indent = 1): void { write(`${"  ".repeat(indent)}${text}`); }
  /** Log a failure. Multi-line reasons are indented so none of it is mistaken for a new event. */
  function failure(text: string, indent = 1): void {
    const pad = "  ".repeat(indent);
    for (const line of String(text).split("\n")) write(`${pad}${line}`);
  }
  return { write, blank, section, bullet, note, failure };
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Shared across the whole pool so a hold every engine can see is announced
 * once, not once per engine. See `HoldAnnouncer`.
 */
const holdAnnouncer = new HoldAnnouncer();

/** Serialises planning across all engines to prevent double-booking. */
class PlanningMutex {
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
 * Per-action failure memory, shared by the whole engine pool.
 *
 * A failed action used to be retried as fast as the pool could pick it up: the
 * cycle-minimum wait is computed as `cycleMinimum - elapsed`, so after any
 * action longer than the cycle minimum it is zero. Six cylinders therefore
 * re-claimed the same six issues about twenty seconds after they failed and
 * spent another full run failing the same way.
 */
interface ActionCooldowns {
  /** Action key → epoch millis before which it must not be claimed again. */
  until: Map<string, number>;
  /** Action key → consecutive failure count, for the backoff schedule. */
  failures: Map<string, number>;
  /** Record a failure and start the next cooldown. Returns its length in ms. */
  recordFailure(key: string): number;
  /** Clear the memory for an action that has now succeeded. */
  recordSuccess(key: string): void;
}

/** Backoff after consecutive failures of the same action, capped at the last entry. */
const ACTION_FAILURE_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

function createActionCooldowns(): ActionCooldowns {
  const until = new Map<string, number>();
  const failures = new Map<string, number>();
  return {
    until,
    failures,
    recordFailure(key: string): number {
      const count = (failures.get(key) ?? 0) + 1;
      failures.set(key, count);
      const backoff =
        ACTION_FAILURE_BACKOFF_MS[Math.min(count, ACTION_FAILURE_BACKOFF_MS.length) - 1] ??
        ACTION_FAILURE_BACKOFF_MS[ACTION_FAILURE_BACKOFF_MS.length - 1]!;
      until.set(key, Date.now() + backoff);
      return backoff;
    },
    recordSuccess(key: string): void {
      failures.delete(key);
      until.delete(key);
    },
  };
}

interface PollingState {
  lastPolledAt: number;
  lastSnapshot: RepositorySnapshot | null;
  seenCommitHashes: Set<string>;
}

/**
 * Per-project runtime: the GitHub/Claude clients, session store, polling state,
 * concurrency cap, and a short-lived snapshot cache shared across the engine
 * pool. One exists per configured project; the shared engine pool roams across
 * all of them.
 */
interface ProjectContext {
  config: Config;
  /** "owner/repo" — the project identity shown on every dashboard element. */
  repoKey: string;
  githubGateway: GitHubApiGateway;
  githubToken: string;
  gitHubClient: GitHubClient;
  sessionStore: FileSessionStore;
  claudeAgentClient: ReturnType<typeof createClaudeAgentClient>;
  pollingState: PollingState;
  /** Cap on how many of the shared cylinders may work this project at once. */
  cap: number;
  snapshotCache: { snapshot: RepositorySnapshot; atMs: number } | null;
  lastMaintenanceAtMs: number;
}

async function loadProjectSnapshot(ctx: ProjectContext): Promise<RepositorySnapshot> {
  return loadSnapshot(
    ctx.gitHubClient,
    ctx.sessionStore,
    ctx.config.projectMode ? { projectNumber: ctx.config.projectMode.projectNumber } : undefined,
  );
}

/** Returns a recent snapshot, reusing the cache while it is still fresh. */
async function getProjectSnapshot(ctx: ProjectContext): Promise<RepositorySnapshot> {
  const now = Date.now();
  if (ctx.snapshotCache && now - ctx.snapshotCache.atMs < SNAPSHOT_FRESH_MS) {
    return ctx.snapshotCache.snapshot;
  }
  const snapshot = await loadProjectSnapshot(ctx);
  ctx.snapshotCache = { snapshot, atMs: now };
  return snapshot;
}

async function broadcastBetweenCycleActivity(
  ctx: ProjectContext,
  claimedActions: ReadonlySet<string>,
  emitter: EventEmitter,
): Promise<void> {
  const { config, pollingState } = ctx;
  const repoKey = ctx.repoKey;
  try {
    const snapshot = await loadProjectSnapshot(ctx);
    ctx.snapshotCache = { snapshot, atMs: Date.now() };
    const lastSnapshot = pollingState.lastSnapshot;

    const lastPrMap = lastSnapshot
      ? new Map(lastSnapshot.pullRequests.map((p) => [p.number, p]))
      : null;
    const snapshotChanged = !lastSnapshot ||
      lastSnapshot.issues.length !== snapshot.issues.length ||
      lastSnapshot.pullRequests.length !== snapshot.pullRequests.length ||
      lastSnapshot.agentSessions.filter((s) => s.status === "in_progress").length !==
        snapshot.agentSessions.filter((s) => s.status === "in_progress").length;
    if (snapshotChanged) {
      broadcastRepositorySnapshot(snapshot, config.owner, config.repo, undefined, emitter);
    }
    const { blockedIssueNumbers } = buildPlan(snapshot, ctx.cap, config.projectMode, config.focusMode);
    broadcastLifecycleUpdate(
      snapshot,
      claimedImplementationIssueNumbers(claimedActions, repoKey),
      new Set(),
      blockedIssueNumbers,
      config.projectMode !== undefined,
      config.focusMode,
      emitter,
      repoKey,
    );

    for (const pr of snapshot.pullRequests.filter((p) => p.state === "open")) {
      const lastPr = lastPrMap?.get(pr.number);
      const prChanged = !lastPr || hasPrStateChanged(pr, lastPr);
      if (prChanged) {
        // A PR absent from the previous snapshot was just opened; without a
        // baseline (first poll) everything is merely being monitored.
        const action = lastPrMap && !lastPr ? "opened" : "monitoring";
        broadcastPullRequestUpdate(pr, action, undefined, emitter, repoKey);
      }
      const reviewCountChanged = !lastPr ||
        lastPr.unresolvedReviewCommentCount !== pr.unresolvedReviewCommentCount;
      if (reviewCountChanged) {
        try {
          const reviewComments = await ctx.gitHubClient.listUnresolvedReviewComments(pr.number);
          if (reviewComments.length > 0) {
            broadcastReviewComment(pr.number, "Review", reviewComments.length, undefined, emitter, repoKey);
          }
        } catch {
          // Silently skip review comment broadcasting if it fails
        }
      }
    }

    if (lastSnapshot) {
      const lastIssueMap = new Map(lastSnapshot.issues.map((i) => [i.number, i]));
      for (const issue of snapshot.issues) {
        const lastIssue = lastIssueMap.get(issue.number);
        if (!lastIssue || new Date(issue.updatedAt) > new Date(lastIssue.updatedAt)) {
          broadcastIssueUpdate(issue, lastIssue ? "updated" : "opened", undefined, emitter, repoKey);
        }
      }
    }

    const newSeenHashes = new Set(pollingState.seenCommitHashes);
    try {
      const recentCommits = await ctx.gitHubClient.listRecentCommits(5);
      for (const commit of filterNewCommits(recentCommits, pollingState.seenCommitHashes)) {
        broadcastCommit(commit, undefined, emitter, repoKey);
        newSeenHashes.add(commit.hash);
      }
    } catch {
      // Silently skip commit broadcasting if it fails
    }

    pollingState.lastSnapshot = snapshot;
    pollingState.seenCommitHashes = newSeenHashes;
  } catch {
    // Silently fail on between-cycle polling errors
  }
}

function describeAction(
  action: OrchestratorAction,
  snapshot: RepositorySnapshot,
  gitHubClient: GitHubClient,
): string {
  const actionIssueNumber =
    action.type === "start-implementation" ? action.issueNumber : action.issueNumber;
  const issueTitle =
    actionIssueNumber !== undefined
      ? snapshot.issues.find((i) => i.number === actionIssueNumber)?.title
      : undefined;
  const issueSuffix = issueTitle ? ` "${issueTitle}"` : "";
  const issueContext =
    actionIssueNumber !== undefined
      ? ` (issue #${actionIssueNumber}${issueSuffix})`
      : " (no linked issue)";
  switch (action.type) {
    case "start-implementation":
      return `Implement issue #${action.issueNumber}${issueSuffix} via Claude (${gitHubClient.issueUrl(action.issueNumber)})`;
    case "self-review":
      return `Self-review PR #${action.pullRequestNumber}${issueContext} via Claude (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "address-failing-checks":
      return `Address failing status checks on PR #${action.pullRequestNumber}${issueContext} via Claude (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "squash-merge":
      return `Squash-merge PR #${action.pullRequestNumber}${issueContext} (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "resolve-conflicts":
      return `Resolve merge conflicts in PR #${action.pullRequestNumber}${issueContext} via Claude (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
    case "request-review":
      return `Request human review on PR #${action.pullRequestNumber}${issueContext} (${gitHubClient.pullRequestUrl(action.pullRequestNumber)})`;
  }
}

function describeSession(
  session: AgentSession,
  gitHubClient: GitHubClient,
): string {
  const target =
    session.pullRequestNumber !== undefined
      ? `PR #${session.pullRequestNumber} (${gitHubClient.pullRequestUrl(session.pullRequestNumber)})`
      : session.issueNumber !== undefined
        ? `issue #${session.issueNumber} (${gitHubClient.issueUrl(session.issueNumber)})`
        : "(no linked issue or PR)";
  return `${session.phase} · ${session.status} · ${target} · session ${shortId(session.id)}`;
}

interface Config {
  owner: string;
  repo: string;
  /** Model used to initially implement a feature. Defaults to claude-sonnet-4-6. */
  claudeInitialModel: string | undefined;
  /** Model used to review an implementation. Defaults to claude-opus-4-8. */
  claudeReviewModel: string | undefined;
  /** Effort used to initially implement a feature. Defaults to high. */
  claudeInitialEffort: string | undefined;
  /** Effort used to review an implementation. Defaults to high. */
  claudeReviewEffort: string | undefined;
  /** Model used for commit message generation. Defaults to claude-haiku when unset. */
  claudeCommitModel: string | undefined;
  /** Milliseconds a single Claude run may take before it is killed. */
  claudeTimeoutMs: number;
  /** Per-project concurrency cap (a subset of the global pool). */
  maxConcurrency: number;
  cycleMinimumMs: number;
  once: boolean;
  dryRun: boolean;
  noBrowser: boolean;
  sessionStorePath: string;
  /** Human-in-the-Loop project mode config. Undefined = standard auto-merge mode. */
  projectMode: ProjectModeConfig | undefined;
  /** Focus mode: when true, only issues labelled "focus" are picked up. */
  focusMode: boolean;
}

function parseRepositorySlug(repository: string): { owner: string; repo: string } {
  const match = repository.match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    throw new Error(`Invalid repository slug "${repository}". Expected "owner/repo".`);
  }
  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo) {
    throw new Error(`Invalid repository slug "${repository}". Expected "owner/repo".`);
  }
  return { owner, repo };
}

function buildProjectConfig(
  projectEnvConfig: ProjectEnvConfig,
  envConfig: EnvConfig,
  runtimeFlags: { once: boolean; dryRun: boolean; noBrowser: boolean },
): Config {
  const { owner, repo } = parseRepositorySlug(projectEnvConfig.github_repository);
  const resolved = applyProjectDefaults(projectEnvConfig, envConfig);

  const projectNumber = projectEnvConfig.github_project_number;
  const projectMode: ProjectModeConfig | undefined =
    projectNumber !== undefined ? { projectNumber, reviewers: resolved.reviewers } : undefined;

  let sessionStorePath: string;
  if (projectEnvConfig.session_store_path !== undefined) {
    sessionStorePath = projectEnvConfig.session_store_path;
  } else {
    sessionStorePath = buildDefaultSessionStorePath(owner, repo);
    // A store left at the pre-rename default location is moved once so the
    // planner keeps its phase history (see buildLegacySessionStorePath).
    if (migrateLegacySessionStore(sessionStorePath, buildLegacySessionStorePath(owner, repo))) {
      console.log(`[yoke] Moved the ${owner}/${repo} session store to ${sessionStorePath}.`);
    }
  }

  return {
    owner,
    repo,
    claudeInitialModel: resolved.claude_code_initial_model,
    claudeReviewModel: resolved.claude_code_review_model,
    claudeInitialEffort: resolved.claude_code_initial_effort,
    claudeReviewEffort: resolved.claude_code_review_effort,
    claudeCommitModel: resolved.claude_describe_model,
    claudeTimeoutMs: resolved.claude_timeout_seconds * 1000,
    maxConcurrency: resolved.max_concurrency,
    cycleMinimumMs: Math.round(resolved.cycle_minimum_seconds * 1000),
    once: runtimeFlags.once,
    dryRun: runtimeFlags.dryRun,
    noBrowser: runtimeFlags.noBrowser,
    sessionStorePath,
    projectMode,
    focusMode: resolved.focus_mode,
  };
}

/**
 * Per-project, once-per-cycle housekeeping: approve pending workflow runs,
 * reconcile stale sessions, and refresh the dashboard's snapshot/PR/lifecycle
 * panes. Run by engine 0 only (outside the planning mutex) so it never blocks
 * the rest of the pool from picking up work.
 */
async function runProjectMaintenance(
  ctx: ProjectContext,
  claimedActions: ReadonlySet<string>,
  emitter: EventEmitter,
): Promise<void> {
  const { config } = ctx;
  const repoKey = ctx.repoKey;
  const { section, bullet, note } = createLogger(emitter, repoKey);

  section(`${repoKey}: Workflow approvals`);
  try {
    note("looking up workflow runs awaiting maintainer approval…");
    const pendingRuns = await ctx.gitHubClient.listWorkflowRunsAwaitingApproval();
    if (pendingRuns.length === 0) {
      bullet("0 runs awaiting maintainer approval");
    } else {
      bullet(`${pendingRuns.length} run(s) awaiting maintainer approval`);
      for (const run of pendingRuns) {
        const label = `run ${run.id} "${run.name || "unnamed"}" [status=${run.status}, event=${run.event}, branch=${run.headBranch || "?"}] (${run.htmlUrl})`;
        if (config.dryRun) {
          note(`→ [dry-run] would approve ${label}`, 2);
          continue;
        }
        note(`→ approving ${label}…`, 2);
        try {
          const result = await ctx.gitHubClient.approveWorkflowRun(run.id);
          note(result.approved ? `✓ approved ${label}` : `skipped ${label}: ${result.reason}`, 2);
          emitter.emit("workflow-approval", {
            runId: run.id,
            runName: run.name,
            approved: result.approved,
            repo: repoKey,
          });
        } catch (error) {
          note(`✗ failed to approve ${label}: ${(error as Error).message}`, 2);
        }
      }
    }
  } catch (error) {
    bullet(`failed to list workflow runs awaiting approval: ${(error as Error).message}`);
  }

  section(`${repoKey}: Snapshot`);
  note("loading issues, pull requests, and agent sessions from GitHub…");
  const snapshot = await loadProjectSnapshot(ctx);
  const openPullRequests = snapshot.pullRequests.filter((p) => p.state === "open");
  bullet(
    `${snapshot.issues.length} open issue(s), ${openPullRequests.length} open pull request(s), ${snapshot.agentSessions.filter((s) => s.status === "in_progress").length} active session(s)`,
  );

  section(`${repoKey}: Reconciliation`);
  note("checking for stale in-progress sessions…");
  const reconcileEvents = await reconcileSessions(ctx.sessionStore, snapshot.agentSessions);
  bullet(`${reconcileEvents.length} stale session(s) failed`);
  for (const event of reconcileEvents) {
    note(`◦ ${describeSession(event.session, ctx.gitHubClient)}`, 2);
  }
  snapshot.agentSessions = await ctx.sessionStore.load();
  ctx.snapshotCache = { snapshot, atMs: Date.now() };

  const activeSessions = snapshot.agentSessions.filter((s) => s.status === "in_progress");
  emitter.emit("snapshot-update", {
    repo: repoKey,
    issueCount: snapshot.issues.length,
    prCount: openPullRequests.length,
    draftPrCount: openPullRequests.filter((pr) => pr.draft).length,
    readyPrCount: openPullRequests.filter((pr) => !pr.draft).length,
    sessionCount: activeSessions.length,
    issues: snapshot.issues.map((i) => ({ number: i.number, title: i.title, state: i.state })),
    pullRequests: openPullRequests.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: pr.draft,
      checksStatus: pr.checksStatus,
      closingIssueNumbers: pr.closingIssueNumbers,
      linkedIssueNumbers: pr.linkedIssueNumbers,
    })),
  });

  broadcastRepositorySnapshot(snapshot, config.owner, config.repo, activeSessions.length, emitter);
  for (const pr of openPullRequests) {
    const draftLabel = pr.draft ? "[DRAFT]" : "";
    const checksLabel = pr.checksStatus === "success" ? "[CHECKS OK]" : "[CHECKS " + pr.checksStatus.toUpperCase() + "]";
    broadcastPullRequestUpdate(pr, `tracking ${draftLabel} ${checksLabel}`, undefined, emitter, repoKey);
  }

  const plan = buildPlan(snapshot, ctx.cap, config.projectMode, config.focusMode);
  broadcastLifecycleUpdate(
    snapshot,
    claimedImplementationIssueNumbers(claimedActions, repoKey),
    new Set(),
    plan.blockedIssueNumbers,
    config.projectMode !== undefined,
    config.focusMode,
    emitter,
    repoKey,
  );
}

interface PlannedWork {
  ctx: ProjectContext;
  action: OrchestratorAction;
  snapshot: RepositorySnapshot;
  blockedIssueNumbers: Record<number, number[]>;
}

/**
 * Scan every project (in configured order) for the first claimable action,
 * honouring each project's concurrency cap. Runs under the planning mutex so
 * the claim it makes is visible to the next engine before it plans.
 */
async function planNextAction(
  contexts: ProjectContext[],
  claimedActions: Set<string>,
  emitter: EventEmitter,
  actionCooldowns: ActionCooldowns,
): Promise<PlannedWork | null> {
  for (const ctx of contexts) {
    // Respect the per-project cap: never let more than `cap` of the shared
    // cylinders work the same project at once.
    if (claimsForRepo(claimedActions, ctx.repoKey) >= ctx.cap) {
      continue;
    }

    let snapshot: RepositorySnapshot;
    try {
      snapshot = await getProjectSnapshot(ctx);
    } catch {
      continue;
    }
    const plan = buildPlan(snapshot, ctx.cap, ctx.config.projectMode, ctx.config.focusMode);

    const claimed = tryClaimFromPlan(
      ctx.repoKey,
      ctx.cap,
      plan.actions,
      claimedActions,
      actionCooldowns.until,
    );

    // Refresh this project's lifecycle pane on every planning pass so pills
    // reflect the freshest snapshot (and any claim we just made).
    broadcastLifecycleUpdate(
      snapshot,
      claimedImplementationIssueNumbers(claimedActions, ctx.repoKey),
      new Set(),
      plan.blockedIssueNumbers,
      ctx.config.projectMode !== undefined,
      ctx.config.focusMode,
      emitter,
      ctx.repoKey,
    );

    if (claimed) {
      return { ctx, action: claimed, snapshot, blockedIssueNumbers: plan.blockedIssueNumbers };
    }
  }
  return null;
}

async function runEngine(
  engineIndex: number,
  contexts: ProjectContext[],
  globalMaxConcurrency: number,
  globalCycleMinimumMs: number,
  planningMutex: PlanningMutex,
  claimedActions: Set<string>,
  actionCooldowns: ActionCooldowns,
  shutdownSignal: { requested: boolean },
  cancelSignal: { requested: boolean },
  emitter: EventEmitter,
): Promise<void> {
  const { write, blank, section, bullet, note, failure } = createLogger(emitter);
  const isOnceMode = contexts[0]?.config.once ?? false;
  let iterationNumber = 0;

  // Sleep for `waitMs`, waking early on shutdown or cancel. Engine 0 keeps
  // every project's feed alive while it waits.
  const idleWait = async (waitMs: number): Promise<void> => {
    const pollIntervalMs = 10000;
    const waitStart = Date.now();
    while (Date.now() - waitStart < waitMs && !shutdownSignal.requested && !cancelSignal.requested) {
      const timeLeft = waitMs - (Date.now() - waitStart);
      if (timeLeft <= 0) break;
      await delay(Math.min(pollIntervalMs, timeLeft));

      if (engineIndex === 0) {
        for (const ctx of contexts) {
          const now = Date.now();
          if (
            now - ctx.pollingState.lastPolledAt >= pollIntervalMs &&
            Date.now() - waitStart < waitMs - 1000
          ) {
            ctx.pollingState.lastPolledAt = now;
            await broadcastBetweenCycleActivity(ctx, claimedActions, emitter);
          }
        }
      }
    }
  };

  /**
   * Park this engine's cycle on a hold, announcing it exactly once for the pool.
   *
   * The CLI gets a single line that counts down in place for the whole hold
   * (the wait notice), plus one scrollback line saying what is being waited on;
   * the dashboard gets a `work-hold` event it renders as a banner.
   */
  const enterHold = (hold: {
    key: string;
    kind: string;
    untilMs: number;
    reason: string;
    /** One extra sentence worth saying the first time, if any. */
    detail?: string;
  }): void => {
    announceWait(hold.key, { untilMs: hold.untilMs, reason: hold.reason });
    if (!holdAnnouncer.enter(hold.key, hold.untilMs)) return;
    emitter.emit("work-hold", {
      kind: hold.kind,
      reason: hold.reason,
      untilMs: hold.untilMs,
    });
    blank();
    write(
      `⏸ ${formatWaitStatusLine({ untilMs: hold.untilMs, reason: hold.reason })} — ` +
        `no work will be planned or started until then.`,
    );
    if (hold.detail !== undefined) bullet(hold.detail);
  };

  /** Announce, once for the pool, that the hold lifted and work is resuming. */
  const exitHold = (): void => {
    const previous = holdAnnouncer.current();
    if (!holdAnnouncer.exit() || previous === undefined) return;
    clearWait(previous.key);
    emitter.emit("work-hold-cleared", {});
    write(`▶ done waiting — resuming work.`);
  };

  do {
    // One cycle, fully isolated. Only executeAction used to be guarded, so a
    // throw from planning, from a rate-limit read, or from any emit — including
    // one raised inside the catch below — escaped runEngine, rejected the
    // Promise.all over the whole pool, and killed every other engine's
    // in-flight Claude run along with the process.
    try {
      if (shutdownSignal.requested) {
        emitter.emit("engine-shutdown", { engineIndex });
        write(`Engine ${engineIndex + 1}: shutdown — no further work will be done.`);
        return;
      }

      cancelSignal.requested = false;
      const cycleStart = Date.now();
      iterationNumber++;

      // GitHub rate-limit holds are per-gateway (per project). Pause this engine
      // while ANY project's gateway is on hold.
      // Read the hold once. `currentRateLimitHold()` expires holds as it reads
      // them, so finding one and then re-reading it with a non-null assertion
      // crashes the engine whenever the hold lapses between the two calls.
      const held = contexts
        .map((c) => ({ ctx: c, hold: c.githubGateway.currentRateLimitHold() }))
        .find((entry) => entry.hold !== undefined && Date.now() < entry.hold.blockedUntilMs);
      if (held?.hold) {
        const heldCtx = held.ctx;
        const hold = held.hold;
        enterHold({
          key: `github-rate-limit:${heldCtx.repoKey}`,
          kind: "github-rate-limit",
          untilMs: hold.blockedUntilMs,
          reason: `GitHub rate limit · ${heldCtx.repoKey}`,
        });
        emitter.emit("engine-idle", {
          engineIndex,
          reason: "github-rate-limit",
          rateLimitedUntilMs: hold.blockedUntilMs,
          nextCycleAtMs: hold.blockedUntilMs,
        });
        await heldCtx.githubGateway.waitUntilReady();
        continue;
      }

      emitter.emit("iteration-start", {
        iterationNumber,
        engineIndex,
        maxConcurrency: globalMaxConcurrency,
      });

      // ── Per-project maintenance (engine 0 only, outside the mutex) ──────────
      if (engineIndex === 0) {
        for (const ctx of contexts) {
          if (Date.now() - ctx.lastMaintenanceAtMs < ctx.config.cycleMinimumMs) continue;
          ctx.lastMaintenanceAtMs = Date.now();
          try {
            await runProjectMaintenance(ctx, claimedActions, emitter);
          } catch (error) {
            bullet(`${ctx.repoKey}: maintenance failed: ${(error as Error).message}`);
          }
        }
      }

      // ── Claude usage-limit hold ─────────────────────────────────────────────
      // The CLI's subscription quota is shared by every engine, so once one run
      // has hit it, every Claude action fails until the reset. Pause here rather
      // than claim an issue, prepare its checkout and fail on it every cycle.
      // Maintenance above is GitHub-only and keeps running on engine 0.
      const claudeHold = getClaudeQuotaHold();
      const claudeHoldWaitMs = claudeQuotaHoldWaitMs({
        blockedUntilMs: claudeHold?.blockedUntilMs,
        nowMs: Date.now(),
        engineIndex,
        cycleMinimumMs: globalCycleMinimumMs,
      });
      if (claudeHoldWaitMs > 0 && claudeHold !== undefined) {
        enterHold({
          key: CLAUDE_QUOTA_WAIT_KEY,
          kind: "claude-usage-limit",
          untilMs: claudeHold.blockedUntilMs,
          reason: claudeHold.reason,
          detail:
            "the reset time comes from the Claude CLI's own message; " +
            "GitHub-only maintenance (workflow approvals, reconciliation) keeps running.",
        });
        emitter.emit("engine-idle", {
          engineIndex,
          reason: "claude-usage-limit",
          rateLimitedUntilMs: claudeHold.blockedUntilMs,
          nextCycleAtMs: claudeHold.blockedUntilMs,
        });
        if (isOnceMode) {
          write(`Engine ${engineIndex + 1}: shutdown — Claude usage limit reached in --once mode.`);
          emitter.emit("engine-shutdown", { engineIndex });
          return;
        }
        await idleWait(claudeHoldWaitMs);
        continue;
      }

      // Nothing is holding this engine back, so the hold (if there was one) is
      // over. Announced once for the pool, by whichever engine gets here first.
      exitHold();

      // ── Planning phase (serialised via the shared mutex) ────────────────────
      const planned = await planningMutex.withLock(() =>
        planNextAction(contexts, claimedActions, emitter, actionCooldowns),
      );

      // ── Execution phase ─────────────────────────────────────────────────────
      let cycleRateLimitedUntilMs: number | undefined;
      if (planned) {
        const { ctx, action, snapshot, blockedIssueNumbers } = planned;
        const { config } = ctx;

        section(`Engine ${engineIndex + 1} · ${ctx.repoKey}: Action`);
        bullet(describeAction(action, snapshot, ctx.gitHubClient));

        emitter.emit("phase-update", { phase: "implementation" });
        emitter.emit("action-start", {
          actionIndex: engineIndex + 1,
          totalActions: globalMaxConcurrency,
          repo: ctx.repoKey,
          description: describeAction(action, snapshot, ctx.gitHubClient),
          type: action.type,
          issueNumber: action.issueNumber ?? null,
          pullRequestNumber:
            action.type !== "start-implementation" ? action.pullRequestNumber : null,
          model: action.type === "squash-merge"
            ? (config.claudeCommitModel ?? DEFAULT_COMMIT_MODEL)
            : action.type === "self-review"
              ? (config.claudeReviewModel ?? null)
              : (config.claudeInitialModel ?? null),
          startedAt: Date.now(),
        });

        const actionContext = {
          owner: config.owner,
          repo: config.repo,
          issues: snapshot.issues,
          pullRequests: snapshot.pullRequests,
          ...(config.projectMode ? { projectMode: config.projectMode } : {}),
        };

        try {
          const result: ExecuteActionResult = await executeAction(
            ctx.gitHubClient,
            ctx.sessionStore,
            ctx.claudeAgentClient,
            action,
            config.dryRun,
            actionContext,
          );

          emitter.emit("action-complete", {
            actionIndex: engineIndex + 1,
            totalActions: globalMaxConcurrency,
            repo: ctx.repoKey,
            noCommitsPushed: result.noCommitsPushed || false,
          });

          actionCooldowns.recordSuccess(repoActionKey(ctx.repoKey, action));

          if (result.incompleteImplementation) {
            note(`⚠ interrupted — pushed what was finished as an INCOMPLETE draft PR`, 2);
          } else if (result.noCommitsPushed) {
            note(`✓ done — no new commits pushed to branch (Claude ran but made no changes)`, 2);
          } else {
            note(`✓ done`, 2);
          }

          if (action.type === "squash-merge") {
            const mergedIssueNumbers = new Set<number>();
            const mergedPR = snapshot.pullRequests.find((p) => p.number === action.pullRequestNumber);
            if (mergedPR) {
              const linked =
                mergedPR.closingIssueNumbers.length > 0
                  ? mergedPR.closingIssueNumbers
                  : mergedPR.linkedIssueNumbers;
              for (const n of linked) mergedIssueNumbers.add(n);
            }
            if (mergedIssueNumbers.size > 0) {
              broadcastLifecycleUpdate(
                snapshot,
                new Set(),
                mergedIssueNumbers,
                blockedIssueNumbers,
                config.projectMode !== undefined,
                config.focusMode,
                emitter,
                ctx.repoKey,
              );
            }
          }
        } catch (error) {
          // `(error as Error).message` throws when the rejection reason is not an
          // Error — i.e. it throws *from inside the catch block*, escaping
          // runEngine entirely and taking the whole process with it.
          const errorMessage =
            error instanceof Error
              ? (error.stack ?? error.message)
              : `non-Error rejection: ${String(error)}`;
          // A usage limit says nothing about the action — only that nothing can
          // run yet. It is the hold that is reported (once, for the pool), not
          // the action, and the action keeps whatever backoff it already had
          // rather than being punished for the quota.
          const quotaHold = isClaudeUsageLimitMessage(errorMessage)
            ? getClaudeQuotaHold()
            : undefined;
          if (quotaHold !== undefined) {
            cycleRateLimitedUntilMs = quotaHold.blockedUntilMs;
            // A usage limit is a hold, not an action failure. Surfacing it as a
            // red `✗ … failed: Claude CLI usage limit reached` line and an
            // errored cylinder would reproduce on the dashboard exactly the
            // burst of duplicate failures this change removes from the CLI, so
            // report it the same way the pool gate does: the engine is parked
            // on the quota until the reset, nothing more.
            emitter.emit("engine-idle", {
              engineIndex,
              reason: "claude-usage-limit",
              rateLimitedUntilMs: quotaHold.blockedUntilMs,
              nextCycleAtMs: quotaHold.blockedUntilMs,
            });
            note(
              `⏸ not attempted — ${formatWaitStatusLine({ untilMs: quotaHold.blockedUntilMs, reason: quotaHold.reason })}.`,
              2,
            );
          } else {
            emitter.emit("action-error", {
              actionIndex: engineIndex + 1,
              totalActions: globalMaxConcurrency,
              repo: ctx.repoKey,
              error: errorMessage,
            });
            const backoffMs = actionCooldowns.recordFailure(repoActionKey(ctx.repoKey, action));
            failure(`✗ failed: ${errorMessage}`, 2);
            note(`retrying this action no sooner than ${formatDuration(backoffMs)} from now.`, 2);
          }
        } finally {
          claimedActions.delete(repoActionKey(ctx.repoKey, action));
          // The project's state changed; force a fresh snapshot next plan so the
          // just-finished action is not re-proposed from a stale cache.
          ctx.snapshotCache = null;
        }
      } else {
        section(`Engine ${engineIndex + 1}: Idle`);
        bullet("nothing to do this cycle");
        emitter.emit("engine-idle", {
          engineIndex,
          reason: "nothing to do this cycle",
        });
      }

      if (isOnceMode) {
        if (shutdownSignal.requested) {
          emitter.emit("engine-shutdown", { engineIndex });
          write(`Engine ${engineIndex + 1}: shutdown — no further work will be done.`);
        }
        return;
      }

      // ── Wait phase ──────────────────────────────────────────────────────────
      const elapsed = Date.now() - cycleStart;
      const remainingMs = Math.max(0, globalCycleMinimumMs - elapsed);
      if (remainingMs > 0) {
        emitter.emit("engine-idle", {
          engineIndex,
          nextCycleAtMs: Date.now() + remainingMs,
          ...(cycleRateLimitedUntilMs !== undefined
            ? { rateLimitedUntilMs: cycleRateLimitedUntilMs }
            : {}),
        });
        blank();
        write(`Engine ${engineIndex + 1}: next cycle in ${formatDuration(remainingMs)}.`);
        await idleWait(remainingMs);
      }
    } catch (error) {
      // Retire the cycle, not the pool. Back off briefly so a persistent fault
      // cannot spin the loop.
      const detail =
        error instanceof Error
          ? (error.stack ?? error.message)
          : `non-Error rejection: ${String(error)}`;
      try {
        failure(`Engine ${engineIndex + 1}: cycle failed — continuing.\n${detail}`, 1);
      } catch {
        // Logging must never be the thing that kills the engine.
        process.stderr.write(`[yoke] Engine ${engineIndex + 1} cycle failed: ${detail}\n`);
      }
      if (isOnceMode) return;
      await delay(5000);
    }
  } while (true);
}

async function main(): Promise<void> {
  installExitDiagnostics();
  const argv = process.argv.slice(2);
  const once = argv.includes("--once");
  const dryRun = argv.includes("--dry-run");
  const noBrowser = argv.includes("--no-browser");

  const envConfig = loadEnvConfig();

  // ── Validate Claude authentication before opening the browser ─────────────
  const authResult = await validateClaudeAuth();
  if (!authResult.valid) {
    console.error(`\nError: Claude authentication is invalid or expired.`);
    console.error(`Please run:  claude auth login`);
    console.error(`Then restart yoke.\n`);
    process.exit(1);
  }

  const emitter = globalEventEmitter;
  const shutdownSignal = { requested: false };

  // Listen for Escape key on the console to trigger graceful shutdown
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (chunk: Buffer) => {
      // Ctrl-C. Raw mode clears ISIG, so this arrives as a byte rather than as
      // SIGINT. It used to call process.exit(0) on the spot, which SIGKILLed
      // every in-flight Claude run without a word and reported success to the
      // shell — a single keystroke could silently discard hours of agent work.
      // First press drains; second press aborts and says what it is discarding.
      if (chunk[0] === 0x03 && chunk.length === 1) {
        if (shutdownSignal.requested) {
          setExitReason("ctrl-c (forced)");
          const live = countLiveClaudeRuns();
          writeLogLine(
            `\nCtrl-C again: aborting now and discarding ${live} in-flight Claude run(s).`,
          );
          process.exit(130);
        }
        shutdownSignal.requested = true;
        setExitReason("ctrl-c (graceful)");
        blank();
        write(
          `Ctrl-C: finishing ${countLiveClaudeRuns()} in-flight Claude run(s), then quitting. ` +
            `Press Ctrl-C again to abort and discard them.`,
        );
        emitter.emit("shutdown-requested", {});
        return;
      }
      if (chunk[0] === 0x1b && chunk.length === 1 && !shutdownSignal.requested) {
        shutdownSignal.requested = true;
        process.stdin.pause();
        process.stdin.setRawMode(false);
        blank();
        write("Escape key pressed. Will shutdown engines and quit after work finishes.");
        emitter.emit("shutdown-requested", {});
      }
    });
  }

  // ── Build one runtime context per configured project ──────────────────────
  const globalMaxConcurrency = envConfig.max_concurrency ?? 3;
  const globalCycleMinimumMs = Math.round((envConfig.cycle_minimum_seconds ?? 60) * 1000);
  const multiProject = envConfig.projects.length > 1;

  const contexts: ProjectContext[] = envConfig.projects.map((projectEnvConfig) => {
    const config = buildProjectConfig(projectEnvConfig, envConfig, { once, dryRun, noBrowser });
    const githubToken = resolveGitHubToken(envConfig, projectEnvConfig.github_token_name);
    const githubGateway = new GitHubApiGateway({
      token: githubToken,
      apiBaseUrl: envConfig.github_api_base_url ?? "https://api.github.com",
      apiVersion: envConfig.github_api_version ?? "2022-11-28",
      userAgent: "yoke",
      eventEmitter: emitter,
    });
    const gitHubClient = new GitHubClient({ owner: config.owner, repo: config.repo, gateway: githubGateway });
    const claudeAgentClient = createClaudeAgentClient({
      githubGateway,
      githubToken,
      ...(config.claudeInitialModel !== undefined ? { claudeInitialModel: config.claudeInitialModel } : {}),
      ...(config.claudeReviewModel !== undefined ? { claudeReviewModel: config.claudeReviewModel } : {}),
      ...(config.claudeInitialEffort !== undefined ? { claudeInitialEffort: config.claudeInitialEffort } : {}),
      ...(config.claudeReviewEffort !== undefined ? { claudeReviewEffort: config.claudeReviewEffort } : {}),
      ...(config.claudeCommitModel !== undefined ? { claudeCommitModel: config.claudeCommitModel } : {}),
      claudeTimeoutMs: config.claudeTimeoutMs,
    });
    return {
      config,
      repoKey: `${config.owner}/${config.repo}`,
      githubGateway,
      githubToken,
      gitHubClient,
      sessionStore: new FileSessionStore(config.sessionStorePath),
      claudeAgentClient,
      pollingState: { lastPolledAt: 0, lastSnapshot: null, seenCommitHashes: new Set<string>() },
      cap: Math.min(config.maxConcurrency, globalMaxConcurrency),
      snapshotCache: null,
      lastMaintenanceAtMs: 0,
    } satisfies ProjectContext;
  });

  // ── Resolve the single dashboard title ────────────────────────────────────
  const first = contexts[0]!;
  const firstProjectEnv = envConfig.projects[0]!;
  const dashboardTitle = resolveDashboardTitle(envConfig.dashboard_title);

  // ── Start the single dashboard server ─────────────────────────────────────
  const dashboardPort = envConfig.dashboard_port ?? firstProjectEnv.dashboard_port ?? 3000;
  const dashboard = new DashboardServer({
    port: dashboardPort,
    owner: multiProject ? "" : first.config.owner,
    repo: multiProject ? "" : first.config.repo,
    dashboardTitle,
    maxConcurrency: globalMaxConcurrency,
    multiProject,
    projects: contexts.map((c) => c.repoKey),
    eventEmitter: emitter,
  });
  let dashboardReady = false;
  try {
    await dashboard.initialize();
    await dashboard.start();
    if (!noBrowser) {
      await dashboard.openBrowser();
    }
    dashboardReady = true;
  } catch (error) {
    console.error(
      `[Dashboard] Failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // ── Banner ────────────────────────────────────────────────────────────────
  write(HEAVY_RULE);
  write(`yoke starting · ${timestamp()}`);
  write(`projects (${contexts.length}): ${contexts.map((c) => `${c.repoKey} [cap ${c.cap}]`).join(", ")}`);
  if (dashboardReady) {
    write(`dashboard: ${dashboard.getUrl()}${noBrowser ? " (browser launch suppressed)" : ""}`);
    const bundlePath = path.join(process.cwd(), "dist", "dashboard", "bundle.js");
    if (!fs.existsSync(bundlePath)) {
      console.warn(
        `[Dashboard] WARNING: dist/dashboard/bundle.js not found — the dashboard UI will not load.\n` +
        `Run: npm run build:dashboard`,
      );
    }
  } else {
    write(`dashboard: failed to start (check if port ${dashboardPort} is available)`);
  }
  const modeNotes: string[] = [];
  if (once) modeNotes.push("--once");
  if (dryRun) modeNotes.push("--dry-run");
  if (noBrowser) modeNotes.push("--no-browser");
  write(
    `cycle-minimum: ${formatDuration(globalCycleMinimumMs)} · pool: ${globalMaxConcurrency} cylinder(s)` +
      (modeNotes.length > 0 ? ` · mode: ${modeNotes.join(", ")}` : ""),
  );
  write(HEAVY_RULE);

  // ── Per-project startup: ensure the "manual"/"focus" labels exist ─────────
  for (const ctx of contexts) {
    const { bullet, note, section } = createLogger(emitter, ctx.repoKey);
    section(`${ctx.repoKey}: Startup`);
    note("ensuring the \"manual\" label exists on the repository…");
    try {
      await ctx.gitHubClient.ensureLabelExists(
        "manual",
        "e0e0e0",
        "Prevents yoke from automatically picking up this issue",
      );
      bullet("\"manual\" label is present");
    } catch (error) {
      bullet(`could not ensure "manual" label exists: ${(error as Error).message}`);
    }
    note(`ensuring the "${REVIEW_LABEL}" label exists on the repository…`);
    try {
      await ctx.gitHubClient.ensureLabelExists(
        REVIEW_LABEL,
        "d93f0b",
        "Yoke implements this issue but leaves the final PR for human review",
      );
      bullet(`"${REVIEW_LABEL}" label is present`);
    } catch (error) {
      bullet(`could not ensure "${REVIEW_LABEL}" label exists: ${(error as Error).message}`);
    }
    if (ctx.config.focusMode) {
      note(`ensuring the "${FOCUS_LABEL}" label exists on the repository…`);
      try {
        await ctx.gitHubClient.ensureLabelExists(
          FOCUS_LABEL,
          "0075ca",
          "Yoke will only work on issues with this label in focus mode",
        );
        bullet(`"${FOCUS_LABEL}" label is present`);
      } catch (error) {
        bullet(`could not ensure "${FOCUS_LABEL}" label exists: ${(error as Error).message}`);
      }
    }
  }

  // ── Launch the shared engine pool ─────────────────────────────────────────
  const planningMutex = new PlanningMutex();
  const claimedActions = new Set<string>();
  const actionCooldowns = createActionCooldowns();
  const cancelSignals = Array.from({ length: globalMaxConcurrency }, () => ({ requested: false }));

  emitter.subscribe((event) => {
    if (event.type === "cylinder-cancel") {
      const engineIndex = event.data.engineIndex as number;
      if (typeof engineIndex === "number" && engineIndex >= 0 && engineIndex < cancelSignals.length) {
        const signal = cancelSignals[engineIndex];
        if (signal) signal.requested = true;
      }
    }
  });

  const engines = Array.from({ length: globalMaxConcurrency }, (_, i) =>
    runEngine(
      i,
      contexts,
      globalMaxConcurrency,
      globalCycleMinimumMs,
      planningMutex,
      claimedActions,
      actionCooldowns,
      shutdownSignal,
      cancelSignals[i]!,
      emitter,
    ),
  );

  // allSettled, not all: `all` rejects on the first engine to fail and unwinds
  // main() while every other engine is still mid-run, so one bad cycle took the
  // whole pool — and every in-flight Claude run — down with it.
  const engineOutcomes = await Promise.allSettled(engines);
  for (const [i, outcome] of engineOutcomes.entries()) {
    if (outcome.status === "rejected") {
      const reason = outcome.reason;
      failure(
        `Engine ${i + 1} exited abnormally: ${
          reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
        }`,
      );
    }
  }

  blank();
  if (shutdownSignal.requested) {
    setExitReason("graceful shutdown");
    write("All engines shut down. Exiting.");
    emitter.emit("app-shutdown", {});
    await delay(500);
  } else {
    setExitReason("--once complete");
    write(`Done (--once mode). Exiting.`);
  }
  if (process.stdin.isTTY) {
    process.stdin.pause();
    process.stdin.setRawMode(false);
  }
  if (dashboardReady) {
    dashboard.close();
  }
  process.exit(0);
}

main().catch((error: unknown) => {
  setExitReason("fatal error in main");
  console.error(`[${timestamp()}] Fatal error:`, error);
  process.exit(1);
});
