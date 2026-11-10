// Stable per-issue color assignment (issue #236).
//
// Every issue owns one color forever: the hue is a pure function of the issue
// number (golden-angle spacing), so the same issue renders identically across
// engines, reloads, restarts, and browsers — and consecutive issue numbers get
// visually distant hues instead of colliding on a small palette.
//
// These are the engine colors: every one is fully saturated, because a gray
// engine just looks inactive (issue #280). Saturation on the dashboard means
// live computing burn; everything else is hue-free trim gray. Where the work
// is not burning at full heat it is drawn at a lower saturation of the same
// hue (`atSaturation`), on the scale in shared/burn-level.ts (issue #281).

/** Hue-free trim gray (`--trim-dim` in styles/tokens.css) for anything that
 *  is not work an engine can take on: idle cylinders, commits, CI/workflow
 *  events, log chrome. */
export const NEUTRAL_COLOR = '#8c8c8c';
export const NEUTRAL_COLOR_RGB = '140,140,140';

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

function hslColor(h: number, s: number, l: number): IssueColor {
  const r = hslChannel(h, s, l, 0);
  const g = hslChannel(h, s, l, 8);
  const b = hslChannel(h, s, l, 4);
  const hex = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  return { hex, rgb: `${r},${g},${b}` };
}

/** The stable color an issue keeps forever. */
export function issueColor(issueNumber: number): IssueColor {
  return hslColor(issueHue(issueNumber), SATURATION, LIGHTNESS);
}

/**
 * The same color at another HSL saturation (0..1), keeping its hue and
 * lightness, so it still reads as the same issue's — only cooler or hotter
 * (issue #281). A gray has no hue to keep, so it comes back as it is.
 */
export function atSaturation(color: IssueColor, saturation: number): IssueColor {
  const [r, g, b] = color.rgb.split(',').map((c) => Number(c) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (chroma === 0) return color;
  const sector = max === r ? (g - b) / chroma : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  const h = (sector * 60 + 360) % 360;
  return hslColor(h, Math.max(0, Math.min(1, saturation)), (max + min) / 2);
}

/**
 * The stable color of a piece of work: its issue's, or — for a PR that closes
 * no issue — the PR's own number's, so an engine working an orphan PR is never
 * gray (issue #280). GitHub numbers a repository's issues and PRs from one
 * sequence, so a PR's color never collides with an issue's. Null when there is
 * neither, and so nothing to work.
 */
export function workColor(
  issueNumber: number | null | undefined,
  prNumber: number | null | undefined,
): IssueColor | null {
  const n = issueNumber ?? prNumber;
  return n != null ? issueColor(n) : null;
}
