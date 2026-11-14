/**
 * The colors the field paints with that are not a piece of work's own.
 *
 * A canvas cannot say `var(--trim)`, so the painter is handed the tokens as
 * numbers — read once from the same custom properties in styles/tokens.css
 * that the rest of the dashboard uses. The rule those tokens encode therefore
 * holds on the canvas too (#280): the trim is hue-free gray, the only
 * saturated colors that are not a work's are the named status signals, and
 * nothing here brings a color of its own. Below the burning stratum a work's
 * color is one of these grays too, and a status signal its only color (#286).
 */
export type Rgb = readonly [number, number, number];

export interface Palette {
  /** The field's ground, and the lighter tone it lifts to at the top. */
  bg: Rgb;
  bgAlt: Rgb;
  trim: Rgb;
  trimBright: Rgb;
  trimDim: Rgb;
  /** Status signals: an approval going through; waiting on a person, or a
   *  warning; something held up — a block, a hold, a shutdown; an error or a
   *  lost connection; and, in the inbox, a card's problem (#286). */
  green: Rgb;
  yellow: Rgb;
  orange: Rgb;
  red: Rgb;
  coral: Rgb;
}

/** `rgba()` of an `Rgb`, or of an issue color's "r,g,b" triplet, at an alpha. */
export function rgba(color: Rgb | string, alpha: number): string {
  const channels = typeof color === 'string' ? color : `${color[0]},${color[1]},${color[2]}`;
  return `rgba(${channels},${alpha < 0 ? 0 : alpha > 1 ? 1 : Math.round(alpha * 1000) / 1000})`;
}

/** A color written as `#rrggbb`, `#rgb` or `r, g, b`; null for anything else. */
export function parseColor(text: string): Rgb | null {
  const value = text.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex !== undefined) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
  }
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) {
    return parts as unknown as Rgb;
  }
  return null;
}

/** What a missing token falls back to: gray, so that a stylesheet that has not
 *  loaded costs the field its signals but never invents a color. */
const FALLBACK: Rgb = [140, 140, 140];
const FALLBACK_GROUND: Rgb = [14, 14, 14];

/**
 * The palette, from the custom properties of `style` — the computed style of
 * the document's root in the browser.
 */
export function readPalette(style: { getPropertyValue(name: string): string }): Palette {
  const token = (name: string, fallback: Rgb): Rgb => parseColor(style.getPropertyValue(name)) ?? fallback;
  return {
    bg: token('--bg-dark', FALLBACK_GROUND),
    bgAlt: token('--bg-dark-alt', FALLBACK_GROUND),
    trim: token('--trim', FALLBACK),
    trimBright: token('--trim-bright', FALLBACK),
    trimDim: token('--trim-dim', FALLBACK),
    green: token('--color-green', FALLBACK),
    yellow: token('--color-yellow', FALLBACK),
    orange: token('--color-orange', FALLBACK),
    red: token('--color-red', FALLBACK),
    coral: token('--color-coral', FALLBACK),
  };
}
