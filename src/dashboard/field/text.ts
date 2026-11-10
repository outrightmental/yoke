/**
 * Fitting text to the room the layout gave it.
 *
 * A canvas does not wrap or truncate: every line the field draws is measured
 * first, and cut with an ellipsis or broken across lines here. Measuring is
 * the most expensive thing the painter does, so every answer is remembered —
 * a title is measured once, not sixty times a second while it glides.
 */

/** The face a run of text is set in: one for reading, one for figures. */
export const SANS = '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

export interface TextStyle {
  /** A CSS font shorthand, as `CanvasRenderingContext2D.font` takes it. */
  font: string;
  /** Extra space between letters, in pixels. */
  spacing: number;
}

export function sans(weight: number, size: number, spacing = 0): TextStyle {
  return { font: `${weight} ${size}px ${SANS}`, spacing };
}

export function mono(weight: number, size: number, spacing = 0): TextStyle {
  return { font: `${weight} ${size}px ${MONO}`, spacing };
}

/** The faces the field asks the browser to load before it trusts a measurement. */
export const FONT_FACES: readonly string[] = [
  `400 12px ${MONO}`, `500 12px ${MONO}`, `600 12px ${MONO}`, `700 12px ${MONO}`,
  `400 12px ${SANS}`, `500 12px ${SANS}`, `600 12px ${SANS}`,
];

const ELLIPSIS = '…';
/** Past this many remembered answers the cache is emptied rather than tended:
 *  a full cache means the text on screen has turned over many times. */
const CACHE_LIMIT = 6000;

export class TextFitter {
  private readonly _widths = new Map<string, number>();
  private readonly _fits = new Map<string, string>();

  constructor(private readonly _measure: (text: string, style: TextStyle) => number) {}

  /** Forget everything — the fonts have loaded, so every width is stale. */
  clear(): void {
    this._widths.clear();
    this._fits.clear();
  }

  width(text: string, style: TextStyle): number {
    if (text === '') return 0;
    const key = `${style.font}|${style.spacing}|${text}`;
    let width = this._widths.get(key);
    if (width === undefined) {
      if (this._widths.size > CACHE_LIMIT) this._widths.clear();
      width = this._measure(text, style);
      this._widths.set(key, width);
    }
    return width;
  }

  /**
   * `text`, cut short with an ellipsis if it is wider than `maxWidth`. A text
   * that cannot be shown at all — no room even for one letter and the
   * ellipsis — comes back empty rather than as a lone "…".
   */
  fit(text: string, style: TextStyle, maxWidth: number): string {
    if (maxWidth <= 0 || text === '') return '';
    if (this.width(text, style) <= maxWidth) return text;
    const key = `${style.font}|${style.spacing}|${Math.floor(maxWidth)}|${text}`;
    const known = this._fits.get(key);
    if (known !== undefined) return known;

    // The longest prefix that fits with the ellipsis after it.
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.width(text.slice(0, mid).trimEnd() + ELLIPSIS, style) <= maxWidth) low = mid;
      else high = mid - 1;
    }
    const fitted = low === 0 ? '' : text.slice(0, low).trimEnd() + ELLIPSIS;
    if (this._fits.size > CACHE_LIMIT) this._fits.clear();
    this._fits.set(key, fitted);
    return fitted;
  }

  /**
   * `text` broken at spaces into at most `maxLines` lines no wider than
   * `maxWidth`, the last cut short with an ellipsis if there is more. A word
   * too long for a line on its own is cut the same way.
   */
  wrap(text: string, style: TextStyle, maxWidth: number, maxLines: number): string[] {
    if (maxWidth <= 0 || maxLines <= 0 || text === '') return [];
    if (maxLines === 1 || this.width(text, style) <= maxWidth) return [this.fit(text, style, maxWidth)];

    const words = text.split(/\s+/).filter((word) => word !== '');
    const lines: string[] = [];
    let line = '';
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!;
      const candidate = line === '' ? word : `${line} ${word}`;
      if (this.width(candidate, style) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (lines.length === maxLines - 1) {
        // The last line takes everything that is left, and is cut to fit.
        lines.push(this.fit([line, ...words.slice(i)].filter((w) => w !== '').join(' '), style, maxWidth));
        return lines;
      }
      if (line !== '') lines.push(line);
      line = this.width(word, style) <= maxWidth ? word : this.fit(word, style, maxWidth);
    }
    if (line !== '') lines.push(line);
    return lines;
  }
}

/**
 * `text` without the characters a font draws as color pictures (📊 🔄 📍 ⚡),
 * which on a line that is otherwise trim would be the only color on it
 * (#280). Symbols that are drawn as plain glyphs (▶ ✓ ✗ ⏸) stay, without the
 * selector that would ask for the picture form.
 */
export function withoutColorEmoji(text: string): string {
  return text
    .replace(/\p{Emoji_Presentation}️?|️/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
