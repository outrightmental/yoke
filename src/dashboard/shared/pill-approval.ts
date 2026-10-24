import type { LifecyclePair } from '../store/types.js';
import type { PillActivity } from './pill-activity.js';

/** The PR an Approve click names: its number and the project it is in. */
export interface ApproveTarget {
  /** "owner/repo"; empty only when the pill does not know its project. */
  repo: string;
  pullRequestNumber: number;
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
