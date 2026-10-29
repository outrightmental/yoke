import type { PillActivity } from '../shared/pill-activity.js';

export interface CylinderState {
  index: number;
  /** Stable color of the issue this cylinder is working, or null when it has
   *  no issue (idle) — colors belong to issues, not cylinders (issue #236). */
  color: string | null;
  colorRgb: string | null;
  status: 'idle' | 'active' | 'done' | 'error' | 'shutdown';
  idleStatusText: string;
  actionType: string | null;
  /** "owner/repo" this cylinder is currently working, or null when idle. */
  repo: string | null;
  issueNumber: number | null;
  prNumber: number | null;
  /** Titles of the issue/PR being worked, carried on the action so a pill can
   *  still be drawn for work that has left GitHub's open lists (e.g. an issue
   *  closed mid-flight). Null when unknown or idle. */
  issueTitle: string | null;
  prTitle: string | null;
  model: string | null;
  iterationNumber: number;
  thinkingLines: string[];
  actionStartedAt: number | null;
  nextCycleAtMs: number | null;
  rateLimitedUntilMs: number | null;
}

/**
 * A hold parking the whole engine pool until `untilMs` — the Claude
 * subscription quota or a GitHub rate limit. Global, not per cylinder: while
 * one is active nothing anywhere is being worked on.
 */
export interface WorkHold {
  /** Which shared resource ran out: "claude-usage-limit", "github-rate-limit". */
  kind: string;
  /** Short human-readable cause, e.g. "Claude usage limit". */
  reason: string;
  /** Epoch millis the hold ends and work resumes. */
  untilMs: number;
}

/**
 * The latest reading of the Claude account's rolling 5-hour usage window, for
 * the header's usage gauge (mirrors `UsageReading` in src/anthropic-usage.ts).
 */
export interface AccountUsage {
  /** "ok": live numbers; "unconfigured": no token to read with, so the gauge
   *  is OFF; "unavailable": there is a token but the reading could not be taken. */
  status: 'ok' | 'unconfigured' | 'unavailable';
  /** Percent (0–100) of the 5-hour window consumed; null unless status is "ok",
   *  or an "unavailable" reading holds over the last good one's (see `heldFromMs`). */
  fiveHourPercent: number | null;
  /** Epoch millis the 5-hour window resets; null when unknown or none is open. */
  resetsAtMs: number | null;
  /** Epoch millis the reading was taken. */
  fetchedAtMs: number;
  /** Why there are no fresh numbers; empty when status is "ok". */
  reason: string;
  /** Set only on an "unavailable" reading that still carries the last good
   *  reading's numbers: the epoch millis those numbers were read. */
  heldFromMs?: number;
}

/**
 * A wall-clock time the server rendered into a line of text, in its own zone,
 * with the instant it stands for — so the dashboard can render it again in the
 * viewer's (mirrors `ClockTimeRef` in src/claude-agent.ts).
 */
export interface ClockTimeRef {
  /** The time exactly as the server rendered it into the text. */
  text: string;
  /** Epoch millis it stands for. */
  atMs: number;
}

export interface IssueCard {
  number: number;
  title: string;
  state: string;
}

export interface PRCard {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  checksStatus?: string;
  closingIssueNumbers?: number[];
  linkedIssueNumbers?: number[];
}

export interface LifecyclePair {
  issue?: IssueCard | null;
  pr?: PRCard | null;
  prPhase: string;
  colorIndex?: number;
  blockedByIssueNumbers?: number[];
  disabled?: boolean;
  /** Project status label for inactive pills (e.g. "Backlog", "Done"). */
  projectStatus?: string;
  /** "owner/repo" this pair belongs to (set by the store from the update's scope). */
  repo?: string;
  /** Set while a review-gated PR waits on a human (#274): `awaiting-approval`
   *  while it is parked (the pill offers Approve), `approved` once approved
   *  and its squash-merge is pending. */
  approval?: 'awaiting-approval' | 'approved';
}

/** Where one dashboard approval stands (#276); see `PullRequestApprovalStatus`. */
export type PullRequestApprovalState = 'loading' | 'waiting' | 'approved' | 'refused' | 'failed';

/**
 * Where one dashboard approval of one PR stands (#276), as the latest
 * `pull-request-approval` event for it said (mirrors `PullRequestApproval` in
 * src/dashboard-approval.ts), with the time it arrived here.
 */
export interface PullRequestApprovalStatus {
  /** "owner/repo". */
  repo: string;
  pullRequestNumber: number;
  /** ISO time the server received the request that started this attempt. */
  requestedAt: string;
  /** `loading`: reading the PR from GitHub; `waiting`: waiting for a free
   *  planner; then how it ended. */
  state: PullRequestApprovalState;
  /** For `refused` and `failed`: why, in the log line's words. */
  reason?: string;
  /** For `approved`: the merge waits for the PR's checks. */
  checksPending?: boolean;
  /** For `approved`: an earlier approval stands. */
  alreadyApproved?: boolean;
  /** The server's stamp on the event, which tells a replay of it (on a
   *  reconnect) from a new answer. */
  emittedAt: string;
  /** Epoch millis, by this browser's clock, the event arrived. Compared only
   *  with this browser's own times, so the server's clock never matters. */
  receivedAtMs: number;
}

export interface BroadcastEventData {
  id: string;
  category: string;
  label: string;
  stateBefore: string;
  changeHow: string;
  stateAfter: string;
  excellence: string;
  workerIndex?: number;
  prNumber?: number;
  issueNumber?: number;
  commitHash?: string;
  runId?: string;
  /** "owner/repo" this feed item belongs to (shown as a chip in multi-project mode). */
  repo?: string;
  /** Epoch millis of the event, rendered in the viewer's time zone. */
  atMs: number;
  /** Stable color of the issue this event pertains to, or the neutral gray
   *  when the event has no associated issue. */
  color: string;
}

export interface EventLine {
  text: string;
  cylinderIdx: number;
  level: string;
  /** Epoch millis of the event, rendered in the viewer's time zone. */
  atMs: number;
  color: string | null;
  /** "owner/repo" this log line came from, when it originates from a project. */
  repo?: string;
}

export interface DashboardState {
  connection: 'connecting' | 'connected' | 'disconnected';
  maxConcurrency: number;
  cylinders: CylinderState[];
  issueCards: Map<number, IssueCard>;
  prCards: Map<number, PRCard>;
  cylinderByIssue: Map<number, number>;
  cylinderByPR: Map<number, number>;
  /** Lifecycle pairs per project ("owner/repo" → pairs). Kept separate so the
   *  projects sharing one dashboard never clobber each other's pane. */
  lifecycleByRepo: Map<string, LifecyclePair[]>;
  /** Flattened view of lifecycleByRepo, recomputed on each lifecycle update. */
  lastLifecyclePairs: LifecyclePair[];
  /** Active session count per project; `sessionCount` is their sum. */
  sessionCountByRepo: Map<string, number>;
  broadcastQueue: BroadcastEventData[];
  broadcastVisible: BroadcastEventData[];
  eventStream: EventLine[];
  eventCount: number;
  sessionCount: number;
  shutdownRequested: boolean;
  appShutdown: boolean;
  /** Each pill's activity, by pill key, as it stood when the pills went dark at
   *  shutdown (issue #268); null while yoke is running. */
  frozenPillActivity: Map<string, PillActivity | null> | null;
  /** The hold parking every engine, or null when work is free to run. */
  hold: WorkHold | null;
  /** Latest Claude account usage reading, or null until the first arrives. */
  usage: AccountUsage | null;
  /** Each PR's latest dashboard approval (#276), keyed like the pill's
   *  `approveKey` ("owner/repo#n"). Outcomes drop out once they are stale. */
  approvals: Map<string, PullRequestApprovalStatus>;
  /** True when more than one project shares this dashboard. */
  multiProject: boolean;
  owner: string;
  repo: string;
  title: string;
}
