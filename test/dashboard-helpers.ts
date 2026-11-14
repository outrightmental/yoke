import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { YokeInbox } from "../src/dashboard/components/yoke-inbox.js";
import { Animator } from "../src/dashboard/field/animator.js";
import type { Point } from "../src/dashboard/field/geometry.js";
import { layoutField, type FieldLayout, type Viewport } from "../src/dashboard/field/layout.js";
import { fieldModel, repoLabels, type FieldModel } from "../src/dashboard/field/model.js";
import { Painter, type Frame, type Surface } from "../src/dashboard/field/painter.js";
import { readPalette, type Palette } from "../src/dashboard/field/palette.js";
import { TextFitter, type TextStyle } from "../src/dashboard/field/text.js";
import { inboxWithLedger, InboxLedger, type InboxCard, type Selection } from "../src/dashboard/shared/inbox.js";
import type { KeepAwakeStatus } from "../src/dashboard/shared/keep-awake.js";
import { workViews, type WorkView } from "../src/dashboard/shared/work-view.js";
import { dashboardReducer, FAILURE_SHOW_MS, initialState } from "../src/dashboard/store/dashboard-store.js";
import type { CylinderState, DashboardState, LifecyclePair } from "../src/dashboard/store/types.js";

// What the dashboard's tests share: reading the markup a Lit component
// describes without a browser to render it, building the store's state, and a
// stand-in for the canvas the field paints on.

// ── Lit templates, without a DOM ─────────────────────────────────────────────

export interface Template {
  strings: readonly string[];
  values: readonly unknown[];
}

export function isTemplate(value: unknown): value is Template {
  return typeof value === "object" && value !== null && "strings" in value && "values" in value;
}

/**
 * What a directive in a template stands for, or undefined when `value` is not
 * one: the items of a `repeat`, each put through its template, and the markup
 * handed to `unsafeHTML`.
 */
function expandDirective(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("_$litDirective$" in value) || !("values" in value)) {
    return undefined;
  }
  const args = (value as { values: unknown[] }).values;
  const [first] = args;
  const template = args.slice(1).reverse().find((arg) => typeof arg === "function") as
    | ((item: unknown, index: number) => unknown)
    | undefined;
  if (template && first !== null && typeof first === "object" && Symbol.iterator in first) {
    return [...(first as Iterable<unknown>)].map(template);
  }
  return typeof first === "string" ? first : "";
}

/** A Lit TemplateResult flattened to the markup it describes. */
export function flatten(value: unknown): string {
  if (value === null || value === undefined || typeof value === "symbol") return "";
  if (Array.isArray(value)) return value.map(flatten).join("");
  if (isTemplate(value)) {
    return value.strings.reduce((out, s, i) => out + s + (i < value.values.length ? flatten(value.values[i]) : ""), "");
  }
  const expanded = expandDirective(value);
  if (expanded !== undefined) return flatten(expanded);
  return String(value);
}

/** The first template in `value` whose own markup contains `marker`. */
export function findTemplate(value: unknown, marker: string): Template | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTemplate(item, marker);
      if (found) return found;
    }
    return undefined;
  }
  if (!isTemplate(value)) {
    const expanded = expandDirective(value);
    return expanded === undefined ? undefined : findTemplate(expanded, marker);
  }
  if (value.strings.join("").includes(marker)) return value;
  return findTemplate([...value.values], marker);
}

/** Every template in `value` whose own markup contains `marker`. */
export function findTemplates(value: unknown, marker: string): Template[] {
  if (Array.isArray(value)) return value.flatMap((item) => findTemplates(item, marker));
  if (!isTemplate(value)) {
    const expanded = expandDirective(value);
    return expanded === undefined ? [] : findTemplates(expanded, marker);
  }
  const nested = findTemplates([...value.values], marker);
  return value.strings.join("").includes(marker) ? [value, ...nested] : nested;
}

/**
 * Click a rendered element, as the browser would: call its handler. A template
 * can hold several elements, each with a handler of its own, so `marker` says
 * which: the handler called is the first one bound after that piece of markup.
 */
export function click(template: Template | undefined, marker?: string): void {
  assert.ok(template, "the element is rendered");
  let from = 0;
  if (marker !== undefined) {
    from = template.strings.findIndex((part) => part.includes(marker));
    assert.ok(from >= 0, `the template has ${marker}`);
  }
  const handler = template.values.slice(from).find((value) => typeof value === "function") as
    | ((event: Event) => void)
    | undefined;
  assert.ok(handler, "the element has a click handler");
  handler(new Event("click"));
}

// ── The store's state ────────────────────────────────────────────────────────

export function makeEvent(type: string, data: Record<string, unknown> = {}, timestamp = new Date().toISOString()) {
  return { type, timestamp, data };
}

/** An engine cylinder, running an implementation of issue #7 in o/a unless told otherwise. */
export function cylinder(overrides: Partial<CylinderState> = {}): CylinderState {
  return {
    index: 1, color: null, colorRgb: null, status: "active", idleStatusText: "",
    actionType: "start-implementation", repo: "o/a", issueNumber: 7, prNumber: null,
    issueTitle: null, prTitle: null, model: null, iterationNumber: 1, thinkingLines: [],
    actionStartedAt: null, nextCycleAtMs: null, rateLimitedUntilMs: null,
    ...overrides,
  };
}

/** `state` with `pairs` as the lifecycle of project `repo`, as a lifecycle-update leaves it. */
export function withPairs(state: DashboardState, repo: string, pairs: LifecyclePair[]): DashboardState {
  return dashboardReducer(state, makeEvent("lifecycle-update", { repo, pairs }));
}

/** A connected dashboard showing `pairs` in project `repo`. */
export function stateWith(pairs: LifecyclePair[], repo = "o/a", overrides: Partial<DashboardState> = {}): DashboardState {
  return { ...withPairs({ ...initialState(), connection: "connected" }, repo, pairs), ...overrides };
}

// ── The inbox, as the app draws it ───────────────────────────────────────────

export interface RenderedInbox {
  inbox: YokeInbox;
  works: WorkView[];
  cards: InboxCard[];
  /** The whole inbox as markup. */
  html: string;
  /** The card with this id, or the first card when none is named. */
  card(id?: string): Template | undefined;
  /** The Approve button of the card for PR `pullRequestNumber`, if it has one. */
  approveButton(pullRequestNumber?: number): Template | undefined;
}

/**
 * The inbox for `state`, built and rendered the way yoke-app does it: the
 * state's work, the cards about it, and the element that draws them.
 */
export function renderInbox(
  state: DashboardState,
  options: {
    nowMs?: number;
    keepAwake?: KeepAwakeStatus;
    dismissed?: ReadonlySet<string>;
    ledger?: InboxLedger;
    inbox?: YokeInbox;
  } = {},
): RenderedInbox {
  const nowMs = options.nowMs ?? Date.now();
  const works = workViews(state, nowMs);
  const cards = inboxWithLedger({
    works,
    failures: [...state.failures.values()],
    keepAwake: options.keepAwake ?? "awake",
    dismissed: options.dismissed ?? new Set(),
    nowMs,
    failureShowMs: FAILURE_SHOW_MS,
  }, options.ledger ?? new InboxLedger());
  const inbox = options.inbox ?? new YokeInbox();
  Object.assign(inbox, { cards, multiProject: state.multiProject, open: true });
  const template = inbox.render();
  const cardTemplates = findTemplates(template, 'data-card="');
  const cardById = (id?: string): Template | undefined =>
    id === undefined ? cardTemplates[0] : cardTemplates.find((candidate) => flatten(candidate).includes(`data-card="${id}"`));
  return {
    inbox,
    works,
    cards,
    html: flatten(template),
    card: cardById,
    approveButton(pullRequestNumber) {
      const card = pullRequestNumber === undefined
        ? cards.find((candidate) => candidate.action?.type === "approve")
        : cards.find((candidate) => candidate.action?.type === "approve" && candidate.action.target.pullRequestNumber === pullRequestNumber);
      return card ? findTemplate(cardById(card.id), 'class="inbox-action approve') : undefined;
    },
  };
}

// ── A canvas that is not there ───────────────────────────────────────────────

export interface FakeCanvas {
  ctx: CanvasRenderingContext2D;
  /** Every call made on the context, in order. */
  calls: Array<{ method: string; args: unknown[] }>;
  /** Every string drawn with fillText, in order. */
  texts: string[];
  /** Every fill color a string was drawn in, alongside it. */
  fills: Array<{ text: string; fill: string }>;
  /** Every path filled, in order: its fill color, the global alpha it was
   *  filled at, and the circles and rounded boxes it was made of. */
  shapes: Array<{ fill: string; alpha: number; arcs: number[][]; boxes: number[][] }>;
  /** The stroke color of every path stroked, in order. */
  strokes: string[];
}

/** The size, in pixels, of the font in a CSS font shorthand. */
function fontSize(font: string): number {
  return Number(/([\d.]+)px/.exec(font)?.[1] ?? 12);
}

/**
 * A stand-in for a 2D canvas context: it draws nothing, remembers what it was
 * asked to draw, and measures text as a monospace face would — 0.6 of the
 * font size a character — so that what the painter fits and where it puts it
 * can be checked without a browser.
 */
export function fakeCanvas(): FakeCanvas {
  const calls: FakeCanvas["calls"] = [];
  const texts: string[] = [];
  const fills: FakeCanvas["fills"] = [];
  const shapes: FakeCanvas["shapes"] = [];
  const strokes: string[] = [];
  let arcs: number[][] = [];
  let boxes: number[][] = [];
  const state: Record<string, unknown> = { font: "12px monospace", fillStyle: "", strokeStyle: "", globalAlpha: 1 };
  const gradient = { addColorStop: () => {} };
  const special: Record<string, (...args: unknown[]) => unknown> = {
    measureText: (text) => ({ width: String(text).length * fontSize(String(state["font"])) * 0.6 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createConicGradient: () => gradient,
    createPattern: () => ({}),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Number(w) * Number(h) * 4), width: w, height: h }),
    fillText: (text) => {
      texts.push(String(text));
      fills.push({ text: String(text), fill: String(state["fillStyle"]) });
    },
    beginPath: () => {
      arcs = [];
      boxes = [];
    },
    arc: (...args) => void arcs.push(args.map(Number)),
    roundRect: (...args) => void boxes.push(args.map(Number)),
    fill: () => void shapes.push({ fill: String(state["fillStyle"]), alpha: Number(state["globalAlpha"]), arcs: [...arcs], boxes: [...boxes] }),
    stroke: () => void strokes.push(String(state["strokeStyle"])),
  };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push({ method: key, args });
        return special[key]?.(...args);
      };
    },
    set(target, key, value) {
      if (typeof key === "string") target[key] = value;
      return true;
    },
    has: (target, key) => typeof key === "string" && key in target,
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, texts, fills, shapes, strokes };
}

/** A text fitter that measures as `fakeCanvas` does. */
export function fakeFitter(): TextFitter {
  return new TextFitter((text: string, style: TextStyle) => text.length * fontSize(style.font) * 0.6);
}

/** A surface for the painter's layers that is backed by nothing. */
export function fakeSurface(width: number, height: number): Surface {
  const { ctx } = fakeCanvas();
  return { width, height, getContext: () => ctx };
}

const TOKENS_CSS = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "dashboard", "styles", "tokens.css");

/** The custom properties declared in tokens.css, as the browser would hand them to the canvas. */
export function tokenStyle(): { getPropertyValue(name: string): string } {
  const css = readFileSync(TOKENS_CSS, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = new Map([...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
  return { getPropertyValue: (name) => tokens.get(name) ?? "" };
}

/** The palette the field paints with: the dashboard's own tokens. */
export function tokensPalette(): Palette {
  return readPalette(tokenStyle());
}

// ── The field, painted on that canvas ────────────────────────────────────────

export interface PaintedField extends FakeCanvas {
  model: FieldModel;
  layout: FieldLayout;
  frame: Frame;
  painter: Painter;
  /** The fill color `text` was drawn in, as "r,g,b" and its alpha; undefined when it was not drawn. */
  inkOf(text: string): { rgb: string; alpha: number } | undefined;
}

/** "rgba(r,g,b,a)" taken apart. */
export function parseRgba(fill: string): { rgb: string; alpha: number } | undefined {
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(fill);
  return m ? { rgb: `${m[1]},${m[2]},${m[3]}`, alpha: Number(m[4]) } : undefined;
}

/**
 * The field for `state`, laid out and painted — the whole static picture — on
 * a canvas that only remembers what it was asked to draw.
 */
export function paintField(
  state: DashboardState,
  options: {
    nowMs?: number;
    viewport?: Partial<Viewport>;
    cards?: readonly InboxCard[];
    selection?: Selection | null;
    anchors?: ReadonlyMap<string, Point>;
    reducedMotion?: boolean;
  } = {},
): PaintedField {
  const nowMs = options.nowMs ?? Date.now();
  const model = fieldModel(state, nowMs, { cards: options.cards ?? [], selection: options.selection ?? null });
  const layout = layoutField(model, { width: 1400, height: 900, railWidth: 0, lampWidth: 132, ...options.viewport });
  const animator = new Animator();
  animator.sync(layout, 0, true);
  const labels = repoLabels(model.works.map((work) => work.repo));
  const frame: Frame = {
    layout,
    model,
    placed: animator.placed(),
    pings: [],
    scrollY: 0,
    anchors: options.anchors ?? new Map(),
    hover: null,
    focus: null,
    nowMs: 0,
    reducedMotion: options.reducedMotion ?? false,
    pixelRatio: 1,
    repoLabel: (repo) => labels.get(repo) ?? repo,
  };
  const canvas = fakeCanvas();
  const painter = new Painter(tokensPalette(), fakeFitter(), fakeSurface);
  painter.paintStatic(canvas.ctx, frame);
  return {
    ...canvas,
    model,
    layout,
    frame,
    painter,
    inkOf(text) {
      const drawn = canvas.fills.find((fill) => fill.text === text);
      return drawn ? parseRgba(drawn.fill) : undefined;
    },
  };
}

/** A palette color as the "r,g,b" a fill is written with. */
export function triplet(color: readonly [number, number, number]): string {
  return color.join(",");
}
