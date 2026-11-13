// Stable per-issue color assignment (issue #236).
//
// Every issue owns one color forever: the hue is a pure function of the issue
// number (golden-angle spacing), so the same issue renders identically across
// engines, reloads, restarts, and browsers — and consecutive issue numbers get
// visually distant hues instead of colliding on a small palette.
//
// These are the engine colors: every one is fully saturated, because a gray
// engine just looks inactive (issue #280). The rainbow they make is kept for
// the burning stratum at the top of the field (issue #286): an engine's ring,
// its reactor, and the work it is on. Below it, work is hue-free gray, and an
// issue's color survives there only as the one small mark on its line that
// says which issue it is — the same color as its inbox card and its tether,
// so either can be matched to the line. Everything else is trim gray, and the
// only other saturated colors are the status signals in styles/tokens.css.

/** Hue-free trim gray (`--trim-dim` in styles/tokens.css) for anything that
 *  is not burning: idle cylinders, commits, CI/workflow events, log chrome,
 *  and every line of work below the burning stratum (issue #286). */
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
