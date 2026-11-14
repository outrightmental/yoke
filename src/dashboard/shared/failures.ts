import type { ActionFailure, LifecyclePair } from '../store/types.js';

/** How long a failed action stays on the dashboard when nothing takes its work
 *  up again. Yoke backs a failing action off for as long as an hour before it
 *  tries again (`ACTION_FAILURE_BACKOFF_MS` in src/index.ts), and a failure
 *  should not leave the dashboard while its work is still parked because of it. */
export const FAILURE_SHOW_MS = 90 * 60_000;

/**
 * Whether `failure` was on the work `pair` stands for: the same project, and
 * the PR it ran on — or, for an implementation, which has no PR yet, the issue.
 */
export function failureIsOn(
  failure: Pick<ActionFailure, 'repo' | 'issueNumber' | 'prNumber'>,
  pair: Pick<LifecyclePair, 'repo' | 'issue' | 'pr'>,
): boolean {
  if (pair.repo && failure.repo && pair.repo !== failure.repo) return false;
  if (failure.prNumber !== null) return pair.pr?.number === failure.prNumber;
  return failure.issueNumber !== null && pair.issue?.number === failure.issueNumber;
}

/**
 * The latest failure on `pair` still shown at `nowMs`, or null. The store
 * drops a failure once an engine takes its work up again, so one that is here
 * is an error nothing has answered yet.
 */
export function failureOn(
  pair: Pick<LifecyclePair, 'repo' | 'issue' | 'pr'>,
  failures: Iterable<ActionFailure>,
  nowMs: number,
): ActionFailure | null {
  let latest: ActionFailure | null = null;
  for (const failure of failures) {
    if (nowMs - failure.atMs >= FAILURE_SHOW_MS || !failureIsOn(failure, pair)) continue;
    if (latest === null || failure.atMs > latest.atMs) latest = failure;
  }
  return latest;
}
