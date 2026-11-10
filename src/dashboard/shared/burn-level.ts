import type { CylinderState, LifecyclePair } from '../store/types.js';
import { atSaturation, NEUTRAL_COLOR, NEUTRAL_COLOR_RGB, type IssueColor } from './issue-colors.js';
import type { PillActivity } from './pill-activity.js';

/**
 * How much token-burning activity a piece of work on the dashboard stands for
 * right now (issue #281), judged by its state alone, never by measured usage.
 * More saturation means more burn: each level is one saturation of the work's
 * own stable hue, so the hue still says *which* issue and the saturation says
 * *how hot* it is, the same in every component that draws it.
 *
 * - `burning`: an engine is running an action on it right now.
 * - `queued`: yoke burns on it next, with nothing but yoke's own pipeline in
 *   the way: waiting on its checks, an approved merge, an open PR or a ready
 *   issue waiting its turn for an engine.
 * - `waiting`: parked until someone moves first: a human reviewer, or the
 *   issues blocking it.
 * - `cold`: nothing is coming: an engine's action has ended (done, failed,
 *   shut down), the PR is manual, merged, or out of the queue, or yoke has
 *   shut down.
 *
 * Even `cold` keeps a floor of saturation, so its hue still tells one issue
 * from another and work never reads as trim. Only what is no work at all —
 * an idle cylinder, one parked by a rate or usage limit — is trim gray, with
 * none.
 */
export type BurnLevel = 'burning' | 'queued' | 'waiting' | 'cold';

/** The HSL saturation each level is drawn at, hottest first. */
export const BURN_SATURATION: Readonly<Record<BurnLevel, number>> = {
  burning: 1,
  queued: 0.6,
  waiting: 0.4,
  cold: 0.2,
};

/** A piece of work's stable color at a level of the scale. */
export function burnColor(color: IssueColor, level: BurnLevel): IssueColor {
  return atSaturation(color, BURN_SATURATION[level]);
}

/**
 * An engine cylinder's level: burning while it runs an action, cold once the
 * action is done, has failed, or the cylinder has shut down.
 */
export function cylinderBurnLevel(status: CylinderState['status']): BurnLevel {
  return status === 'active' ? 'burning' : 'cold';
}

/**
 * The color an engine cylinder is drawn in: the work it holds, at its level;
 * trim gray while it holds none (idle, or parked by a limit).
 */
export function cylinderColor(cyl: Pick<CylinderState, 'status' | 'color' | 'colorRgb'>): IssueColor {
  if (!cyl.color || !cyl.colorRgb) return { hex: NEUTRAL_COLOR, rgb: NEUTRAL_COLOR_RGB };
  return burnColor({ hex: cyl.color, rgb: cyl.colorRgb }, cylinderBurnLevel(cyl.status));
}

/**
 * A lifecycle pill's level, from its activity (the status icon) and, when it
 * has none, from where its work stands. A dark pill is cold whatever it was
 * doing: no engine starts new work once yoke is shutting down (issue #268).
 */
export function pillBurnLevel(
  pair: LifecyclePair,
  activity: PillActivity | null,
  dark: boolean,
): BurnLevel {
  if (dark) return 'cold';
  switch (activity) {
    case 'working': return 'burning';
    case 'waiting-ci': return 'queued';
    case 'review': return 'waiting';
    case 'manual': return 'cold';
  }
  if (pair.prPhase === 'completed' || pair.prPhase === 'inactive') return 'cold';
  if ((pair.blockedByIssueNumbers?.length ?? 0) > 0) return 'waiting';
  return 'queued';
}
