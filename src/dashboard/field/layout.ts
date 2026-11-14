import type { BurnLevel } from '../shared/burn-level.js';
import type { EngineView } from '../shared/engine-view.js';
import type { WorkView } from '../shared/work-view.js';
import { contains, rect, type Rect } from './geometry.js';
import { RIBBON_MAX_LINES, type FieldModel } from './model.js';

/**
 * Where everything on the field goes.
 *
 * The layout is geometry and nothing else: boxes for the painter to fill,
 * worked out from the model and the size of the window with no canvas, no
 * fonts and no clock. That keeps it a plain function that can be tested, and
 * means a resize or a new event costs one pass over a few dozen rectangles.
 *
 * It answers the complaint the field exists to answer — fixed rectangles with
 * content forced into them — by giving nothing a fixed place. Each level of
 * burn has its own line height and column width; an empty level takes no
 * room at all; and when the window cannot hold everything, the whole field
 * steps down to a denser set of sizes before it ever asks to be scrolled.
 */

/** The window the field is drawn in, in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
  /** The width the inbox covers on the right, which the field keeps clear of. */
  railWidth: number;
  /** The width the keep-awake lamp takes at the top right of the field. */
  lampWidth: number;
}

export type StratumLevel = Exclude<BurnLevel, 'burning'>;

/** One set of sizes the field can be laid out at. */
export interface Density {
  /** Height of a reactor, and the diameter of its ring. */
  reactorH: number;
  ringD: number;
  /** The narrowest a reactor is allowed to be before they wrap to another row. */
  reactorMinW: number;
  /** How many lines a reactor's title may run to. */
  reactorTitleLines: 1 | 2;
  rowH: Readonly<Record<StratumLevel, number>>;
  /** Whether a level's rows carry a second line of detail under the title. */
  rowLines: Readonly<Record<StratumLevel, 1 | 2>>;
  /** The narrowest a level's columns are allowed to be. */
  colMinW: Readonly<Record<StratumLevel, number>>;
  headerH: number;
  benchH: number;
  /** Space between one stratum and the next. */
  gap: number;
}

/**
 * The densities, roomiest first. The field uses the first one that fits the
 * window, and scrolls at the last.
 */
export const DENSITIES: readonly Density[] = [
  {
    reactorH: 120, ringD: 78, reactorMinW: 400, reactorTitleLines: 2,
    rowH: { queued: 46, waiting: 30, cold: 24 },
    rowLines: { queued: 2, waiting: 1, cold: 1 },
    // Wide columns while there is room for them: a title read whole is worth
    // more than a line saved.
    colMinW: { queued: 600, waiting: 600, cold: 440 },
    headerH: 30, benchH: 34, gap: 16,
  },
  {
    reactorH: 98, ringD: 64, reactorMinW: 360, reactorTitleLines: 2,
    rowH: { queued: 30, waiting: 28, cold: 22 },
    rowLines: { queued: 1, waiting: 1, cold: 1 },
    colMinW: { queued: 420, waiting: 420, cold: 320 },
    headerH: 28, benchH: 32, gap: 12,
  },
  {
    reactorH: 98, ringD: 64, reactorMinW: 360, reactorTitleLines: 2,
    rowH: { queued: 26, waiting: 24, cold: 20 },
    rowLines: { queued: 1, waiting: 1, cold: 1 },
    colMinW: { queued: 360, waiting: 360, cold: 280 },
    headerH: 24, benchH: 28, gap: 8,
  },
  {
    reactorH: 74, ringD: 50, reactorMinW: 300, reactorTitleLines: 1,
    rowH: { queued: 26, waiting: 24, cold: 20 },
    rowLines: { queued: 1, waiting: 1, cold: 1 },
    colMinW: { queued: 340, waiting: 340, cold: 270 },
    headerH: 22, benchH: 26, gap: 6,
  },
];

export const HUD_HEIGHT = 64;
/** The height of a hold's banner at the top of the field. */
export const HOLD_HEIGHT = 96;
/** Space between two columns, and between two reactors side by side. */
export const COLUMN_GAP = 32;
export const RIBBON_LINE_HEIGHT = 18;
/** The room above the ribbon's lines, which holds its rule. */
const RIBBON_PAD_TOP = 12;
const RIBBON_PAD_BOTTOM = 10;
/** How wide an engine on the bench is drawn: a small ring and a few words. */
const BENCH_SLOT_W = 210;
/** The most columns a level's rows are ever set in, however wide the window. */
const MAX_COLUMNS = 4;
/** No reactor is drawn wider than this: past it, a title is a line too long to read. */
const REACTOR_MAX_W = 760;
/** Nor a line of work: its status is set against its right-hand end, and past
 *  this the eye loses the way from a title to its status. */
const ROW_MAX_W = 760;

export type HudSlotKind = 'state' | 'cycle' | 'countdown' | 'usage';

export interface HudSlot {
  kind: HudSlotKind;
  rect: Rect;
}

/** The widths of the instruments at the top right, and the order they give way in
 *  when the window is too narrow for all of them: the first listed goes last. */
const HUD_SLOT_WIDTHS: ReadonlyArray<[HudSlotKind, number]> = [
  ['state', 176],
  ['usage', 206],
  ['countdown', 104],
  ['cycle', 70],
];
/** Left to right, as they are drawn. */
const HUD_SLOT_ORDER: readonly HudSlotKind[] = ['state', 'cycle', 'countdown', 'usage'];

export interface WorkNode {
  kind: 'work';
  /** `work:<key>`: the same through every move, so the field can animate it. */
  id: string;
  /** A reactor's text, beside its engine's ring; or a row in a stratum. */
  mode: 'reactor' | 'row';
  rect: Rect;
  /** Title lines for a reactor; text lines for a row. */
  lines: 1 | 2;
  /** The stratum it is drawn in. */
  level: BurnLevel;
  work: WorkView;
  /** The engine on it, for a reactor. */
  engine: EngineView | null;
}

export interface EngineNode {
  kind: 'engine';
  /** `engine:<index>`: an engine keeps its ring from the bench to a reactor and back. */
  id: string;
  mode: 'reactor' | 'bench';
  /** The ring's box for a reactor; the ring and its words for the bench. */
  rect: Rect;
  ring: { cx: number; cy: number; r: number };
  engine: EngineView;
  work: WorkView | null;
}

export interface HeaderNode {
  kind: 'header';
  id: string;
  rect: Rect;
  level: BurnLevel;
  /** How many pieces of work the stratum holds; for `burning`, how many engines are. */
  count: number;
  /** For `burning`: the size of the pool. */
  total: number | null;
  /**
   * The bands of a stratum below the reactors: a box behind every other line
   * of its work, counted down each column, so that two neighbouring lines —
   * gray, with no hue to tell them apart (#286) — are always on two different
   * grays. They belong to the stratum rather than to its lines, so they stay
   * put while the lines slide past them, and move only when the stratum does.
   * Empty for `burning`.
   */
  bands: Rect[];
}

export interface HoldNode {
  kind: 'hold';
  id: string;
  rect: Rect;
}

/** A line of words where the work would be, when there is none to draw. */
export interface NoteNode {
  kind: 'note';
  id: string;
  rect: Rect;
  text: string;
}

export type FieldNode = WorkNode | EngineNode | HeaderNode | HoldNode | NoteNode;

export interface FieldLayout {
  viewport: Viewport;
  /** Index into `DENSITIES` of the sizes in use. */
  density: number;
  /** The part of the window the field draws its content in: left of the inbox. */
  field: Rect;
  hud: { rect: Rect; title: Rect; slots: HudSlot[] };
  /** The window onto the scrolling content, in the field's coordinates. */
  scroll: Rect;
  /** The height of everything that scrolls. Taller than `scroll.h` means it does. */
  contentHeight: number;
  /** Everything that scrolls, positioned from the top-left of `scroll`. */
  nodes: FieldNode[];
  /** The last lines of the log, along the bottom. */
  ribbon: { rect: Rect; lines: number };
}

function padding(width: number): number {
  return width < 600 ? 14 : 28;
}

/** The content, laid out at one density, and how tall it came to. */
function layoutContent(model: FieldModel, width: number, density: Density): { nodes: FieldNode[]; height: number } {
  const nodes: FieldNode[] = [];
  let y = 8;

  if (model.vitals.hold !== null) {
    nodes.push({ kind: 'hold', id: 'hold', rect: rect(0, y, width, HOLD_HEIGHT) });
    y += HOLD_HEIGHT + density.gap;
  }

  // ── Burning: a reactor for every engine running an action ────────────────
  const engineCount = model.reactors.length + model.bench.length;
  if (engineCount > 0) {
    nodes.push({
      kind: 'header', id: 'header:burning', rect: rect(0, y, width, density.headerH),
      level: 'burning', count: model.reactors.length, total: engineCount, bands: [],
    });
    y += density.headerH;
  }

  if (model.reactors.length > 0) {
    const n = model.reactors.length;
    const fit = Math.max(1, Math.floor((width + COLUMN_GAP) / (density.reactorMinW + COLUMN_GAP)));
    // The columns are set by the size of the pool, not by how many engines
    // happen to be burning: as many rows as the whole pool would take, then
    // as few columns as fill them — six engines that fit four across are
    // three and three. So a reactor keeps its width, and its words their
    // line breaks, as the engines around it start and stop.
    const cols = Math.ceil(engineCount / Math.ceil(engineCount / fit));
    const rows = Math.ceil(n / cols);
    const cellW = Math.min(REACTOR_MAX_W, (width - COLUMN_GAP * (cols - 1)) / cols);
    const ringGap = Math.round(density.ringD * 0.26);
    model.reactors.forEach((reactor, i) => {
      const x = (i % cols) * (cellW + COLUMN_GAP);
      const top = y + Math.floor(i / cols) * density.reactorH;
      const r = density.ringD / 2;
      nodes.push({
        kind: 'engine',
        id: `engine:${reactor.engine.index}`,
        mode: 'reactor',
        rect: rect(x, top + (density.reactorH - density.ringD) / 2, density.ringD, density.ringD),
        ring: { cx: x + r, cy: top + density.reactorH / 2, r },
        engine: reactor.engine,
        work: reactor.work,
      });
      if (reactor.work) {
        const textX = x + density.ringD + ringGap;
        nodes.push({
          kind: 'work',
          id: `work:${reactor.work.key}`,
          mode: 'reactor',
          rect: rect(textX, top, cellW - density.ringD - ringGap, density.reactorH),
          lines: density.reactorTitleLines,
          level: 'burning',
          work: reactor.work,
          engine: reactor.engine,
        });
      }
    });
    y += rows * density.reactorH;
  }

  // ── The bench: the engines that are not running an action ───────────────
  if (model.bench.length > 0) {
    const fit = Math.max(1, Math.floor(width / BENCH_SLOT_W));
    // Evenly, as the reactors are: six idle engines are three and three, not five and one.
    const perRow = Math.ceil(model.bench.length / Math.ceil(model.bench.length / fit));
    const slotW = Math.min(BENCH_SLOT_W * 1.5, width / perRow);
    const r = Math.round((density.benchH - 12) / 2);
    model.bench.forEach((engine, i) => {
      const x = (i % perRow) * slotW;
      const top = y + Math.floor(i / perRow) * density.benchH;
      nodes.push({
        kind: 'engine',
        id: `engine:${engine.index}`,
        mode: 'bench',
        rect: rect(x, top, slotW - 12, density.benchH),
        ring: { cx: x + r + 1, cy: top + density.benchH / 2, r },
        engine,
        work: null,
      });
    });
    y += Math.ceil(model.bench.length / perRow) * density.benchH;
  }

  // ── The strata below: a line for every piece of work no engine is on ────
  for (const stratum of model.strata) {
    const { level, works } = stratum;
    y += density.gap;
    const bands: Rect[] = [];
    nodes.push({
      kind: 'header', id: `header:${level}`, rect: rect(0, y, width, density.headerH),
      level, count: works.length, total: null, bands,
    });
    y += density.headerH;
    // As many columns as fit, but never more than there is work to put in
    // them: three lines of work are three columns, not three quarters of four.
    const cols = Math.min(
      MAX_COLUMNS,
      works.length,
      Math.max(1, Math.floor((width + COLUMN_GAP) / (density.colMinW[level] + COLUMN_GAP))),
    );
    const colW = Math.min(ROW_MAX_W, (width - COLUMN_GAP * (cols - 1)) / cols);
    const rowH = density.rowH[level];
    // Down each column in turn, like a newspaper: when a piece of work leaves,
    // the ones under it close up by a line, and nothing else has to move.
    const rows = Math.ceil(works.length / cols);
    works.forEach((work, i) => {
      const box = rect(Math.floor(i / rows) * (colW + COLUMN_GAP), y + (i % rows) * rowH, colW, rowH);
      // The second line of each column is banded, and every other one after it.
      if ((i % rows) % 2 === 1) bands.push({ ...box });
      nodes.push({
        kind: 'work',
        id: `work:${work.key}`,
        mode: 'row',
        rect: box,
        lines: density.rowLines[level],
        level,
        work,
        engine: null,
      });
    });
    y += rows * rowH;
  }

  if (model.works.length === 0 && model.vitals.hold === null) {
    y += density.gap;
    nodes.push({
      kind: 'note', id: 'note', rect: rect(0, y, width, 40),
      text: !model.loaded ? 'Connecting to yoke…' : 'No open issues or pull requests.',
    });
    y += 40;
  }

  return { nodes, height: y + 12 };
}

function layoutHud(model: FieldModel, field: Rect, lampWidth: number): FieldLayout['hud'] {
  const hudRect = rect(field.x, 0, field.w, HUD_HEIGHT);
  // The title keeps this much whatever else is going on at the top.
  const titleReserve = Math.min(340, field.w * 0.42);
  const wanted = new Set<HudSlotKind>(['usage']);
  if (model.vitals.connection !== 'connected' || model.vitals.phase !== 'running') wanted.add('state');
  if (model.vitals.countdown !== null) wanted.add('countdown');
  if (model.vitals.cycle > 0) wanted.add('cycle');

  let room = field.w - lampWidth - titleReserve;
  const kept = new Map<HudSlotKind, number>();
  for (const [kind, width] of HUD_SLOT_WIDTHS) {
    if (!wanted.has(kind) || width > room) continue;
    kept.set(kind, width);
    room -= width;
  }

  const slots: HudSlot[] = [];
  let x = field.x + field.w - lampWidth;
  for (const kind of [...HUD_SLOT_ORDER].reverse()) {
    const width = kept.get(kind);
    if (width === undefined) continue;
    x -= width;
    slots.unshift({ kind, rect: rect(x, 0, width, HUD_HEIGHT) });
  }
  const titleRight = slots[0]?.rect.x ?? field.x + field.w - lampWidth;
  return {
    rect: hudRect,
    title: rect(field.x, 0, Math.max(60, titleRight - field.x - 16), HUD_HEIGHT),
    slots,
  };
}

/**
 * Lay the field out for `model` in `viewport`.
 *
 * The ribbon always keeps one line. The roomiest density whose content fits
 * above it is used, and whatever height is left over goes to more lines of the
 * ribbon; if not even the densest fits, the content scrolls.
 */
export function layoutField(model: FieldModel, viewport: Viewport): FieldLayout {
  const pad = padding(viewport.width);
  const fieldW = Math.max(160, viewport.width - viewport.railWidth - pad * 2);
  const field = rect(pad, 0, fieldW, viewport.height);
  const minRibbonH = RIBBON_PAD_TOP + RIBBON_LINE_HEIGHT + RIBBON_PAD_BOTTOM;
  const room = Math.max(80, viewport.height - HUD_HEIGHT - minRibbonH);

  let density = DENSITIES.length - 1;
  let content = layoutContent(model, fieldW, DENSITIES[density]!);
  for (let i = 0; i < DENSITIES.length; i++) {
    const candidate = layoutContent(model, fieldW, DENSITIES[i]!);
    if (candidate.height <= room) {
      density = i;
      content = candidate;
      break;
    }
  }

  const spare = Math.max(0, room - content.height);
  const lines = Math.max(
    1,
    Math.min(RIBBON_MAX_LINES, Math.max(1, model.ribbon.length), 1 + Math.floor(spare / RIBBON_LINE_HEIGHT)),
  );
  const ribbonH = RIBBON_PAD_TOP + lines * RIBBON_LINE_HEIGHT + RIBBON_PAD_BOTTOM;
  const scrollH = Math.max(40, viewport.height - HUD_HEIGHT - ribbonH);

  return {
    viewport,
    density,
    field,
    hud: layoutHud(model, field, viewport.lampWidth),
    scroll: rect(field.x, HUD_HEIGHT, fieldW, scrollH),
    contentHeight: content.height,
    nodes: content.nodes,
    ribbon: { rect: rect(field.x, viewport.height - ribbonH, fieldW, ribbonH), lines },
  };
}

/** How far the content can be scrolled. Zero when it all fits. */
export function maxScroll(layout: FieldLayout): number {
  return Math.max(0, layout.contentHeight - layout.scroll.h);
}

/** What is under a point on the field, for a tap or the pointer. */
export type Hit =
  | { kind: 'work'; key: string; node: WorkNode }
  | { kind: 'engine'; index: number; node: EngineNode }
  | { kind: 'hold' }
  | { kind: 'title' }
  | { kind: 'usage' }
  | { kind: 'ribbon' };

/**
 * What the point (`x`, `y`) of the field is over, with the content scrolled by
 * `scrollY`. Work wins over the engine ring beside it only where they overlap,
 * which they do not; the order below is just nearest-to-the-finger first.
 */
export function hitTest(layout: FieldLayout, x: number, y: number, scrollY: number): Hit | null {
  if (contains(layout.ribbon.rect, x, y)) return { kind: 'ribbon' };
  if (y < HUD_HEIGHT) {
    for (const slot of layout.hud.slots) {
      if (slot.kind === 'usage' && contains(slot.rect, x, y)) return { kind: 'usage' };
    }
    return contains(layout.hud.title, x, y) ? { kind: 'title' } : null;
  }
  if (!contains(layout.scroll, x, y)) return null;
  const cx = x - layout.scroll.x;
  const cy = y - layout.scroll.y + scrollY;
  for (const node of layout.nodes) {
    if (!contains(node.rect, cx, cy)) continue;
    if (node.kind === 'work') return { kind: 'work', key: node.work.key, node };
    if (node.kind === 'engine') return { kind: 'engine', index: node.engine.index, node };
    if (node.kind === 'hold') return { kind: 'hold' };
  }
  return null;
}
