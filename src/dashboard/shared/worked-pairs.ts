import type { CylinderState, LifecyclePair } from '../store/types.js';
import { workingCylinder } from './working-cylinder.js';

/**
 * State shown on a pill synthesized for work GitHub no longer lists as open.
 * The lifecycle feed only carries open issues and PRs, so a cylinder can be
 * working something the feed has dropped — an issue closed mid-flight, a PR
 * merged or closed by hand, an issue relabelled out of scope. The pill says so
 * rather than guessing "open" or "closed".
 */
export const UNLISTED_STATE = 'unlisted';

/**
 * The lifecycle pairs plus one synthesized pill for every active cylinder
 * whose issue or PR has no pill of its own (butterfly #402, 2026-10-18: an
 * engine spent a minute "implementing" an issue the lifecycle pane did not
 * show, because the issue had closed two seconds before the engine claimed
 * it). The engine pane and this pane now always agree about what is being
 * worked; what GitHub thinks of it is a separate question the badge answers.
 *
 * Pairs already present are never altered or reordered; synthesized pairs
 * are appended and sort by cylinder like any other worked pill.
 */
export function withWorkedPairs(
  pairs: readonly LifecyclePair[],
  cylinders: readonly CylinderState[],
): LifecyclePair[] {
  const extra: LifecyclePair[] = [];
  for (const cyl of cylinders) {
    if (cyl.status !== 'active') continue;
    if (cyl.issueNumber === null && cyl.prNumber === null) continue;
    const covered = (pair: LifecyclePair) => workingCylinder(pair, [cyl]) === cyl;
    if (pairs.some(covered) || extra.some(covered)) continue;

    const pr = cyl.prNumber !== null
      ? { number: cyl.prNumber, title: cyl.prTitle ?? '', state: UNLISTED_STATE }
      : null;
    extra.push({
      issue: cyl.issueNumber !== null
        ? { number: cyl.issueNumber, title: cyl.issueTitle ?? '', state: UNLISTED_STATE }
        : null,
      pr,
      prPhase: pr ? 'active' : 'planning',
      ...(cyl.repo ? { repo: cyl.repo } : {}),
    });
  }
  return extra.length === 0 ? [...pairs] : [...pairs, ...extra];
}
