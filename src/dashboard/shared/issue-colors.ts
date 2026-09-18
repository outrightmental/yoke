// Stable per-issue color assignment (issue #236).
//
// Every issue owns one color forever: the hue is a pure function of the issue
// number (golden-angle spacing), so the same issue renders identically across
// engines, reloads, restarts, and browsers — and consecutive issue numbers get
// visually distant hues instead of colliding on a small palette.

/** Neutral gray used for anything not tied to an issue (idle cylinders,
 *  commits, CI/workflow events, orphan PRs, log chrome). */
export const NEUTRAL_COLOR = '#8a8f98';
export const NEUTRAL_COLOR_RGB = '138,143,152';

const GOLDEN_ANGLE_DEG = 137.508;
const SATURATION = 1;
const LIGHTNESS = 0.6;

export interface IssueColor {
  hex: string;
  /** "r,g,b" triplet for use inside rgba(). */
  rgb: string;
}

/** Stable hue in [0, 360) for an issue number. */
export function issueHue(issueNumber: number): number {
  const n = Math.abs(Math.trunc(issueNumber));
  return (n * GOLDEN_ANGLE_DEG) % 360;
}

function hslChannel(h: number, s: number, l: number, n: number): number {
  const k = (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
}

/** The stable color an issue keeps forever. */
export function issueColor(issueNumber: number): IssueColor {
  const h = issueHue(issueNumber);
  const r = hslChannel(h, SATURATION, LIGHTNESS, 0);
  const g = hslChannel(h, SATURATION, LIGHTNESS, 8);
  const b = hslChannel(h, SATURATION, LIGHTNESS, 4);
  const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  return { hex, rgb: `${r},${g},${b}` };
}
