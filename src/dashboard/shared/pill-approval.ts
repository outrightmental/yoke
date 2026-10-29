import type { LifecyclePair, PullRequestApprovalState, PullRequestApprovalStatus } from '../store/types.js';
import type { PillActivity } from './pill-activity.js';

/** How long an armed Approve button waits for the confirming second click. */
export const APPROVE_CONFIRM_MS = 4000;
/** How long a sent approval waits for yoke's first answer before the pill
 *  says none came. Yoke answers at once, even while the approval queues. */
export const APPROVE_ACK_MS = 10_000;
/** How long the pill shows how an approval ended (#276) — and how long the
 *  dashboard server replays it to a page opened meanwhile. */
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
 * The Approve button a lifecycle pill shows (#274), or null for none.
 *
 * Only a ready PR parked by the `review` label gets one — the server marks
 * those `awaiting-approval` — and only while no engine is working it and yoke
 * is not shutting down, when no engine would start the merge. An approval
 * never merges over failing checks, so the button is disabled while they fail;
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

/** The pill's own latest press of its Approve button. */
export interface ApproveClick {
  /** The PR it was for (`approveKey`), so a pill element reused for another
   *  PR never carries it over. */
  key: string;
  /** `confirm`: the first click, armed for a confirming second one.
   *  `sent`: the confirming click, sent to yoke.
   *  `unsent`: the confirming click, which could not be sent. */
  step: 'confirm' | 'sent' | 'unsent';
  /** Epoch millis of the click, by this browser's clock. */
  atMs: number;
}

/** Every label the Approve button can show. They all fit its fixed width. */
export const APPROVE_BUTTON_LABELS = {
  idle: 'Approve',
  confirm: 'Confirm',
  sending: 'Sending',
  approving: 'Approving',
} as const;

export type ApproveButtonStep = keyof typeof APPROVE_BUTTON_LABELS;

/** What a pill shows of its PR's approval, as it stands right now. */
export interface ApprovalView {
  /** The Approve button, or null for none. */
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

/**
 * What a pill shows of its PR's approval (#276), from the Approve button the
 * lifecycle offers (`approveControl`), yoke's latest word on the approval, the
 * pill's own latest click, and the time.
 *
 * Once the confirming click is sent the pill follows yoke, not a timer: it
 * reads Sending until yoke's first answer — any status for the PR that arrives
 * after the click, since yoke always answers, if only with the attempt already
 * in flight — then Approving for as long as the approval is under way, then
 * how it ended. Only when no answer comes within `APPROVE_ACK_MS` does it say
 * so. An approval this pill did not send (another dashboard's, or one in
 * flight when the page loaded) shows the same way. How an approval ended is
 * shown for `APPROVAL_OUTCOME_SHOW_MS`, or until the next press.
 */
export function approvalView(params: {
  /** The PR the pill is for, or null when it has none. */
  target: ApproveTarget | null;
  control: ApproveControl | null;
  status: PullRequestApprovalStatus | null;
  click: ApproveClick | null;
  nowMs: number;
}): ApprovalView {
  const { target, control, nowMs } = params;
  const status = target !== null && params.status !== null && statusIsFor(params.status, target) ? params.status : null;
  const click = target !== null && params.click?.key === approveKey(target) ? params.click : null;
  const prNumber = target?.pullRequestNumber ?? 0;

  const button = (step: ApproveButtonStep, disabled: boolean, title: string): ApprovalView['button'] =>
    control ? { step, label: APPROVE_BUTTON_LABELS[step], disabled, title } : null;
  const idle = (): ApprovalView['button'] => button('idle', control?.disabled ?? false, control?.title ?? '');
  const problem = (text: string, refreshAtMs: number): ApprovalView => ({
    button: idle(),
    approved: false,
    line: { text, tone: 'problem' },
    refreshAtMs,
  });

  // The confirming click went to yoke and nothing has come back since.
  if (click?.step === 'sent' && (status === null || status.receivedAtMs < click.atMs)) {
    const ackByMs = click.atMs + APPROVE_ACK_MS;
    if (nowMs < ackByMs) {
      return {
        button: button('sending', true, `Approval of PR #${prNumber} sent to yoke`),
        approved: false,
        line: { text: 'approval sent to yoke…', tone: 'progress' },
        refreshAtMs: ackByMs,
      };
    }
    if (nowMs < ackByMs + APPROVAL_OUTCOME_SHOW_MS) {
      return problem('no answer from yoke — check the connection and the event log', ackByMs + APPROVAL_OUTCOME_SHOW_MS);
    }
    return { button: idle(), approved: false, line: null, refreshAtMs: null };
  }

  if (status !== null && (status.state === 'loading' || status.state === 'waiting')) {
    const text = status.state === 'loading'
      ? `approving — reading PR #${prNumber} from GitHub…`
      : 'approving — waiting for a free planner…';
    return {
      button: button('approving', true, `Yoke is approving PR #${prNumber}`),
      approved: false,
      line: { text, tone: 'progress' },
      refreshAtMs: null,
    };
  }

  // How the approval ended, unless it is stale or a later press supersedes it.
  if (status !== null && !approvalStatusExpired(status, nowMs) && (click === null || status.receivedAtMs >= click.atMs)) {
    const hideAtMs = status.receivedAtMs + APPROVAL_OUTCOME_SHOW_MS;
    if (status.state === 'approved') {
      const text = status.checksPending
        ? 'approved — an engine will squash-merge it once its checks pass'
        : 'approved — an engine will squash-merge it';
      // The line stays until the lifecycle shows the approval, when the
      // pill offers no Approve button any more and APPROVED says it all.
      return {
        button: null,
        approved: true,
        line: control ? { text, tone: 'approved' } : null,
        refreshAtMs: hideAtMs,
      };
    }
    return problem(
      status.state === 'refused' ? `not approved: ${status.reason ?? 'no reason given'}` : `approval failed: ${status.reason ?? 'unknown error'}`,
      hideAtMs,
    );
  }

  if (click?.step === 'confirm' && nowMs < click.atMs + APPROVE_CONFIRM_MS && !control?.disabled) {
    return {
      button: button('confirm', false, `Click again to approve and squash-merge PR #${prNumber}`),
      approved: false,
      line: null,
      refreshAtMs: click.atMs + APPROVE_CONFIRM_MS,
    };
  }

  if (click?.step === 'unsent' && nowMs < click.atMs + APPROVAL_OUTCOME_SHOW_MS) {
    return problem('not sent — the dashboard is not connected to yoke', click.atMs + APPROVAL_OUTCOME_SHOW_MS);
  }

  return { button: idle(), approved: false, line: null, refreshAtMs: null };
}
