import type { CylinderState, LifecyclePair } from '../store/types.js';
import { NEUTRAL_COLOR, NEUTRAL_COLOR_RGB, type IssueColor } from './issue-colors.js';
import type { PillActivity } from './pill-activity.js';

/**
 * How much token-burning activity a piece of work on the dashboard stands for
 * right now (issue #281), judged by its state alone, never by measured usage.
 * Each level is a stratum of the field, hottest at the top.
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
 * Only `burning` is drawn in the work's own hue (#286). The rainbow of issue
 * colors is kept for the top of the field, where engines are spending tokens,
 * so that it says one thing: this is burning. Every level below is hue-free
 * gray, the level saying itself in how bright the ink is and how much room a
 * line has; there the hue survives only as the small mark on each line's
 * track that says which issue it is, and saturated color is otherwise a
 * status signal (`WorkSignal` in shared/work-view.ts). See "Colour" in
 * design/DASHBOARD.md for the whole scheme.
 */
export type BurnLevel = 'burning' | 'queued' | 'waiting' | 'cold';

/** The hue-free gray work is drawn in below the burning stratum: `--trim-dim`. */
const BELOW_BURNING: IssueColor = { hex: NEUTRAL_COLOR, rgb: NEUTRAL_COLOR_RGB };

/**
 * The color a piece of work is drawn in at a level: its own hue while it
 * burns, and hue-free gray below (#286).
 */
export function burnColor(hue: IssueColor, level: BurnLevel): IssueColor {
  return level === 'burning' ? hue : BELOW_BURNING;
}

/**
 * The color an engine cylinder is drawn in: the hue of the work it holds, for
 * as long as it holds it — burning on it, and on the bench once its action has
 * ended, until it goes idle (#286). An engine is drawn in the burning stratum,
 * where the hue belongs, and a gray engine just looks inactive (#280). Trim
 * gray while it holds no work (idle, or parked by a limit).
 */
export function cylinderColor(cyl: Pick<CylinderState, 'color' | 'colorRgb'>): IssueColor {
  if (!cyl.color || !cyl.colorRgb) return { hex: NEUTRAL_COLOR, rgb: NEUTRAL_COLOR_RGB };
  return { hex: cyl.color, rgb: cyl.colorRgb };
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
