import type { CylinderState, LifecyclePair } from '../store/types.js';

/**
 * Whether a cylinder's issue/PR is this lifecycle pill's. The cylinder may be
 * attached through the pill's issue or through its PR — PR actions such as
 * self-review often carry no issue number — and when both sides know their
 * project the repos must agree, so projects sharing one dashboard never light
 * up each other's pills on an issue/PR number collision.
 */
function cylinderOnPill(pair: LifecyclePair, cyl: CylinderState): boolean {
  if (pair.repo && cyl.repo && pair.repo !== cyl.repo) return false;
  const issueNumber = pair.issue?.number ?? null;
  const prNumber = pair.pr?.number ?? null;
  if (issueNumber !== null && cyl.issueNumber === issueNumber) return true;
  return prNumber !== null && cyl.prNumber === prNumber;
}

/**
 * The engine cylinder actively working a lifecycle pill right now, or null when
 * nothing is (issue #262).
 *
 * Only a cylinder whose status is `active` counts: one that has finished
 * (`done`), failed (`error`), gone idle or shut down may still remember the
 * issue/PR it last touched, but nothing is happening to it anymore.
 */
export function workingCylinder(
  pair: LifecyclePair,
  cylinders: readonly CylinderState[],
): CylinderState | null {
  return cylinders.find((cyl) => cyl.status === 'active' && cylinderOnPill(pair, cyl)) ?? null;
}

/**
 * The engine cylinder that went dark while it was on a lifecycle pill, or null
 * when none did (issue #268).
 *
 * At shutdown an engine finishes its in-flight action and then retires, still
 * remembering the issue/PR it worked. No lifecycle update follows for that
 * pill, so whatever it last showed — `implementing…`, checks running, ready
 * for review — is stale, and the pill goes dark with its cylinder. An engine
 * that was between cycles when it retired has already let go of its last pill,
 * which the updates since then kept current.
 */
export function shutDownCylinder(
  pair: LifecyclePair,
  cylinders: readonly CylinderState[],
): CylinderState | null {
  return cylinders.find((cyl) => cyl.status === 'shutdown' && cylinderOnPill(pair, cyl)) ?? null;
}
