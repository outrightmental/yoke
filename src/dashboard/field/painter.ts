import { briefStatus, STAGES, workGlyph, type WorkSignal, type WorkStatus, type WorkView } from '../shared/work-view.js';
import { PING_MS, type Ping, type PlacedNode } from './animator.js';
import { inflate, rect, type Point, type Rect } from './geometry.js';
import { drawComet, drawGlyph, drawTrack, glyphMoves, trackMarkX, trackWidth, type TrackStyle } from './glyphs.js';
import {
  RIBBON_LINE_HEIGHT,
  type EngineNode,
  type FieldLayout,
  type HeaderNode,
  type HudSlot,
  type StratumLevel,
  type WorkNode,
} from './layout.js';
import type { FieldModel, Tether, TetherState } from './model.js';
import { rgba, type Palette, type Rgb } from './palette.js';
import { mono, sans, withoutColorEmoji, type TextFitter, type TextStyle } from './text.js';

/**
 * The painter: everything the field looks like.
 *
 * It paints in two passes, because almost nothing on the field moves almost
 * all of the time. `paintStatic` draws the whole picture — ground, glow, every
 * line of text — and is run only when the picture changes: an event arrives,
 * something is in motion, the clocks tick over. `paintDynamic` draws the few
 * things that never stop — the comets on the engines' rings, the orbit on a
 * line whose checks are running, the points travelling along a tether — and
 * says which small boxes it touched, so the next frame can put those boxes
 * back from the static picture and draw them again without repainting a
 * single letter. An open dashboard spends most of its life doing only that.
 */
type Ctx = CanvasRenderingContext2D;

/** A canvas the painter can draw on and then draw from; the browser's own, or a stand-in. */
export interface Surface {
  width: number;
  height: number;
  getContext(type: '2d'): Ctx | null;
}

/** One frame's worth of everything the painter needs. */
export interface Frame {
  layout: FieldLayout;
  model: FieldModel;
  placed: readonly PlacedNode[];
  pings: readonly Ping[];
  /** How far the content is scrolled. */
  scrollY: number;
  /** Where each inbox card is tethered from, by card id, in the field's coordinates. */
  anchors: ReadonlyMap<string, Point>;
  /** The id of the node under the pointer, and of the one with keyboard focus. */
  hover: string | null;
  focus: string | null;
  nowMs: number;
  /** The person has asked for less motion: nothing loops. */
  reducedMotion: boolean;
  /** Device pixels per CSS pixel on the canvas being painted. */
  pixelRatio: number;
  /** The label a project goes by (`repoLabels`). */
  repoLabel(repo: string): string;
}

const TAU = Math.PI * 2;
/** The side of the small picture every glow is stretched from. */
const GLOW_SPRITE = 96;
const GRAIN_SIZE = 96;

const STAGE_LABELS = STAGES.map((stage) => stage.toUpperCase());

const LEVEL_LABELS = { burning: 'BURNING', queued: 'QUEUED', waiting: 'WAITING', cold: 'COLD' } as const;
const LEVEL_NOTES = {
  burning: 'an engine is running an action on it',
  queued: 'yoke works these next',
  waiting: 'on someone else first',
  cold: 'nothing coming',
} as const;

/**
 * How bright the gray text of a line of work is, by the stratum it is in:
 * below the reactors heat is said in brightness, not in color (#286). Each is
 * an alpha over the ground — the title of `--trim-bright`, its status of
 * `--trim-dim`, its number of the work's gray — set so that on the darkest
 * ground a title and a number keep 4.5:1 or more at every level, and a
 * neutral status 3:1 or more (design/DASHBOARD.md, "Colour").
 */
const INK: Readonly<Record<StratumLevel, { title: number; meta: number; number: number }>> = {
  queued: { title: 0.9, meta: 0.78, number: 1 },
  waiting: { title: 0.7, meta: 0.7, number: 0.95 },
  cold: { title: 0.54, meta: 0.66, number: 0.9 },
};

/**
 * Below the reactors, every other line of a stratum lies on a band: the
 * ground lifted by this much of `--trim-bright`. Two values of gray, ground
 * and band, take over from the hue the work of telling one line from the next
 * (#286). Enough to see — about 1.06:1 against the ground — and little enough
 * that every word on a band keeps its contrast floor, the darkest signal
 * (red, 4.7:1) included.
 */
const BAND_ALPHA = 0.035;
/** How far a band reaches past its line on either side: as far as the wash
 *  behind a line under the pointer, so the two line up. */
const BAND_PAD_X = 8;
const BAND_RADIUS = 4;
/** A signal is drawn at full strength in every stratum: an alarm does not cool. */
const SIGNAL_ALPHA = 1;

/** The type a line of work is set in, by stratum. */
const ROW_TYPE: Readonly<Record<StratumLevel, { number: TextStyle; title: TextStyle; meta: TextStyle }>> = {
  queued: { number: mono(600, 12.5), title: sans(500, 14), meta: sans(400, 11.5) },
  waiting: { number: mono(600, 12), title: sans(500, 13.5), meta: sans(400, 11.5) },
  cold: { number: mono(600, 11), title: sans(400, 12), meta: sans(400, 10.5) },
};

/** Where a line of work's number starts: after its track. */
const ROW_TEXT_X = 46;
const ROW_TRACK: Pick<TrackStyle, 'pitch' | 'dot'> = { pitch: 8, dot: 2.6 };
/** The room a line keeps at its right end for its glyph. */
const GLYPH_SLOT = 24;

/** How a reactor is set, by density. Every y is the middle of its line, from the reactor's top. */
const REACTOR_ROOMY = { verbY: 23, titleY: 49, titleLeading: 23, footY: 100, number: mono(600, 15.5), title: sans(600, 17.5), track: { pitch: 17, dot: 3.4 } };
const REACTOR_MEDIUM = { verbY: 17, titleY: 40, titleLeading: 20, footY: 83, number: mono(600, 14), title: sans(600, 16), track: { pitch: 15, dot: 3 } };
const REACTOR_COMPACT = { verbY: 14, titleY: 36, titleLeading: 18, footY: 58, number: mono(600, 13.5), title: sans(600, 15), track: { pitch: 13, dot: 2.7 } };
const REACTOR_TYPE: ReadonlyArray<{
  verbY: number; titleY: number; titleLeading: number; footY: number;
  number: TextStyle; title: TextStyle; track: Pick<TrackStyle, 'pitch' | 'dot'>;
}> = [REACTOR_ROOMY, REACTOR_MEDIUM, REACTOR_MEDIUM, REACTOR_COMPACT];

const VERB_STYLE = mono(600, 11, 1.6);
const MODEL_STYLE = mono(400, 10.5, 0.2);
const REPO_STYLE = mono(400, 10.5, 0.2);
const STAGE_STYLE = mono(600, 9.5, 1.4);
const FOOT_STYLE = sans(400, 11.5);
const BENCH_STYLE = mono(400, 11);
const HEADER_STYLE = mono(600, 10.5, 2.2);
const HEADER_COUNT_STYLE = mono(600, 10.5, 0.4);
const HEADER_NOTE_STYLE = sans(400, 11);
const HUD_TITLE_STYLE = mono(700, 19, 3);
const HUD_SUB_STYLE = mono(500, 10, 2);
const HUD_LABEL_STYLE = mono(500, 9.5, 1.8);
const HUD_VALUE_STYLE = mono(700, 17);
const HUD_SMALL_VALUE_STYLE = mono(700, 14.5);
const HOLD_STYLE = mono(700, 22, 1.5);
const HOLD_REASON_STYLE = sans(400, 13);
const NOTE_STYLE = sans(400, 14);
const LEGEND_STYLE = mono(500, 8.5, 1.4);
const RIBBON_TIME_STYLE = mono(400, 10);
const RIBBON_TEXT_STYLE = mono(400, 11);
/** How much each line of the ribbon fades, newest first. */
const RIBBON_FADE = [1, 0.58, 0.36, 0.22];

/** How many seconds an engine's comet takes to go once round its ring. */
const COMET_PERIOD_S = 2.6;

export class Painter {
  private _groundCache: Surface | null = null;
  private _groundKey = '';
  private _grainTile: Surface | null = null;
  private _grainTried = false;
  /** A glow for every color that has had one, by its "r,g,b"; null where no canvas could be made. */
  private readonly _sprites = new Map<string, Surface | null>();

  constructor(
    private _palette: Palette,
    private readonly _fitter: TextFitter,
    /** Makes a canvas to paint the glow and the grain on; null where there is none to be had. */
    private readonly _makeSurface: (width: number, height: number) => Surface | null = () => null,
  ) {}

  set palette(palette: Palette) {
    this._palette = palette;
  }

  /** Let go of the layers kept between frames, as when the canvas has lost them. */
  reset(): void {
    this._groundCache = null;
    this._groundKey = '';
    this._sprites.clear();
  }

  // ── Small helpers ──────────────────────────────────────────────────────────

  private _text(
    ctx: Ctx,
    text: string,
    x: number,
    y: number,
    style: TextStyle,
    fill: string,
    align: CanvasTextAlign = 'left',
  ): void {
    if (text === '') return;
    ctx.font = style.font;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${style.spacing}px`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  /** The status token a signal is drawn in (#286). */
  private _signalColor(signal: WorkSignal): Rgb {
    const p = this._palette;
    switch (signal) {
      case 'error': return p.red;
      case 'blocked': return p.orange;
      case 'review': return p.yellow;
      case 'approved': return p.green;
    }
  }

  /** The ink of a line's status: its signal at full strength, or gray at the
   *  stratum's brightness — a little brighter for something in progress. */
  private _statusInk(status: WorkStatus, alpha: number): string {
    const p = this._palette;
    if (status.signal) return rgba(this._signalColor(status.signal), SIGNAL_ALPHA);
    return status.tone === 'progress' ? rgba(p.trimBright, alpha * 0.86) : rgba(p.trimDim, alpha);
  }

  /** The ink of the glyph at the end of a line: its signal, or its gray. */
  private _glyphInk(work: WorkView): string {
    const signal = work.status.signal;
    if (!signal) return work.color.rgb;
    const [r, g, b] = this._signalColor(signal);
    return `${r},${g},${b}`;
  }

  /** The top-left of the scrolling content on the field. */
  private _origin(frame: Frame): Point {
    return { x: frame.layout.scroll.x, y: frame.layout.scroll.y - frame.scrollY };
  }

  // ── The static picture ─────────────────────────────────────────────────────

  paintStatic(ctx: Ctx, frame: Frame): void {
    const { layout } = frame;
    const { width, height } = layout.viewport;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this._ground(ctx, frame, width, height);

    const origin = this._origin(frame);
    ctx.save();
    ctx.beginPath();
    // A little wider than the content, for the highlight behind a line.
    ctx.rect(0, layout.scroll.y, layout.scroll.x + layout.scroll.w + 14, layout.scroll.h);
    ctx.clip();
    ctx.translate(origin.x, origin.y);
    this._bands(ctx, frame);
    for (const placed of frame.placed) this._highlight(ctx, frame, placed);
    for (const placed of frame.placed) {
      if (placed.alpha <= 0.003) continue;
      const { node } = placed;
      // Nothing off the top or the bottom of the window is worth a stroke.
      const top = placed.y + origin.y;
      if (top > layout.scroll.y + layout.scroll.h + 40 || top + node.rect.h < layout.scroll.y - 40) continue;
      ctx.globalAlpha = placed.alpha;
      switch (node.kind) {
        case 'header': this._header(ctx, frame, node, placed.x, placed.y); break;
        case 'hold': this._hold(ctx, frame, placed.x, placed.y, node.rect); break;
        case 'note':
          this._text(ctx, node.text, placed.x, placed.y + node.rect.h / 2, NOTE_STYLE, rgba(this._palette.trimDim, 0.8));
          break;
        case 'work':
          if (node.mode === 'reactor') this._reactorText(ctx, frame, node, placed.x, placed.y);
          else this._row(ctx, frame, node, placed.x, placed.y);
          break;
        case 'engine':
          if (placed.ring) this._engine(ctx, node, placed);
          break;
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    this._scrollFades(ctx, frame);
    this._hud(ctx, frame);
    this._ribbon(ctx, frame);
    this._tethers(ctx, frame);
  }

  /**
   * The ground the field is painted on, and the light on it.
   *
   * Filling the whole window is the dearest thing the painter does — far more
   * than every word on the field put together — so the ground itself is
   * painted once, onto a layer of its own, and copied from there until the
   * window changes size. Only the light is new each time, and that is a few
   * small soft sprites stretched over the spots that glow, not a pass over
   * every pixel.
   */
  private _ground(ctx: Ctx, frame: Frame, width: number, height: number): void {
    const layer = this._groundLayer(frame.pixelRatio, width, height);
    if (layer) {
      ctx.drawImage(layer as unknown as CanvasImageSource, 0, 0, layer.width, layer.height, 0, 0, width, height);
    } else {
      this._paintGround(ctx, width, height);
    }
    this._glow(ctx, frame);
  }

  private _groundLayer(ratio: number, width: number, height: number): Surface | null {
    const pw = Math.max(1, Math.round(width * ratio));
    const ph = Math.max(1, Math.round(height * ratio));
    const key = `${pw}x${ph}|${this._palette.bg.join()}|${this._palette.bgAlt.join()}`;
    if (this._groundCache && this._groundKey === key) return this._groundCache;
    const layer = this._makeSurface(pw, ph);
    const layerCtx = layer?.getContext('2d');
    if (!layer || !layerCtx) return null;
    layerCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this._paintGround(layerCtx, width, height);
    this._groundCache = layer;
    this._groundKey = key;
    return layer;
  }

  private _paintGround(ctx: Ctx, width: number, height: number): void {
    const p = this._palette;
    ctx.fillStyle = rgba(p.bg, 1);
    ctx.fillRect(0, 0, width, height);
    // Heat rises: the ground is a shade lighter where the burning is.
    const lift = ctx.createLinearGradient(0, 0, 0, height * 0.7);
    lift.addColorStop(0, rgba(p.bgAlt, 0.7));
    lift.addColorStop(1, rgba(p.bgAlt, 0));
    ctx.fillStyle = lift;
    ctx.fillRect(0, 0, width, height * 0.7);
    // A little noise, so that long gradient does not band.
    const grain = this._grainPattern(ctx);
    if (grain) {
      ctx.fillStyle = grain;
      ctx.fillRect(0, 0, width, height);
    }
  }

  private _grainPattern(ctx: Ctx): CanvasPattern | null {
    if (!this._grainTried) {
      this._grainTried = true;
      const tile = this._makeSurface(GRAIN_SIZE, GRAIN_SIZE);
      const tileCtx = tile?.getContext('2d');
      if (tile && tileCtx && typeof tileCtx.createImageData === 'function') {
        const image = tileCtx.createImageData(GRAIN_SIZE, GRAIN_SIZE);
        // A fixed sequence, so the grain is the same on every load and in every screenshot.
        let seed = 0x2545f491;
        for (let i = 0; i < image.data.length; i += 4) {
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          const value = (seed >>> 0) & 0xff;
          image.data[i] = value;
          image.data[i + 1] = value;
          image.data[i + 2] = value;
          image.data[i + 3] = 9;
        }
        tileCtx.putImageData(image, 0, 0);
        this._grainTile = tile;
      }
    }
    return this._grainTile ? ctx.createPattern(this._grainTile as unknown as CanvasImageSource, 'repeat') : null;
  }

  /**
   * A soft round light in `color`, to be stretched to whatever size is wanted.
   * Small on purpose: a glow has no detail to lose, and stretching a small
   * picture is how it gets its softness for nothing.
   */
  private _glowSprite(color: string): Surface | null {
    const known = this._sprites.get(color);
    if (known !== undefined) return known;
    if (this._sprites.size > 64) this._sprites.clear();
    const sprite = this._makeSurface(GLOW_SPRITE, GLOW_SPRITE);
    const spriteCtx = sprite?.getContext('2d');
    if (!sprite || !spriteCtx) {
      this._sprites.set(color, null);
      return null;
    }
    const half = GLOW_SPRITE / 2;
    const gradient = spriteCtx.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, rgba(color, 1));
    gradient.addColorStop(0.45, rgba(color, 0.36));
    gradient.addColorStop(1, rgba(color, 0));
    spriteCtx.fillStyle = gradient;
    spriteCtx.fillRect(0, 0, GLOW_SPRITE, GLOW_SPRITE);
    this._sprites.set(color, sprite);
    return sprite;
  }

  /** The light the hot things on the field throw onto the ground around them. */
  private _glow(ctx: Ctx, frame: Frame): void {
    const p = this._palette;
    const origin = this._origin(frame);
    const triplet = (color: Rgb): string => `${color[0]},${color[1]},${color[2]}`;
    const sources: Array<{ x: number; y: number; r: number; color: string; alpha: number }> = [];

    for (const placed of frame.placed) {
      const { node } = placed;
      if (node.kind === 'engine' && node.mode === 'reactor' && placed.ring) {
        sources.push({
          x: placed.ring.cx + origin.x,
          y: placed.ring.cy + origin.y,
          r: placed.ring.r * 3.4,
          color: node.engine.color.rgb,
          alpha: 0.13 * placed.alpha,
        });
      } else if (node.kind === 'hold') {
        sources.push({
          x: placed.x + origin.x + Math.min(360, node.rect.w * 0.3),
          y: placed.y + origin.y + node.rect.h / 2,
          r: 460,
          color: triplet(p.orange),
          alpha: 0.13 * placed.alpha,
        });
      }
    }
    for (const tether of frame.model.tethers) {
      const anchor = frame.anchors.get(tether.cardId);
      if (!anchor || (tether.state !== 'sent' && tether.state !== 'working' && tether.state !== 'done')) continue;
      sources.push({ x: anchor.x, y: anchor.y, r: 150, color: triplet(p.green), alpha: 0.1 });
    }
    if (sources.length === 0) return;

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    // Light adds to light: two glows that overlap are brighter where they do.
    ctx.globalCompositeOperation = 'lighter';
    for (const source of sources) {
      const sprite = this._glowSprite(source.color);
      if (!sprite || source.alpha <= 0.002) continue;
      ctx.globalAlpha = source.alpha;
      ctx.drawImage(sprite as unknown as CanvasImageSource, source.x - source.r, source.y - source.r, source.r * 2, source.r * 2);
    }
    ctx.restore();
  }

  /**
   * The bands behind every other line of work below the reactors (#286),
   * drawn where their stratum's heading is, so that they move only when the
   * stratum does and the lines slide past them.
   */
  private _bands(ctx: Ctx, frame: Frame): void {
    const { layout } = frame;
    const originY = this._origin(frame).y;
    ctx.fillStyle = rgba(this._palette.trimBright, BAND_ALPHA);
    for (const placed of frame.placed) {
      const { node } = placed;
      if (node.kind !== 'header' || node.bands.length === 0 || placed.alpha <= 0.003) continue;
      const dx = placed.x - node.rect.x;
      const dy = placed.y - node.rect.y;
      ctx.globalAlpha = placed.alpha;
      for (const band of node.bands) {
        const top = band.y + dy + originY;
        if (top > layout.scroll.y + layout.scroll.h || top + band.h < layout.scroll.y) continue;
        ctx.beginPath();
        ctx.roundRect(band.x + dx - BAND_PAD_X, band.y + dy, band.w + BAND_PAD_X * 2, band.h, BAND_RADIUS);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** The wash behind a node that is selected, focused, or under the pointer. */
  private _highlight(ctx: Ctx, frame: Frame, placed: PlacedNode): void {
    const { node } = placed;
    if (node.kind !== 'work' && node.kind !== 'engine') return;
    const selection = frame.model.selection;
    const selected =
      (node.kind === 'work' && selection?.kind === 'work' && selection.key === node.work.key) ||
      (node.kind === 'engine' && selection?.kind === 'engine' && selection.index === node.engine.index);
    const focused = frame.focus === node.id;
    const hovered = frame.hover === node.id;
    if (!selected && !focused && !hovered) return;

    const p = this._palette;
    const box = inflate(rect(placed.x, placed.y, node.rect.w, node.rect.h), node.kind === 'engine' && node.mode === 'reactor' ? 6 : 0);
    const padX = node.kind === 'work' ? 8 : 4;
    ctx.globalAlpha = placed.alpha;
    ctx.beginPath();
    ctx.roundRect(box.x - padX, box.y + 1, box.w + padX * 2, box.h - 2, Math.min(12, box.h / 2));
    ctx.fillStyle = rgba(p.trimBright, selected ? 0.075 : 0.04);
    ctx.fill();
    if (selected || focused) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(p.trimBright, focused ? 0.5 : 0.2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private _header(ctx: Ctx, frame: Frame, node: HeaderNode, x: number, y: number): void {
    const p = this._palette;
    const { vitals, dark } = frame.model;
    const cy = y + node.rect.h - 12;
    const label = LEVEL_LABELS[node.level];
    this._text(ctx, label, x, cy, HEADER_STYLE, rgba(p.trimBright, 0.86));
    let cursor = x + this._fitter.width(label, HEADER_STYLE) + 8;

    const count = node.total !== null ? `${node.count}/${node.total}` : String(node.count);
    this._text(ctx, count, cursor, cy, HEADER_COUNT_STYLE, rgba(p.trim, 0.9));
    cursor += this._fitter.width(count, HEADER_COUNT_STYLE) + 12;

    let note: string = LEVEL_NOTES[node.level];
    if (node.level === 'burning') {
      if (vitals.phase === 'shut-down') note = 'yoke has shut down';
      else if (vitals.phase === 'shutting-down') note = 'finishing what is in flight, then stopping';
      else if (vitals.hold) note = 'every engine is parked';
      else if (node.count === 0) note = 'no engine is running an action';
      else note = node.count === 1 ? 'an engine is running an action' : 'engines are running actions';
    } else if (dark && node.level === 'cold') {
      note = 'nothing coming — yoke is shutting down';
    }
    const room = x + node.rect.w - cursor - 40;
    const fitted = this._fitter.fit(note, HEADER_NOTE_STYLE, room);
    this._text(ctx, fitted, cursor, cy, HEADER_NOTE_STYLE, rgba(p.trimDim, 0.78));
    cursor += this._fitter.width(fitted, HEADER_NOTE_STYLE) + 14;

    const end = x + node.rect.w;
    if (end - cursor > 12) {
      const rule = ctx.createLinearGradient(cursor, 0, end, 0);
      rule.addColorStop(0, rgba(p.trim, 0.26));
      rule.addColorStop(1, rgba(p.trim, 0));
      ctx.fillStyle = rule;
      ctx.fillRect(cursor, Math.round(cy), end - cursor, 1);
    }
  }

  private _hold(ctx: Ctx, frame: Frame, x: number, y: number, box: Rect): void {
    const hold = frame.model.vitals.hold;
    if (!hold) return;
    const p = this._palette;
    ctx.fillStyle = rgba(p.orange, 0.9);
    ctx.fillRect(x, y + 14, 3, box.h - 28);
    // The pause mark, drawn rather than typed so no font turns it into a picture.
    ctx.fillRect(x + 22, y + 26, 7, 26);
    ctx.fillRect(x + 36, y + 26, 7, 26);

    const cy = y + 39;
    let cursor = x + 62;
    const part = (text: string, color: string): void => {
      this._text(ctx, text, cursor, cy, HOLD_STYLE, color);
      cursor += this._fitter.width(text, HOLD_STYLE) + 12;
    };
    part('WAITING', rgba(p.orange, 1));
    part(hold.remaining.toUpperCase(), rgba(p.yellow, 1));
    part('UNTIL', rgba(p.orange, 1));
    part(hold.deadline.toUpperCase(), rgba(p.yellow, 1));
    const reason = this._fitter.fit(
      `for ${hold.reason} · no work is planned or started until then`,
      HOLD_REASON_STYLE,
      box.w - 70,
    );
    this._text(ctx, reason, x + 62, y + 70, HOLD_REASON_STYLE, rgba(p.trimBright, 0.72));
  }

  /**
   * A line of work in one of the strata below the reactors (#286): gray, on
   * the ground or on a band; its issue's hue only in the mark on its track
   * that says how far it has got; and a status signal, if it has one, in its
   * status and the glyph at its end.
   */
  private _row(ctx: Ctx, frame: Frame, node: WorkNode, x: number, y: number): void {
    const p = this._palette;
    const { work } = node;
    const level = node.level as StratumLevel;
    const ink = INK[level];
    const type = ROW_TYPE[level];
    const { w, h } = node.rect;
    const color = work.color.rgb;
    const two = node.lines === 2;
    const cy = two ? y + 15 : y + h / 2;

    drawTrack(ctx, x + 2, cy, work.stage, STAGES.length, { ...ROW_TRACK, color, mark: work.hue.rgb, trim: p.trim, alpha: 1 });

    const numberX = x + ROW_TEXT_X;
    const number = work.number !== null ? `#${work.number}` : '';
    this._text(ctx, number, numberX, cy, type.number, rgba(color, ink.number));
    const titleX = numberX + this._fitter.width(number, type.number) + 9;

    const glyph = workGlyph(work);
    const right = x + w - (glyph ? GLYPH_SLOT : 2);
    // A glyph that moves is drawn by the other pass — unless the work has gone
    // dark, when it stays, frozen as it stood (#268).
    if (glyph && !glyphAnimates(work, glyph)) {
      drawGlyph(ctx, glyph, x + w - 10, y + h / 2, 0, { color: this._glyphInk(work), alpha: 1 });
    }

    const repo = frame.model.multiProject && work.repo ? frame.repoLabel(work.repo) : '';
    const pr = work.pair.pr && work.pair.issue ? `PR #${work.pair.pr.number}` : '';
    const dim = rgba(p.trimDim, ink.meta);

    if (two) {
      this._text(ctx, this._fitter.fit(work.title, type.title, right - titleX), titleX, cy, type.title, rgba(p.trimBright, ink.title));
      // Second line: which project, which PR, and where it stands.
      let cursor = numberX;
      const cy2 = y + 33;
      for (const part of [repo, pr]) {
        if (part === '') continue;
        this._text(ctx, part, cursor, cy2, type.meta, dim);
        cursor += this._fitter.width(part, type.meta);
        this._text(ctx, ' · ', cursor, cy2, type.meta, rgba(p.trimDim, ink.meta * 0.6));
        cursor += this._fitter.width(' · ', type.meta);
      }
      this._text(ctx, this._fitter.fit(work.status.text, type.meta, right - cursor), cursor, cy2, type.meta, this._statusInk(work.status, ink.meta));
      return;
    }

    // One line: the status is set against the right-hand end, with the project
    // before it, and the title has whatever is left.
    // In a word or two: the sentence is on the inbox card, and a tap away.
    const statusRoom = Math.max(60, (w - ROW_TEXT_X) * 0.36);
    const status = this._fitter.fit(briefStatus(work.status), type.meta, statusRoom);
    const statusW = this._fitter.width(status, type.meta);
    this._text(ctx, status, right, cy, type.meta, this._statusInk(work.status, ink.meta), 'right');
    let titleEnd = status === '' ? right : right - statusW - 14;
    if (repo !== '' && w >= 400) {
      this._text(ctx, repo, titleEnd, cy, REPO_STYLE, rgba(p.trimDim, ink.meta * 0.72), 'right');
      titleEnd -= this._fitter.width(repo, REPO_STYLE) + 14;
    }
    this._text(ctx, this._fitter.fit(work.title, type.title, titleEnd - titleX), titleX, cy, type.title, rgba(p.trimBright, ink.title));
  }

  /** The words of a reactor, to the right of its engine's ring. */
  private _reactorText(ctx: Ctx, frame: Frame, node: WorkNode, x: number, y: number): void {
    const p = this._palette;
    const { work, engine } = node;
    const type = REACTOR_TYPE[frame.layout.density] ?? REACTOR_TYPE[0]!;
    const { w } = node.rect;
    // The burning stratum is where the hue is (#286): a reactor keeps it for
    // as long as it is on the field, a dark one included. Its engine is still
    // burning, but its work has gone cold (#268), so its title dims.
    const color = work.hue.rgb;
    const bright = work.dark ? 0.6 : 1;

    // The action, and the model running it.
    const verb = (engine?.verb ?? work.status.text).toUpperCase();
    const hot = engine ? engine.color.rgb : color;
    const repo = frame.model.multiProject && work.repo ? frame.repoLabel(work.repo) : '';
    const repoW = repo ? this._fitter.width(repo, REPO_STYLE) + 14 : 0;
    this._text(ctx, repo, x + w, y + type.verbY, REPO_STYLE, rgba(p.trimDim, 0.8), 'right');
    const verbFit = this._fitter.fit(verb, VERB_STYLE, w - repoW);
    this._text(ctx, verbFit, x, y + type.verbY, VERB_STYLE, rgba(hot, 1));
    const verbW = this._fitter.width(verbFit, VERB_STYLE);
    if (engine?.model) {
      this._text(
        ctx,
        this._fitter.fit(`· ${engine.model}`, MODEL_STYLE, w - repoW - verbW - 10),
        x + verbW + 10, y + type.verbY, MODEL_STYLE, rgba(p.trimDim, 0.9),
      );
    }

    // Its number, and its title on a hanging indent beside it.
    const number = work.number !== null ? `#${work.number}` : '';
    this._text(ctx, number, x, y + type.titleY, type.number, rgba(color, 1));
    const indent = number ? this._fitter.width(number, type.number) + 10 : 0;
    const lines = this._fitter.wrap(work.title, type.title, w - indent, node.lines);
    lines.forEach((line, i) => {
      this._text(ctx, line, x + indent, y + type.titleY + i * type.titleLeading, type.title, rgba(p.trimBright, 0.97 * bright));
    });

    // Where it is on the lifecycle, and what its PR and checks are.
    const track = { ...type.track, color, trim: p.trim, alpha: 1 };
    drawTrack(ctx, x + 1, y + type.footY, work.stage, STAGES.length, track);
    let cursor = x + 1 + trackWidth(STAGES.length, type.track) + 12;
    const stage = STAGE_LABELS[work.stage] ?? '';
    this._text(ctx, stage, cursor, y + type.footY, STAGE_STYLE, rgba(color, 0.95));
    cursor += this._fitter.width(stage, STAGE_STYLE) + 12;
    const facts: string[] = [];
    if (work.pair.pr) facts.push(`PR #${work.pair.pr.number}`);
    if (work.checks === 'failure') facts.push('checks failing');
    else if (work.checks === 'pending') facts.push('checks running');
    else if (work.checks === 'success') facts.push('checks passing');
    if (work.approval.approved) facts.push('approved');
    this._text(
      ctx,
      this._fitter.fit(facts.join(' · '), FOOT_STYLE, x + w - cursor),
      cursor, y + type.footY, FOOT_STYLE,
      work.checks === 'failure' ? rgba(p.red, SIGNAL_ALPHA) : rgba(p.trimDim, 0.86),
    );
  }

  /** An engine's ring, except for what turns on it: burning beside its work, or on the bench. */
  private _engine(ctx: Ctx, node: EngineNode, placed: PlacedNode): void {
    const p = this._palette;
    const { engine } = node;
    const ring = placed.ring!;

    if (node.mode === 'reactor') {
      const color = engine.color.rgb;
      const stroke = Math.max(2, ring.r * 0.075);
      const fill = ctx.createRadialGradient(ring.cx, ring.cy, ring.r * 0.1, ring.cx, ring.cy, ring.r);
      fill.addColorStop(0, rgba(color, 0.2));
      fill.addColorStop(1, rgba(color, 0.03));
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(ring.cx, ring.cy, ring.r - stroke, 0, TAU);
      ctx.fill();
      ctx.lineWidth = stroke;
      ctx.strokeStyle = rgba(color, 0.26);
      ctx.beginPath();
      ctx.arc(ring.cx, ring.cy, ring.r - stroke / 2, 0, TAU);
      ctx.stroke();

      const size = Math.max(9.5, Math.min(14.5, ring.r * 0.36));
      const labelled = ring.r >= 28;
      this._text(ctx, engine.clock, ring.cx, ring.cy - (labelled ? ring.r * 0.1 : 0), mono(600, size), rgba(p.trimBright, 1), 'center');
      if (labelled) {
        this._text(ctx, `ENGINE ${engine.index + 1}`, ring.cx, ring.cy + ring.r * 0.34, mono(500, 7.5, 1), rgba(p.trimDim, 0.95), 'center');
      }
      return;
    }

    // On the bench: a small ring with the engine's number in it, and a few words.
    const tone: Rgb | string =
      engine.status === 'error' ? p.red
        : engine.status === 'shutdown' ? p.orange
          : engine.hasWork ? engine.color.rgb : p.trimDim;
    const strong = engine.status === 'error' || engine.status === 'shutdown' || engine.hasWork;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(tone, strong ? 0.85 : 0.5);
    ctx.beginPath();
    ctx.arc(ring.cx, ring.cy, ring.r, 0, TAU);
    ctx.stroke();
    this._text(
      ctx, String(engine.index + 1), ring.cx, ring.cy + 0.5,
      mono(600, Math.max(8, Math.min(11, ring.r * 0.95))), rgba(tone, strong ? 0.95 : 0.8), 'center',
    );
    const labelX = ring.cx + ring.r + 9;
    const room = node.rect.w - (node.ring.cx - node.rect.x) - node.ring.r - 9;
    this._text(
      ctx, this._fitter.fit(engine.brief, BENCH_STYLE, room), labelX, ring.cy,
      BENCH_STYLE, rgba(tone, strong ? 0.92 : 0.84),
    );
  }

  /** The content fading out where it runs under the instruments or the ribbon. */
  private _scrollFades(ctx: Ctx, frame: Frame): void {
    const { layout } = frame;
    const over = layout.contentHeight - layout.scroll.h;
    if (over <= 1) return;
    const p = this._palette;
    const x = 0;
    const w = layout.scroll.x + layout.scroll.w + 14;
    if (frame.scrollY > 1) {
      const top = ctx.createLinearGradient(0, layout.scroll.y, 0, layout.scroll.y + 22);
      top.addColorStop(0, rgba(p.bg, 0.96));
      top.addColorStop(1, rgba(p.bg, 0));
      ctx.fillStyle = top;
      ctx.fillRect(x, layout.scroll.y, w, 22);
    }
    if (frame.scrollY < over - 1) {
      const bottom = layout.scroll.y + layout.scroll.h;
      const fade = ctx.createLinearGradient(0, bottom - 26, 0, bottom);
      fade.addColorStop(0, rgba(p.bg, 0));
      fade.addColorStop(1, rgba(p.bg, 0.96));
      ctx.fillStyle = fade;
      ctx.fillRect(x, bottom - 26, w, 26);
    }
  }

  /** The instruments along the top: the title, and the run's vitals. */
  private _hud(ctx: Ctx, frame: Frame): void {
    const p = this._palette;
    const { vitals } = frame.model;
    const { hud } = frame.layout;

    const title = this._fitter.fit(vitals.title.toUpperCase(), HUD_TITLE_STYLE, hud.title.w);
    const focused = frame.hover === 'title' || frame.focus === 'title';
    this._text(ctx, title, hud.title.x, 26, HUD_TITLE_STYLE, rgba(p.trimBright, focused ? 1 : 0.94));
    const sub = ['YOKE', vitals.subtitle.toUpperCase()].filter((part) => part !== '').join(' · ');
    this._text(ctx, this._fitter.fit(sub, HUD_SUB_STYLE, hud.title.w), hud.title.x, 47, HUD_SUB_STYLE, rgba(p.trimDim, 0.9));

    for (const slot of hud.slots) this._hudSlot(ctx, frame, slot);
  }

  private _hudSlot(ctx: Ctx, frame: Frame, slot: HudSlot): void {
    const p = this._palette;
    const { vitals } = frame.model;
    const x = slot.rect.x;
    const labelY = 22;
    const valueY = 44;
    const label = (text: string, at: number, color = rgba(p.trimDim, 0.92)): void =>
      this._text(ctx, text, at, labelY, HUD_LABEL_STYLE, color);

    switch (slot.kind) {
      case 'cycle':
        label('CYCLE', x);
        this._text(ctx, String(vitals.cycle), x, valueY, HUD_VALUE_STYLE, rgba(p.trimBright, 1));
        return;
      case 'countdown': {
        const countdown = vitals.countdown;
        if (!countdown) return;
        // Yellow only while a hold parks the pool; the time to the next cycle is trim.
        label(countdown.label, x, countdown.held ? rgba(p.yellow, 1) : undefined);
        this._text(ctx, countdown.value, x, valueY, HUD_VALUE_STYLE, countdown.held ? rgba(p.yellow, 1) : rgba(p.trimBright, 1));
        return;
      }
      case 'state': {
        const down = vitals.phase !== 'running';
        const text = vitals.phase === 'shut-down' ? 'SHUT DOWN'
          : vitals.phase === 'shutting-down' ? 'STOPPING'
            : vitals.connection === 'disconnected' ? 'LOST' : 'CONNECTING';
        const color = down ? p.orange : vitals.connection === 'disconnected' ? p.red : p.trimDim;
        label(down ? 'YOKE' : 'CONNECTION', x, rgba(color, 0.95));
        this._text(ctx, text, x, valueY, HUD_SMALL_VALUE_STYLE, rgba(color, 1));
        return;
      }
      case 'usage': {
        const gauge = vitals.usage;
        const tone: Rgb = gauge.tone === 'critical' ? p.red : gauge.tone === 'warn' ? p.yellow : p.trimBright;
        const alpha = gauge.tone === 'unknown' ? 0.36 : 1;
        // The gauge: a ring that fills as the usage window is used up.
        const cx = x + 17;
        const cy = 33;
        const r = 14;
        ctx.lineCap = 'butt';
        ctx.lineWidth = 3;
        ctx.strokeStyle = rgba(p.trim, 0.2);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, TAU);
        ctx.stroke();
        if (gauge.fillPercent > 0) {
          ctx.strokeStyle = rgba(tone, alpha);
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, gauge.fillPercent / 100));
          ctx.stroke();
        }
        const selected = frame.model.selection?.kind === 'usage' || frame.hover === 'usage';
        label(gauge.label, x + 42, selected ? rgba(p.trimBright, 0.95) : undefined);
        this._text(ctx, gauge.percentText, x + 42, valueY, HUD_VALUE_STYLE, rgba(tone, alpha));
        label('RESETS IN', x + 122);
        this._text(ctx, gauge.resetText, x + 122, valueY, HUD_SMALL_VALUE_STYLE, rgba(tone, alpha));
        return;
      }
    }
  }

  /** The last lines of the event log, along the bottom. */
  private _ribbon(ctx: Ctx, frame: Frame): void {
    const p = this._palette;
    const { rect: box, lines } = frame.layout.ribbon;
    let ruleEnd = box.x + box.w;
    // A key to the five marks every piece of work carries, at the end of the rule.
    if (box.w >= 720) {
      const key = STAGE_LABELS.join(' · ');
      const keyW = this._fitter.width(key, LEGEND_STYLE);
      const trackW = trackWidth(STAGES.length, ROW_TRACK);
      const keyX = box.x + box.w - keyW;
      this._text(ctx, key, keyX, box.y + 4.5, LEGEND_STYLE, rgba(p.trimDim, 0.72));
      drawTrack(ctx, keyX - trackW - 10, box.y + 4.5, STAGES.length - 1, STAGES.length, {
        ...ROW_TRACK, color: `${p.trimDim[0]},${p.trimDim[1]},${p.trimDim[2]}`, trim: p.trim, alpha: 0.8,
      });
      ruleEnd = keyX - trackW - 24;
    }
    const rule = ctx.createLinearGradient(box.x, 0, ruleEnd, 0);
    rule.addColorStop(0, rgba(p.trim, 0.22));
    rule.addColorStop(1, rgba(p.trim, 0.04));
    ctx.fillStyle = rule;
    ctx.fillRect(box.x, box.y + 4, ruleEnd - box.x, 1);

    const shown = frame.model.ribbon.slice(-lines);
    const hovered = frame.hover === 'ribbon';
    shown.forEach((line, i) => {
      const age = shown.length - 1 - i;
      const fade = (RIBBON_FADE[age] ?? 0.2) * (hovered ? 1.25 : 1);
      const cy = box.y + 12 + i * RIBBON_LINE_HEIGHT + RIBBON_LINE_HEIGHT / 2;
      this._text(ctx, line.time, box.x, cy, RIBBON_TIME_STYLE, rgba(p.trimDim, 0.75 * fade));
      let cursor = box.x + this._fitter.width(line.time, RIBBON_TIME_STYLE) + 12;
      if (line.repo) {
        const repo = frame.repoLabel(line.repo);
        this._text(ctx, repo, cursor, cy, RIBBON_TIME_STYLE, rgba(p.trimDim, 0.75 * fade));
        cursor += this._fitter.width(repo, RIBBON_TIME_STYLE) + 12;
      }
      // An engine's line is its work's color; an outcome is a status color;
      // everything else is trim, with no picture-emoji to bring a color in.
      const plain = !line.color && line.level !== 'error' && line.level !== 'success' && line.level !== 'warning';
      const fill = line.color
        ? rgba(hexToTriplet(line.color), fade)
        : line.level === 'error' ? rgba(p.red, fade)
          : line.level === 'success' ? rgba(p.green, fade)
            : line.level === 'warning' ? rgba(p.yellow, fade)
              : rgba(p.trim, 0.8 * fade);
      const text = plain ? withoutColorEmoji(line.text) : line.text;
      this._text(ctx, this._fitter.fit(text, RIBBON_TEXT_STYLE, box.x + box.w - cursor), cursor, cy, RIBBON_TEXT_STYLE, fill);
    });
  }

  // ── Tethers ────────────────────────────────────────────────────────────────

  /**
   * Every tether's route, from the end of its work's line to its inbox card.
   *
   * A tether never crosses text. It leaves along the rule under its line of
   * work, runs out to a gutter between the field and the inbox, turns up or
   * down the gutter to the height of its card, and goes in. Each takes its own
   * lane in the gutter, like the wires of a loom, with the highest line of
   * work innermost — the order that keeps one tether's run-out from crossing
   * another's rise.
   */
  private _tetherRoutes(frame: Frame): TetherRoute[] {
    const { layout } = frame;
    const origin = this._origin(frame);
    const top = layout.scroll.y + 4;
    const bottom = layout.scroll.y + layout.scroll.h - 4;
    const fieldRight = layout.scroll.x + layout.scroll.w;

    const leaving: Array<{ tether: Tether; start: Point; end: Point; alpha: number; work: WorkView }> = [];
    for (const tether of frame.model.tethers) {
      const anchor = frame.anchors.get(tether.cardId);
      if (!anchor) continue;
      const placed = frame.placed.find((candidate) => candidate.node.id === `work:${tether.workKey}`);
      if (!placed || placed.node.kind !== 'work' || placed.alpha <= 0.01) continue;
      const node = placed.node;
      const rawY = placed.y + origin.y + node.rect.h - (node.mode === 'reactor' ? 8 : 0.5);
      // A line scrolled out of the window still has a card: its tether leaves
      // from the edge it went past, fainter.
      const y = Math.max(top, Math.min(bottom, rawY));
      leaving.push({
        tether,
        start: { x: placed.x + origin.x + node.rect.w + 4, y },
        end: anchor,
        alpha: placed.alpha * (rawY === y ? 1 : 0.4),
        work: node.work,
      });
    }
    leaving.sort((a, b) => a.start.y - b.start.y || a.start.x - b.start.x);

    const room = Math.max(8, Math.min(...leaving.map((route) => route.end.x), Infinity) - fieldRight - 14);
    const pitch = Math.max(3, Math.min(6, room / Math.max(1, leaving.length)));
    return leaving.map((route, lane) => {
      const x = fieldRight + 8 + lane * pitch;
      const points = [route.start, { x, y: route.start.y }, { x, y: route.end.y }, route.end];
      let length = 0;
      for (let i = 1; i < points.length; i++) {
        length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
      }
      return { tether: route.tether, points, length, alpha: route.alpha, work: route.work };
    });
  }

  private _tetherColor(state: TetherState, work: WorkView): { color: Rgb | string; alpha: number } {
    const p = this._palette;
    switch (state) {
      case 'sent': return { color: p.green, alpha: 0.55 };
      case 'working': return { color: p.green, alpha: 0.8 };
      case 'done': return { color: p.green, alpha: 0.65 };
      case 'problem': return { color: p.coral, alpha: 0.55 };
      case 'selected': return { color: p.trimBright, alpha: 0.45 };
      // Waiting on a person: the work's own hue, the same as its card's edge
      // and the mark on its line, whatever stratum it is in (#286).
      default: return { color: work.hue.rgb, alpha: 0.6 };
    }
  }

  private _tethers(ctx: Ctx, frame: Frame): void {
    for (const route of this._tetherRoutes(frame)) {
      const { points } = route;
      const { color, alpha } = this._tetherColor(route.tether.state, route.work);
      const first = points[0]!;
      const last = points[points.length - 1]!;
      ctx.lineWidth = route.tether.state === 'working' ? 1.5 : 1;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // Faint where it leaves the work, firm where it reaches the card.
      const stroke = ctx.createLinearGradient(first.x, 0, last.x, 0);
      const gutter = last.x === first.x ? 1 : Math.max(0, Math.min(1, (points[1]!.x - 10 - first.x) / (last.x - first.x)));
      stroke.addColorStop(0, rgba(color, alpha * route.alpha * 0.16));
      stroke.addColorStop(gutter, rgba(color, alpha * route.alpha * 0.42));
      stroke.addColorStop(1, rgba(color, alpha * route.alpha));
      ctx.strokeStyle = stroke;
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < points.length - 1; i++) {
        const corner = points[i]!;
        const next = points[i + 1]!;
        const before = points[i - 1]!;
        // Corners as round as the shorter of the two runs meeting there allows.
        const radius = Math.min(
          9,
          Math.hypot(corner.x - before.x, corner.y - before.y) / 2,
          Math.hypot(next.x - corner.x, next.y - corner.y) / 2,
        );
        ctx.arcTo(corner.x, corner.y, next.x, next.y, radius);
      }
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
      ctx.fillStyle = rgba(color, alpha * route.alpha);
      ctx.beginPath();
      ctx.arc(last.x, last.y, 2.4, 0, TAU);
      ctx.fill();
    }
  }

  // ── What never stops moving ────────────────────────────────────────────────

  /**
   * Paint what moves, as it looks `t` seconds in, over the static picture.
   * Returns the boxes it painted in, in the field's coordinates: the caller
   * restores them from the static picture before the next frame.
   */
  paintDynamic(ctx: Ctx, frame: Frame, t: number): Rect[] {
    const touched: Rect[] = [];
    const { layout } = frame;
    const origin = this._origin(frame);
    const time = frame.reducedMotion ? 0 : t;
    const windowTop = layout.scroll.y;
    const windowBottom = layout.scroll.y + layout.scroll.h;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, windowTop, layout.scroll.x + layout.scroll.w + 14, layout.scroll.h);
    ctx.clip();
    for (const placed of frame.placed) {
      const { node } = placed;
      if (placed.alpha <= 0.02) continue;

      if (node.kind === 'engine' && node.mode === 'reactor' && placed.ring && node.engine.status === 'active') {
        const cx = placed.ring.cx + origin.x;
        const cy = placed.ring.cy + origin.y;
        const r = placed.ring.r;
        if (cy + r < windowTop || cy - r > windowBottom) continue;
        const stroke = Math.max(2, r * 0.075);
        // Each engine a little out of step with the last, so they never turn as one.
        const angle = (time / COMET_PERIOD_S + node.engine.index * 0.37) * TAU - Math.PI / 2;
        drawComet(ctx, cx, cy, r - stroke / 2, angle, node.engine.color.rgb, stroke, placed.alpha);
        touched.push(rect(cx - r - 12, cy - r - 12, r * 2 + 24, r * 2 + 24));
        continue;
      }

      if (node.kind === 'work' && node.mode === 'row') {
        const glyph = workGlyph(node.work);
        if (!glyph || !glyphAnimates(node.work, glyph)) continue;
        const cx = placed.x + origin.x + node.rect.w - 10;
        const cy = placed.y + origin.y + node.rect.h / 2;
        if (cy + 10 < windowTop || cy - 10 > windowBottom) continue;
        drawGlyph(ctx, glyph, cx, cy, time, { color: this._glyphInk(node.work), alpha: placed.alpha });
        touched.push(rect(cx - 11, cy - 11, 22, 22));
      }
    }

    // A ring spreading from the mark of a piece of work whose state just changed.
    for (const ping of frame.pings) {
      const placed = frame.placed.find((candidate) => candidate.node.id === ping.id);
      if (!placed || placed.node.kind !== 'work') continue;
      const age = (frame.nowMs - ping.bornMs) / PING_MS;
      if (age < 0 || age >= 1) continue;
      const node = placed.node;
      const track = node.mode === 'reactor' ? (REACTOR_TYPE[layout.density] ?? REACTOR_TYPE[0]!).track : ROW_TRACK;
      const cx = trackMarkX(placed.x + origin.x + (node.mode === 'reactor' ? 1 : 2), node.work.stage, track);
      const cy = placed.y + origin.y + (node.mode === 'reactor'
        ? (REACTOR_TYPE[layout.density] ?? REACTOR_TYPE[0]!).footY
        : node.lines === 2 ? 15 : node.rect.h / 2);
      const radius = 4 + (node.mode === 'reactor' ? 24 : 14) * (1 - (1 - age) * (1 - age));
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = rgba(node.work.hue.rgb, 0.7 * (1 - age));
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.stroke();
      touched.push(rect(cx - radius - 3, cy - radius - 3, radius * 2 + 6, radius * 2 + 6));
    }
    ctx.restore();

    // The points travelling along a tether: towards the card while the work
    // waits on a person, and back from it once that person has acted.
    if (!frame.reducedMotion) {
      for (const route of this._tetherRoutes(frame)) {
        const state = route.tether.state;
        const count = state === 'working' ? 2 : state === 'sent' || state === 'waiting' ? 1 : 0;
        if (count === 0 || route.alpha <= 0.05 || route.length < 24) continue;
        const { color } = this._tetherColor(state, route.work);
        // The same speed along any tether, however long: a point is a pace, not a progress bar.
        const speed = state === 'waiting' ? 90 : state === 'sent' ? 260 : 340;
        const period = Math.max(1.2, route.length / speed);
        for (let i = 0; i < count; i++) {
          const phase = ((time / period) + i / count + hashUnit(route.tether.cardId)) % 1;
          const at = pointAlong(route.points, route.length * (state === 'waiting' ? phase : 1 - phase));
          // Fades in as it leaves and out as it arrives.
          const edge = Math.min(1, phase * 8, (1 - phase) * 8);
          const halo = ctx.createRadialGradient(at.x, at.y, 0, at.x, at.y, 7);
          halo.addColorStop(0, rgba(color, 0.55 * edge * route.alpha));
          halo.addColorStop(1, rgba(color, 0));
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(at.x, at.y, 7, 0, TAU);
          ctx.fill();
          ctx.fillStyle = rgba(color, 0.95 * edge * route.alpha);
          ctx.beginPath();
          ctx.arc(at.x, at.y, 1.7, 0, TAU);
          ctx.fill();
          touched.push(rect(at.x - 8, at.y - 8, 16, 16));
        }
      }
    }
    return touched;
  }

  /** Whether anything on `frame` moves without the state changing — whether,
   *  that is, the field has to keep painting frames at all. */
  hasMotion(frame: Frame): boolean {
    if (frame.pings.length > 0) return true;
    if (frame.reducedMotion) return false;
    for (const placed of frame.placed) {
      const { node } = placed;
      if (node.kind === 'engine' && node.mode === 'reactor' && node.engine.status === 'active') return true;
      if (node.kind === 'work' && node.mode === 'row' && glyphAnimates(node.work, workGlyph(node.work))) return true;
    }
    return frame.model.tethers.some((tether) =>
      (tether.state === 'waiting' || tether.state === 'sent' || tether.state === 'working') && frame.anchors.has(tether.cardId));
  }
}

/** Whether a work's glyph is one that moves, and the work is live to move it. */
function glyphAnimates(work: WorkView, glyph: ReturnType<typeof workGlyph>): boolean {
  return !work.dark && glyphMoves(glyph);
}

/** A tether as it is routed across the field, corner to corner. */
interface TetherRoute {
  tether: Tether;
  points: Point[];
  /** The length of the route, corner to corner. */
  length: number;
  alpha: number;
  work: WorkView;
}

/** The point `distance` along the path through `points`. */
function pointAlong(points: readonly Point[], distance: number): Point {
  let left = Math.max(0, distance);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const run = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= run || i === points.length - 1) {
      const t = run === 0 ? 0 : Math.min(1, left / run);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= run;
  }
  return points[points.length - 1] ?? { x: 0, y: 0 };
}

/** "#rrggbb" as the "r,g,b" triplet `rgba` takes. */
function hexToTriplet(hex: string): string {
  const value = hex.replace('#', '');
  const channel = (i: number): number => parseInt(value.slice(i, i + 2), 16) || 0;
  return `${channel(0)},${channel(2)},${channel(4)}`;
}

/** A number in 0..1 that is always the same for the same text: it keeps two
 *  tethers' travelling points out of step without anything being random. */
function hashUnit(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return ((hash >>> 0) % 997) / 997;
}
