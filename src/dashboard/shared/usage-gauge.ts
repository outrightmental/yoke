import type { AccountUsage, WorkHold } from '../store/types.js';
import { formatClockTime, formatDuration } from './format.js';

/** Needle color of the usage gauge: green, amber, red — or dark when it has no reading. */
export type UsageTone = 'ok' | 'warn' | 'critical' | 'unknown';

export interface UsageGaugeView {
  tone: UsageTone;
  /** Share of the 5-hour window used, e.g. "37%"; "LIMIT" while a usage-limit
   *  hold parks the pool; "OFF" or "—" without a reading. */
  percentText: string;
  /** How full the meter bar is drawn, 0–100. */
  fillPercent: number;
  /** Time until the window resets, e.g. "2h 14m"; "—" when unknown. */
  resetText: string;
  /** Tooltip: what the gauge is showing, or why it shows nothing. */
  title: string;
}

export const USAGE_WARN_PERCENT = 70;
export const USAGE_CRITICAL_PERCENT = 90;
/** Readings arrive every minute; one older than this means they have stopped,
 *  and a frozen number would be worse than none. */
export const USAGE_STALE_AFTER_MS = 5 * 60_000;

const NO_VALUE = '—';

function noReading(percentText: string, title: string): UsageGaugeView {
  return { tone: 'unknown', percentText, fillPercent: 0, resetText: NO_VALUE, title };
}

/** When `hold` lifts, if it is the Claude usage limit (and not, say, GitHub's). */
export function usageLimitUntilMs(hold: WorkHold | null): number | null {
  return hold !== null && hold.kind === 'claude-usage-limit' ? hold.untilMs : null;
}

/** The percent `usage` has to show: a live one, or the last good one held over
 *  a failed read. Null when it has none. */
function percentToShow(usage: AccountUsage): number | null {
  return usage.status === 'ok' || (usage.status === 'unavailable' && usage.heldFromMs !== undefined)
    ? usage.fiveHourPercent
    : null;
}

/** A reading's own words, for the tooltip of a gauge that is showing something else. */
function readingNote(usage: AccountUsage | null, nowMs: number): string {
  if (usage === null) return '';
  const percent = percentToShow(usage);
  if (percent !== null && nowMs - usage.fetchedAtMs <= USAGE_STALE_AFTER_MS) {
    const asOf = usage.heldFromMs !== undefined ? ` at ${formatClockTime(usage.heldFromMs)}` : '';
    return ` · Anthropic last reported ${Math.round(percent)}% of the 5-hour window used${asOf}`;
  }
  return usage.reason ? ` · usage reading: ${usage.reason}` : '';
}

/**
 * What the header's Claude usage gauge shows for `usage` at `nowMs`. Never
 * blank: without a trustworthy reading it reads "—" (or "OFF" when there is no
 * token to read with) in the dark `unknown` tone, and the tooltip says why.
 * A failed read that holds over the last good numbers keeps showing them, so
 * one bad poll does not blank the gauge; the tooltip says when they were read
 * and why the latest read failed.
 *
 * `limitUntilMs` is when a Claude usage-limit hold lifts, if one is parking the
 * pool. The CLI has then said in so many words that nothing more can run until
 * that time, so the gauge reads LIMIT and counts down to it whatever the last
 * reading said — the reading may be unavailable, stale, or of the 5-hour window
 * while it was a weekly limit that ran out.
 */
export function usageGaugeView(
  usage: AccountUsage | null,
  nowMs: number,
  limitUntilMs: number | null = null,
): UsageGaugeView {
  if (limitUntilMs !== null && limitUntilMs > nowMs) {
    return {
      tone: 'critical',
      percentText: 'LIMIT',
      fillPercent: 100,
      resetText: formatDuration(limitUntilMs - nowMs),
      title: `Claude usage limit reached — work resumes ${formatClockTime(limitUntilMs)}${readingNote(usage, nowMs)}`,
    };
  }
  if (usage === null) {
    return noReading(NO_VALUE, 'Claude usage: waiting for the first reading');
  }
  if (usage.status === 'unconfigured') {
    return noReading('OFF', `Claude usage is off: ${usage.reason || 'log in with `claude`, or set anthropic_usage_token in env.yaml'}`);
  }
  const percentRead = percentToShow(usage);
  if (percentRead === null) {
    return noReading(NO_VALUE, `Claude usage unavailable: ${usage.reason || 'no reading'}`);
  }
  const ageMs = nowMs - usage.fetchedAtMs;
  if (ageMs > USAGE_STALE_AFTER_MS) {
    return noReading(NO_VALUE, `Claude usage: the last reading is ${formatDuration(ageMs)} old`);
  }
  if (usage.resetsAtMs !== null && usage.resetsAtMs <= nowMs) {
    return noReading(NO_VALUE, 'Claude usage: the 5-hour window has reset — waiting for the next reading');
  }

  const percent = Math.min(100, Math.max(0, percentRead));
  const tone: UsageTone =
    percent >= USAGE_CRITICAL_PERCENT ? 'critical' : percent >= USAGE_WARN_PERCENT ? 'warn' : 'ok';
  const resets = usage.resetsAtMs === null
    ? 'no window open yet'
    : `resets ${formatClockTime(usage.resetsAtMs)}`;
  const used = `${Math.round(percent)}% of the 5-hour window used`;
  return {
    tone,
    percentText: `${Math.round(percent)}%`,
    fillPercent: percent,
    resetText: usage.resetsAtMs === null ? NO_VALUE : formatDuration(usage.resetsAtMs - nowMs),
    title: usage.status !== 'ok' && usage.heldFromMs !== undefined
      ? `Claude usage: ${used} as of ${formatClockTime(usage.heldFromMs)}, ${resets}` +
        ` · the latest reading failed: ${usage.reason || 'no reading'}`
      : `Claude usage: ${used}, ${resets}`,
  };
}
