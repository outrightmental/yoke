import type { ClockTimeRef } from '../store/types.js';

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  // A usage-limit hold can run for most of a day, and "487m 12s" is not a
  // number anybody reads as a time — roll up to hours past the hour mark.
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ── Wall-clock times ─────────────────────────────────────────────────────────
//
// Every wall-clock time the dashboard shows is rendered here, in the browser,
// from an instant: so it reads in the viewer's own time zone — the one their
// browser reports — and never in the server's (issue #272). `timeZone` exists
// so tests can pin a zone; the dashboard leaves it out.

/** Wall-clock form of a deadline, e.g. "Sep 21, 8:50 AM". */
export function formatClockTime(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
}

/** Stamp of an event-stream line: a fixed-width 24-hour time, e.g. "18:45:07". */
export function formatLogTime(ms: number, timeZone?: string): string {
  // `hourCycle`, not `hour12: false`, which some engines render as "24:05:00"
  // in the hour after midnight.
  return new Date(ms).toLocaleTimeString('en', { hourCycle: 'h23', timeZone });
}

/** Stamp of a broadcast card, in the viewer's locale, e.g. "6:45:07 PM". */
export function formatTimeOfDay(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleTimeString(undefined, { timeZone });
}

/**
 * `text` with each wall-clock time the server rendered into it — in the
 * server's zone — re-rendered from its instant in the viewer's. Text that names
 * none comes back as it was.
 *
 * One left-to-right pass, so a time already re-rendered is never mistaken for
 * another one the server rendered: "6:45 PM" in New York reads "3:45 PM" in Los
 * Angeles, which may well be the server's rendering of a different instant.
 */
export function localizeClockTimes(text: string, clockTimes: readonly ClockTimeRef[], timeZone?: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    let next: { at: number; ref: ClockTimeRef } | null = null;
    for (const ref of clockTimes) {
      if (ref.text === '') continue;
      const at = text.indexOf(ref.text, from);
      if (at === -1) continue;
      if (next === null || at < next.at || (at === next.at && ref.text.length > next.ref.text.length)) {
        next = { at, ref };
      }
    }
    if (next === null) return out + text.slice(from);
    out += text.slice(from, next.at) + formatClockTime(next.ref.atMs, timeZone);
    from = next.at + next.ref.text.length;
  }
}

export function formatModelName(modelId: string | null): string | null {
  if (!modelId) return null;
  const stripped = modelId.replace(/^claude-/i, '');
  const parts = stripped.split('-');
  let nameEnd = parts.length;
  for (let i = 0; i < parts.length; i++) {
    if (/^\d/.test(parts[i] ?? '')) { nameEnd = i; break; }
  }
  const nameParts = parts.slice(0, nameEnd).map(p => (p ?? '').charAt(0).toUpperCase() + (p ?? '').slice(1));
  const versionParts = parts.slice(nameEnd);
  let result = 'Claude ' + nameParts.join(' ');
  if (versionParts.length > 0) result += ' ' + versionParts.join('.');
  return result;
}
