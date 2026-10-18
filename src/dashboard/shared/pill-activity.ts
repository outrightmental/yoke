import type { CylinderState, DashboardState, LifecyclePair } from '../store/types.js';
import { workingCylinder } from './working-cylinder.js';

/**
 * What a lifecycle pill is doing — or waiting on — right now, shown by the
 * animated status icon at its far right (issue #262):
 *
 * - `working`: an engine cylinder is running an action on it.
 * - `manual`: its PR is labelled "manual", so yoke leaves it to a human.
 * - `waiting-ci`: its PR's checks are queued or running. Yoke never advances
 *   a PR past pending checks, so that is why no engine is working it.
 * - `review`: its PR is ready for review.
 */
export type PillActivity = 'working' | 'manual' | 'waiting-ci' | 'review';

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
 * the most immediate reason wins: a working cylinder beats everything (it may
 * be fixing checks that ran too long); a manual PR is never worked whatever
 * its checks say; and a ready PR whose checks are still running is waiting on
 * them, not on a reviewer.
 */
export function pillActivity(
  pair: LifecyclePair,
  cylinders: readonly CylinderState[],
): PillActivity | null {
  if (workingCylinder(pair, cylinders)) return 'working';
  if (pair.disabled) return 'manual';
  if (waitingOnChecks(pair)) return 'waiting-ci';
  if (pair.prPhase === 'review') return 'review';
  return null;
}

/**
 * Whether every lifecycle pill is dark (issue #268): from the moment a shutdown
 * is requested — or, for a dashboard that only hears the end of it, once yoke
 * has shut down. No engine starts new work after that, and the pills will get
 * no further updates to keep them live, so they all go dark together, active
 * or not, like the shut-down cylinder rows.
 */
export function pillsDark(state: Pick<DashboardState, 'shutdownRequested' | 'appShutdown'>): boolean {
  return state.shutdownRequested || state.appShutdown;
}
