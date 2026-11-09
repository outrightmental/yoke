import type { ApprovalPress, LifecyclePair, PullRequestApprovalState, PullRequestApprovalStatus } from '../store/types.js';
import type { PillActivity } from './pill-activity.js';

/** How long a sent approval waits for yoke's first answer before the pill's
 *  line says none has come yet. Yoke answers the moment a request arrives,
 *  even when the approval then has to queue. The pill stays Queued however
 *  long it waits — there is no error state to give up into (#278) — and the
 *  store sends the press again when the connection comes back. */
export const APPROVE_ACK_MS = 10_000;
/** How long the pill shows how another dashboard's approval ended (#276) —
 *  this dashboard's own press shows its outcome for good (#278) — and how long
 *  the dashboard server replays an outcome to a page opened meanwhile. */
export const APPROVAL_OUTCOME_SHOW_MS = 60_000;

/** The PR an Approve click names: its number and the project it is in. */
export interface ApproveTarget {
  /** "owner/repo"; empty only when the pill does not know its project. */
  repo: string;
  pullRequestNumber: number;
}

/** The key a PR's approval is known by, in the store and on the pill. */
export function approveKey(target: ApproveTarget): string {
  return `${target.repo}#${target.pullRequestNumber}`;
}

/** The Approve button a pill shows, as it stands right now. */
export interface ApproveControl {
  target: ApproveTarget;
  /** True when it cannot be pressed: the PR's checks are failing. */
  disabled: boolean;
  /** The tooltip: what pressing it does, or why it cannot be pressed. */
  title: string;
}

/**
 * Whether a lifecycle pill's PR can be approved right now (#274), or null when
 * it cannot: the Approve button, or Retry after a press that did not go
 * through. A press already made goes on showing where it stands either way
 * (see `approvalView`).
 *
 * Only a ready PR parked by the `review` label can be — the server marks those
 * `awaiting-approval` — and only while no engine is working it and yoke is not
 * shutting down, when no engine would start the merge. An approval never
 * merges over failing checks, so the button is disabled while they fail;
 * pressed while they are still running, it approves a merge that waits for
 * them.
 */
export function approveControl(
  pair: LifecyclePair,
  activity: PillActivity | null,
  dark: boolean,
): ApproveControl | null {
  const pr = pair.pr;
  if (!pr || pair.approval !== 'awaiting-approval' || pair.prPhase !== 'review') return null;
  if (pair.disabled || dark || activity === 'working') return null;

  const target = { repo: pair.repo ?? '', pullRequestNumber: pr.number };
  if (pr.checksStatus === 'failure') {
    return { target, disabled: true, title: `Checks are failing on PR #${pr.number}: yoke merges it only once they pass` };
  }
  if (pr.checksStatus === 'pending') {
    return { target, disabled: false, title: `Approve PR #${pr.number}: yoke squash-merges it once its checks pass` };
  }
  return { target, disabled: false, title: `Approve PR #${pr.number}: yoke squash-merges it` };
}

/** The WebSocket message asking yoke to approve `target` (see src/dashboard-server.ts). */
export function approveRequestMessage(target: ApproveTarget): Record<string, unknown> {
  return {
    type: 'pull-request-approve-request',
    repo: target.repo,
    pullRequestNumber: target.pullRequestNumber,
  };
}

// ── What became of an approval (#276) ───────────────────────────────────────

/** Whether an approval in this state has ended, one way or the other. */
export function isApprovalOutcome(state: unknown): state is Extract<PullRequestApprovalState, 'approved' | 'refused' | 'failed'> {
  return state === 'approved' || state === 'refused' || state === 'failed';
}

/** An outcome too old to show any more. An approval still under way never is. */
export function approvalStatusExpired(status: PullRequestApprovalStatus, nowMs: number): boolean {
  return isApprovalOutcome(status.state) && nowMs - status.receivedAtMs >= APPROVAL_OUTCOME_SHOW_MS;
}

/** The PR a pill's approval is about, or null when it has no PR. */
export function pairApproveTarget(pair: LifecyclePair): ApproveTarget | null {
  return pair.pr ? { repo: pair.repo ?? '', pullRequestNumber: pair.pr.number } : null;
}

function statusIsFor(status: PullRequestApprovalStatus, target: ApproveTarget): boolean {
  // A pill that does not know its project can only be on a one-project dashboard.
  return status.pullRequestNumber === target.pullRequestNumber && (target.repo === '' || status.repo === target.repo);
}

/** The latest approval status of a pill's PR, from the store's `approvals`. */
export function approvalStatusFor(
  approvals: ReadonlyMap<string, PullRequestApprovalStatus>,
  pair: LifecyclePair,
): PullRequestApprovalStatus | null {
  const target = pairApproveTarget(pair);
  if (target === null) return null;
  if (target.repo !== '') return approvals.get(approveKey(target)) ?? null;
  for (const status of approvals.values()) {
    if (statusIsFor(status, target)) return status;
  }
  return null;
}

/** This dashboard's press of a pill's Approve button, from the store's
 *  `approvalPresses` (#278), or null when there has been none. */
export function approvalPressFor(
  presses: ReadonlyMap<string, ApprovalPress>,
  pair: LifecyclePair,
): ApprovalPress | null {
  const target = pairApproveTarget(pair);
  return target === null ? null : presses.get(approveKey(target)) ?? null;
}

/** Every label the Approve button can show. They all fit its fixed width. */
export const APPROVE_BUTTON_LABELS = {
  /** Nothing pressed: press to approve. */
  idle: 'Approve',
  /** Pressed: waiting for yoke, then for an engine, to carry it out. */
  queued: 'Queued',
  /** An engine is carrying it out: squash-merging the PR, or fixing it so
   *  it can merge. */
  approving: 'Approving',
  /** An engine has squash-merged the PR. */
  merged: 'Merged',
  /** Yoke refused the press or it failed, for the reason on the line: press
   *  again. */
  retry: 'Retry',
} as const;

export type ApproveButtonStep = keyof typeof APPROVE_BUTTON_LABELS;

/** What a pill shows of its PR's approval, as it stands right now. */
export interface ApprovalView {
  /** The Approve button, or null for none. Only `idle` and `retry` are ever
   *  pressable. */
  button: { step: ApproveButtonStep; label: string; disabled: boolean; title: string } | null;
  /** Yoke has recorded the approval: the PR reads APPROVED, even before its
   *  lifecycle says so. */
  approved: boolean;
  /** The line saying what the approval is doing, or why it did not go
   *  through; null for none. `problem` lines are the ones it did not. */
  line: { text: string; tone: 'progress' | 'approved' | 'problem' } | null;
  /** When this view next changes on its own (epoch millis), or null. */
  refreshAtMs: number | null;
}

/** What an engine working an approved PR is doing first, when it is not the
 *  merge. The approval stands through it (#278): the PR merges after. */
const WORK_BEFORE_MERGE: Record<string, string> = {
  'address-failing-checks': 'an engine is fixing its failing checks',
  'resolve-conflicts': 'an engine is resolving its merge conflicts',
  'self-review': 'an engine is reviewing it again',
};

/**
 * What a pill shows of its PR's approval (#276, #278), from its lifecycle,
 * what an engine is doing to it, yoke's latest word on the approval, this
 * dashboard's own press, the connection to yoke, and the time.
 *
 * One press approves. From that instant the button reads Queued — sent to
 * yoke (or waiting to be, while the dashboard reconnects), then while yoke
 * reads the PR and waits for an engine to finish planning, then, approved,
 * until an engine is free to carry it out — and Approving once one is, while
 * it squash-merges the PR or fixes it first, then Merged. Yoke's answers and
 * the engines' actions move it along, never a timer: with no answer it stays
 * Queued, saying so. A press yoke refuses, or that fails, says why and offers
 * Retry, for as long as the pill is there: it never reads Approve again as if
 * it had not been pressed. Approve comes back only if yoke asks for approval
 * again after recording this one, saying so.
 *
 * An approval this dashboard did not send — another dashboard's, or one in
 * flight when the page loaded — shows the same way while yoke has it in hand
 * or the lifecycle shows it approved; how one ended shows for
 * `APPROVAL_OUTCOME_SHOW_MS`.
 */
export function approvalView(params: {
  pair: LifecyclePair;
  activity: PillActivity | null;
  /** The type of the action an engine is running on the pill, if any. */
  workingAction: string | null;
  /** Yoke is shutting down (issue #268). */
  dark: boolean;
  status: PullRequestApprovalStatus | null;
  press: ApprovalPress | null;
  /** The dashboard has a live connection to yoke. */
  connected: boolean;
  nowMs: number;
}): ApprovalView {
  const { pair, activity, dark, nowMs } = params;
  const target = pairApproveTarget(pair);
  // Only an open PR yoke may merge has an approval to follow: a merged or
  // manual one says what became of it in its own badges, as does a draft one
  // — unless yoke has it approved, since the approval stands through the
  // re-review a return to draft brings (#278).
  const draftApproved = pair.prPhase === 'active' && pair.pr?.draft === true && pair.approval === 'approved';
  if (target === null || (pair.prPhase !== 'review' && !draftApproved) || pair.disabled) {
    return { button: null, approved: false, line: null, refreshAtMs: null };
  }
  const key = approveKey(target);
  const n = target.pullRequestNumber;
  const control = approveControl(pair, activity, dark);
  const working = activity === 'working';
  const status = params.status !== null && statusIsFor(params.status, target) ? params.status : null;
  const press = params.press !== null && approveKey(params.press) === key ? params.press : null;
  // Yoke's word the view goes by: after a press, only an answer to it — a
  // status that arrived after it, whenever that was; with none, the latest,
  // an outcome only while it is fresh.
  const word = press !== null
    ? (status !== null && status.receivedAtMs >= press.atMs ? status : null)
    : (status !== null && !approvalStatusExpired(status, nowMs) ? status : null);

  // The view changes on its own when another dashboard's outcome goes stale,
  // and when an approval's answer is old enough for the lifecycle to rule.
  const refreshTimes: number[] = [];
  if (word !== null && isApprovalOutcome(word.state) && (press === null || word.state === 'approved')) {
    refreshTimes.push(word.receivedAtMs + APPROVAL_OUTCOME_SHOW_MS);
  }
  const show = (
    step: ApproveButtonStep,
    line: ApprovalView['line'],
    approved: boolean,
  ): ApprovalView => {
    const future = refreshTimes.filter((atMs) => atMs > nowMs);
    return {
      button: buttonFor(step, n, line, control, working, dark),
      approved,
      line,
      refreshAtMs: future.length > 0 ? Math.min(...future) : null,
    };
  };

  if (press?.merged) {
    return show('merged', { text: 'merged — an engine squash-merged it', tone: 'approved' }, true);
  }

  // Yoke has recorded the approval. The lifecycle can lag a beat behind the
  // answer; once the answer is old, a lifecycle asking for approval again
  // means this one was carried out and yoke changed the PR since.
  const approvedWord = word?.state === 'approved' ? word : null;
  const askedAgain = approvedWord !== null && pair.approval === 'awaiting-approval' && !working &&
    nowMs - approvedWord.receivedAtMs >= APPROVAL_OUTCOME_SHOW_MS;
  if (askedAgain) {
    return show('idle', { text: 'approved earlier — yoke is asking for approval again', tone: 'progress' }, false);
  }
  if (pair.approval === 'approved' || approvedWord !== null) {
    if (working) {
      const action = params.workingAction;
      const first = action !== null ? WORK_BEFORE_MERGE[action] : undefined;
      if (first !== undefined) {
        return show('approving', { text: `approving — ${first}, then it squash-merges`, tone: 'approved' }, true);
      }
      if (action === null || action === 'squash-merge') {
        return show('approving', { text: 'approving — an engine is squash-merging it', tone: 'approved' }, true);
      }
      return show('approving', { text: 'approving — an engine is working on it, then it squash-merges', tone: 'approved' }, true);
    }
    const checks = pair.pr?.checksStatus;
    const checksPending = checks === 'pending' ||
      (pair.approval !== 'approved' && approvedWord?.checksPending === true && checks !== 'failure');
    const text = dark
      ? 'approved — an engine squash-merges it once yoke runs again'
      : draftApproved
        ? 'approved — back in draft: an engine reviews it again, then squash-merges it'
        : checks === 'failure'
          ? 'approved — its checks failed: an engine fixes them, then squash-merges it'
          : checksPending
            ? 'approved — an engine squash-merges it once its checks pass'
            : 'approved — waiting for a free engine to squash-merge it';
    return show('queued', { text, tone: 'approved' }, true);
  }

  if (word?.state === 'loading' || word?.state === 'waiting') {
    const text = word.state === 'loading'
      ? `queued — yoke is reading PR #${n} from GitHub…`
      : 'queued — waiting for an engine to finish planning…';
    return show('queued', { text, tone: 'progress' }, false);
  }

  if (press !== null && word === null) {
    // Nothing back yet: it stays Queued, saying what it waits on (#278). A
    // press made while the dashboard was not connected, or sent and lost with
    // the connection, is sent again when it reconnects; a sent one's answer
    // is replayed then too, however late.
    if (!press.sent || !params.connected) {
      return show('queued', { text: 'queued — reconnecting to yoke…', tone: 'progress' }, false);
    }
    const answerByMs = (press.sentAtMs ?? press.atMs) + APPROVE_ACK_MS;
    if (nowMs < answerByMs) {
      refreshTimes.push(answerByMs);
      return show('queued', { text: 'queued — sent to yoke…', tone: 'progress' }, false);
    }
    return show('queued', { text: 'queued — sent to yoke, no answer yet…', tone: 'progress' }, false);
  }

  if (word?.state === 'refused' || word?.state === 'failed') {
    const text = word.state === 'refused'
      ? `not approved: ${word.reason ?? 'no reason given'}`
      : `approval failed: ${word.reason ?? 'unknown error'}`;
    return show(press !== null ? 'retry' : 'idle', { text, tone: 'problem' }, false);
  }

  return show('idle', null, false);
}

/** The button for `step`: pressable only to approve (again) when the PR can
 *  be approved, and otherwise saying what it is waiting on. */
function buttonFor(
  step: ApproveButtonStep,
  pullRequestNumber: number,
  line: ApprovalView['line'],
  control: ApproveControl | null,
  working: boolean,
  dark: boolean,
): ApprovalView['button'] {
  const label = APPROVE_BUTTON_LABELS[step];
  if (step === 'idle') {
    return control ? { step, label, disabled: control.disabled, title: control.title } : null;
  }
  if (step === 'retry') {
    if (control) {
      return { step, label, disabled: control.disabled, title: control.disabled ? control.title : `Retry — ${control.title}` };
    }
    const why = dark
      ? 'yoke is shutting down'
      : working
        ? `an engine is working on PR #${pullRequestNumber}`
        : `PR #${pullRequestNumber} is not waiting on approval`;
    return { step, label, disabled: true, title: `Cannot retry: ${why}` };
  }
  return { step, label, disabled: true, title: `PR #${pullRequestNumber} · ${line?.text ?? label}` };
}
