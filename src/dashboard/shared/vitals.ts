import type { DashboardState, WorkHold } from '../store/types.js';
import { formatClockTime, formatDuration } from './format.js';
import { usageGaugeView, usageLimitUntilMs, type UsageGaugeView } from './usage-gauge.js';

/** A hold parking the whole pool, as the field says it. */
export interface HoldView {
  kind: string;
  /** "2h 14m": how long is left. */
  remaining: string;
  /** "Sep 21, 8:50 AM", in the viewer's time zone (#272). */
  deadline: string;
  /** "Claude usage limit". */
  reason: string;
  untilMs: number;
}

/** Whether yoke is running, draining after a stop order, or has stopped. */
export type RunPhase = 'running' | 'shutting-down' | 'shut-down';

/**
 * The instruments along the top of the field: what used to be a header bar, a
 * hold banner and a status bar, as one reading of the run.
 */
export interface Vitals {
  /** The dashboard's title, as configured (`dashboard_title`). */
  title: string;
  /** "4 projects", or the one project's "owner/repo". */
  subtitle: string;
  /** Where the title links: the project on GitHub, or its owner with several. */
  homeUrl: string;
  /** The latest cycle any engine has started; 0 before the first. */
  cycle: number;
  /** What the run counts down to: the next cycle, or the end of a hold. */
  countdown: { label: 'NEXT' | 'WAITING'; value: string; held: boolean } | null;
  /** The hold parking every engine, or null when work is free to run. */
  hold: HoldView | null;
  /** The Claude account's usage window nearest its limit (#254). */
  usage: UsageGaugeView;
  connection: DashboardState['connection'];
  phase: RunPhase;
  /** How many engines are in the pool, and how many are running an action. */
  engines: number;
  burning: number;
  eventCount: number;
  sessionCount: number;
}

/** A hold that is still running at `nowMs`, or null. */
export function liveHold(hold: WorkHold | null, nowMs: number): WorkHold | null {
  return hold !== null && hold.untilMs > nowMs ? hold : null;
}

/**
 * The run's vitals at `nowMs`.
 *
 * A hold outranks every engine's own countdown: while one is active no engine
 * is going to start anything whatever its timer says, and "NEXT 1m" above a
 * pool parked for three hours is the most misleading thing the field could say.
 */
export function vitals(state: DashboardState, nowMs: number): Vitals {
  const hold = liveHold(state.hold, nowMs);
  const cycle = state.cylinders.reduce((max, c) => Math.max(max, c.iterationNumber), 0);
  const nextCycleAtMs = state.cylinders.reduce<number | null>((min, c) => {
    if (c.status === 'idle' && c.nextCycleAtMs !== null && (min === null || c.nextCycleAtMs < min)) {
      return c.nextCycleAtMs;
    }
    return min;
  }, null);

  const target = hold?.untilMs ?? nextCycleAtMs;
  const countdown = target !== null && target > nowMs
    ? { label: hold ? 'WAITING' as const : 'NEXT' as const, value: formatDuration(target - nowMs), held: hold !== null }
    : null;

  const projectCount = state.sessionCountByRepo.size || state.lifecycleByRepo.size;
  // With several projects there is no one repository to name or link to.
  const subtitle = state.multiProject
    ? (projectCount > 1 ? `${projectCount} projects` : '')
    : (state.owner && state.repo ? `${state.owner}/${state.repo}` : '');
  const homeUrl = state.multiProject
    ? `https://github.com/${state.owner || ''}`
    : `https://github.com/${state.owner}/${state.repo}`;

  return {
    title: state.title || 'Yoke',
    subtitle,
    homeUrl,
    cycle,
    countdown,
    hold: hold === null ? null : {
      kind: hold.kind,
      remaining: formatDuration(hold.untilMs - nowMs),
      deadline: formatClockTime(hold.untilMs),
      reason: hold.reason,
      untilMs: hold.untilMs,
    },
    usage: usageGaugeView(state.usage, nowMs, usageLimitUntilMs(hold)),
    connection: state.connection,
    phase: state.appShutdown ? 'shut-down' : state.shutdownRequested ? 'shutting-down' : 'running',
    engines: state.cylinders.length,
    burning: state.cylinders.filter((c) => c.status === 'active').length,
    eventCount: state.eventCount,
    sessionCount: state.sessionCount,
  };
}
