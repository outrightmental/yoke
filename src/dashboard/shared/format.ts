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

/** Wall-clock form of a deadline, e.g. "Sep 21, 8:50 AM". */
export function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
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
