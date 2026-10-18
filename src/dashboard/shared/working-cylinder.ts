import type { CylinderState, LifecyclePair } from '../store/types.js';

/**
 * The engine cylinder actively working a lifecycle pill right now, or null when
 * nothing is (issue #262).
 *
 * Only a cylinder whose status is `active` counts: one that has finished
 * (`done`), failed (`error`), gone idle or shut down may still remember the
 * issue/PR it last touched, but nothing is happening to it anymore. The
 * cylinder may be attached through the pill's issue or through its PR — PR
 * actions such as self-review often carry no issue number — and when both
 * sides know their project the repos must agree, so projects sharing one
 * dashboard never light up each other's pills on an issue/PR number collision.
 */
export function workingCylinder(
  pair: LifecyclePair,
  cylinders: readonly CylinderState[],
): CylinderState | null {
  const issueNumber = pair.issue?.number ?? null;
  const prNumber = pair.pr?.number ?? null;
  for (const cyl of cylinders) {
    if (cyl.status !== 'active') continue;
    if (pair.repo && cyl.repo && pair.repo !== cyl.repo) continue;
    if (issueNumber !== null && cyl.issueNumber === issueNumber) return cyl;
    if (prNumber !== null && cyl.prNumber === prNumber) return cyl;
  }
  return null;
}
