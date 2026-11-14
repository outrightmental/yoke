import type { CylinderState, DashboardState } from '../store/types.js';
import { cylinderColor } from './burn-level.js';
import { formatDuration, formatModelName } from './format.js';
import type { IssueColor } from './issue-colors.js';
import { actionTarget, actionVerb } from './work-view.js';

/** What is parking an idle engine, when a shared limit is. */
export type EngineParked = 'usage-limit' | 'rate-limit' | null;

/**
 * One engine cylinder as the field draws it: a ring, burning in the hue of
 * its work while it runs an action, and on the bench otherwise — still in
 * that hue while it holds the work its action ended on, in trim gray once it
 * holds none.
 */
export interface EngineView {
  /** Counted from 0; the field labels it `index + 1`, as the log does. */
  index: number;
  status: CylinderState['status'];
  /** Its work's hue for as long as it holds the work; trim gray with none (#280, #286). */
  color: IssueColor;
  /** Whether it holds work at all — an idle or parked engine does not. */
  hasWork: boolean;
  /** "Claude Opus 5.5", or null when it is not running a model. */
  model: string | null;
  /** The cycle it is on, or 0 before its first. */
  iteration: number;
  /** "owner/repo" of its work, or empty. */
  repo: string;
  /** "implementing", "reviewed", "idle", "usage limit", "shut down"… */
  verb: string;
  /** "#40", "PR #118", or empty with no work. */
  target: string;
  /** The running clock: an action's elapsed time, or an idle engine's
   *  countdown to its next cycle or to the end of a limit. Empty for none. */
  clock: string;
  /** All of it on one line, as a screen reader hears it. */
  line: string;
  /** The same in the fewest words, for the bench: "idle · 42s". */
  brief: string;
  parked: EngineParked;
  /** When its action started, for the ring's clock; null unless it is active. */
  startedAtMs: number | null;
}

/**
 * How an engine cylinder reads at `nowMs`.
 *
 * - `active`: "implementing #40" with the action's running time.
 * - `done`, `error`: "✓ reviewed PR #119", "✗ reviewing PR #119 failed". A
 *   cylinder holds these only until it reports idle, which in a normal run is
 *   at once; they are for a run that ends on one (`--once`, a shutdown).
 * - `idle`: what it is waiting on — a limit, by name, since that is a hold
 *   and not an empty queue; or the time to its next cycle; or its own words.
 * - `shutdown`: "shut down".
 */
export function engineView(cyl: CylinderState, nowMs: number): EngineView {
  const color = cylinderColor(cyl);
  const base = {
    index: cyl.index - 1,
    status: cyl.status,
    color,
    hasWork: cyl.color !== null,
    model: formatModelName(cyl.model),
    iteration: cyl.iterationNumber,
    repo: cyl.repo ?? '',
    parked: null as EngineParked,
    startedAtMs: null as number | null,
  };

  if (cyl.status === 'shutdown') {
    return { ...base, hasWork: false, verb: 'shut down', target: '', clock: '', line: 'shut down', brief: 'shut down' };
  }

  if (cyl.status === 'active' || cyl.status === 'done' || cyl.status === 'error') {
    const target = actionTarget(cyl);
    if (cyl.status === 'active') {
      const verb = actionVerb(cyl.actionType);
      const clock = cyl.actionStartedAt !== null ? formatDuration(nowMs - cyl.actionStartedAt) : '';
      const what = target ? `${verb} ${target}` : verb;
      return {
        ...base, verb, target, clock,
        line: clock ? `${what} · ${clock}` : what,
        brief: what,
        startedAtMs: cyl.actionStartedAt,
      };
    }
    if (cyl.status === 'done') {
      const verb = actionVerb(cyl.actionType, 'done');
      const line = `✓ ${target ? `${verb} ${target}` : verb}`;
      return { ...base, verb, target, clock: '', line, brief: line };
    }
    const verb = actionVerb(cyl.actionType);
    const line = `✗ ${target ? `${verb} ${target}` : verb} failed`;
    return { ...base, verb, target, clock: '', line, brief: line };
  }

  if (cyl.rateLimitedUntilMs !== null && cyl.rateLimitedUntilMs > nowMs) {
    // The engine-idle reason names which limit parked it, so say which.
    const parked: EngineParked = cyl.idleStatusText === 'claude-usage-limit' ? 'usage-limit' : 'rate-limit';
    const verb = parked === 'usage-limit' ? 'usage limit' : 'rate limited';
    const clock = formatDuration(cyl.rateLimitedUntilMs - nowMs);
    return { ...base, verb, target: '', clock, line: `⏸ ${verb} · ${clock}`, brief: `${verb} · ${clock}`, parked };
  }
  if (cyl.nextCycleAtMs !== null && cyl.nextCycleAtMs > nowMs) {
    const clock = formatDuration(cyl.nextCycleAtMs - nowMs);
    return { ...base, verb: 'idle', target: '', clock, line: `idle · next cycle in ${clock}`, brief: `idle · ${clock}` };
  }
  const words = cyl.idleStatusText || 'idle';
  return { ...base, verb: words, target: '', clock: '', line: words, brief: words };
}

/** Every engine cylinder in the pool, in order. */
export function engineViews(state: Pick<DashboardState, 'cylinders'>, nowMs: number): EngineView[] {
  return state.cylinders.map((cyl) => engineView(cyl, nowMs));
}
