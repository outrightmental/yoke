import type { CylinderState, LifecyclePair } from '../store/types.js';
import { shutDownCylinder, workingCylinder } from './working-cylinder.js';

/**
 * What a lifecycle pill is doing — or waiting on — right now, shown by the
 * animated status icon at its far right (issue #262):
 *
 * - `working`: an engine cylinder is running an action on it.
 * - `shutdown`: the cylinder that was working it has shut down, or yoke has,
 *   so nothing on it is live anymore and the pill goes dark (issue #268).
 * - `manual`: its PR is labelled "manual", so yoke leaves it to a human.
 * - `waiting-ci`: its PR's checks are queued or running. Yoke never advances
 *   a PR past pending checks, so that is why no engine is working it.
 * - `review`: its PR is ready for review.
 */
export type PillActivity = 'working' | 'shutdown' | 'manual' | 'waiting-ci' | 'review';

/**
 * Whether the pill's PR is waiting on its GitHub Actions run: open, not yet
 * merged, and its head commit's checks still queued, pending or running.
 */
export function waitingOnChecks(pair: LifecyclePair): boolean {
  const pr = pair.pr;
  if (!pr || pr.state !== 'open' || pair.prPhase === 'completed') return false;
  return pr.checksStatus === 'pending';
}

/**
 * The pill's activity, or null when it is in none of these states. Ranked so
 * the most immediate reason wins: once yoke itself has shut down every pill is
 * dark, whatever it last showed — even one whose engine died mid-action, never
 * reporting its cylinder done; otherwise a working cylinder beats everything
 * (it may be fixing checks that ran too long); a pill whose cylinder shut down
 * on it will get no further updates, so its other states are stale; a manual
 * PR is never worked whatever its checks say; and a ready PR whose checks are
 * still running is waiting on them, not on a reviewer.
 */
export function pillActivity(
  pair: LifecyclePair,
  cylinders: readonly CylinderState[],
  yokeShutDown = false,
): PillActivity | null {
  if (yokeShutDown) return 'shutdown';
  if (workingCylinder(pair, cylinders)) return 'working';
  if (shutDownCylinder(pair, cylinders)) return 'shutdown';
  if (pair.disabled) return 'manual';
  if (waitingOnChecks(pair)) return 'waiting-ci';
  if (pair.prPhase === 'review') return 'review';
  return null;
}
