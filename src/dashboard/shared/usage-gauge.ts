import type { AccountUsage } from '../store/types.js';
import { formatClockTime, formatDuration } from './format.js';

/** Needle color of the usage gauge: green, amber, red — or dark when it has no reading. */
export type UsageTone = 'ok' | 'warn' | 'critical' | 'unknown';

export interface UsageGaugeView {
  tone: UsageTone;
  /** Share of the 5-hour window used, e.g. "37%"; "OFF" or "—" without a reading. */
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

/**
 * What the header's Claude usage gauge shows for `usage` at `nowMs`. Never
 * blank: without a trustworthy reading it reads "—" (or "OFF" when no token is
 * configured) in the dark `unknown` tone, and the tooltip says why.
 */
export function usageGaugeView(usage: AccountUsage | null, nowMs: number): UsageGaugeView {
  if (usage === null) {
    return noReading(NO_VALUE, 'Claude usage: waiting for the first reading');
  }
  if (usage.status === 'unconfigured') {
    return noReading('OFF', `Claude usage is off: ${usage.reason || 'log in with `claude`, or set anthropic_usage_token in env.yaml'}`);
  }
  if (usage.status !== 'ok' || usage.fiveHourPercent === null) {
    return noReading(NO_VALUE, `Claude usage unavailable: ${usage.reason || 'no reading'}`);
  }
  const ageMs = nowMs - usage.fetchedAtMs;
  if (ageMs > USAGE_STALE_AFTER_MS) {
    return noReading(NO_VALUE, `Claude usage: the last reading is ${formatDuration(ageMs)} old`);
  }
  if (usage.resetsAtMs !== null && usage.resetsAtMs <= nowMs) {
    return noReading(NO_VALUE, 'Claude usage: the 5-hour window has reset — waiting for the next reading');
  }

  const percent = Math.min(100, Math.max(0, usage.fiveHourPercent));
  const tone: UsageTone =
    percent >= USAGE_CRITICAL_PERCENT ? 'critical' : percent >= USAGE_WARN_PERCENT ? 'warn' : 'ok';
  const resets = usage.resetsAtMs === null
    ? 'no window open yet'
    : `resets ${formatClockTime(usage.resetsAtMs)}`;
  return {
    tone,
    percentText: `${Math.round(percent)}%`,
    fillPercent: percent,
    resetText: usage.resetsAtMs === null ? NO_VALUE : formatDuration(usage.resetsAtMs - nowMs),
    title: `Claude usage: ${Math.round(percent)}% of the 5-hour window used, ${resets}`,
  };
}
