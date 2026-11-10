import { LitElement, html } from 'lit';
import { Animator } from '../field/animator.js';
import { clamp, type Point, type Rect } from '../field/geometry.js';
import { hitTest, layoutField, maxScroll, type FieldLayout, type Hit } from '../field/layout.js';
import { repoLabels, type FieldModel } from '../field/model.js';
import { Painter, type Frame, type Surface } from '../field/painter.js';
import { readPalette } from '../field/palette.js';
import { FONT_FACES, TextFitter, type TextStyle } from '../field/text.js';
import type { Selection } from '../shared/inbox.js';
import type { WorkView } from '../shared/work-view.js';

/** A canvas is never drawn at more than this many device pixels per CSS pixel:
 *  past it the text is no sharper to the eye, and every frame fills more. */
const MAX_PIXEL_RATIO = 2;
/** While only the comets and orbits are moving, frames closer together than
 *  this are skipped: about thirty a second is all a slow turn needs. */
const AMBIENT_FRAME_MS = 30;
/** A press that travels further than this is a drag, not a tap. */
const TAP_SLOP = 8;
/** How fast a flick's scrolling dies away, per second. */
const SCROLL_FRICTION = 4.2;
/** More boxes than this to put back, and it is cheaper to put back the lot. */
const MAX_DIRTY_RECTS = 40;

const LEVEL_NAMES = { queued: 'Queued', waiting: 'Waiting', cold: 'Cold' } as const;

/**
 * The field: the state of the whole run, drawn on one canvas.
 *
 * This element owns the canvas and the loop. It lays the model out, hands the
 * layout to the animator, and asks the painter for frames — the whole picture
 * when something has changed, only the few moving marks otherwise, and nothing
 * at all while the tab is hidden or nothing on the field moves. Presses on
 * the canvas pick things out (`field-select`); everything a person can *do*
 * lives in the inbox beside it.
 *
 * A canvas is opaque to a screen reader and to the keyboard, so the element
 * also renders everything it draws as ordinary markup, out of sight: the same
 * model, as headings, lists and links.
 */
export class YokeField extends LitElement {
  static override properties = {
    model: { attribute: false },
    railWidth: { type: Number },
    lampWidth: { type: Number },
    anchors: { attribute: false },
  };

  model: FieldModel | null = null;
  /** The width the inbox covers on the right, which the field keeps clear of. */
  railWidth = 0;
  /** The width the keep-awake lamp takes at the field's top right. */
  lampWidth = 0;
  /** Where each inbox card is tethered from, by card id, in the window's
   *  coordinates — which are this element's, since it fills the window. */
  anchors: ReadonlyMap<string, Point> = new Map();

  private _canvas: HTMLCanvasElement | null = null;
  private _ctx: CanvasRenderingContext2D | null = null;
  private _static: HTMLCanvasElement | null = null;
  private _staticCtx: CanvasRenderingContext2D | null = null;
  private _painter: Painter | null = null;
  private _fitter: TextFitter | null = null;
  private readonly _animator = new Animator();
  private _layout: FieldLayout | null = null;
  private _labels = new Map<string, string>();

  private _width = 0;
  private _height = 0;
  private _dpr = 1;
  private _scrollY = 0;
  private _scrollVelocity = 0;
  private _hover: string | null = null;
  private _focus: string | null = null;
  private _reduced = false;

  private _staticDirty = true;
  private _dirty: Rect[] = [];
  private _raf: number | null = null;
  private _lastFrameMs = 0;
  private _lastPaintMs = 0;
  private _press: { id: number; x: number; y: number; scroll: number; dragging: boolean; lastY: number; lastMs: number } | null = null;

  private _resizeObserver: ResizeObserver | null = null;
  private _motionQuery: MediaQueryList | null = null;
  private _ratioQuery: MediaQueryList | null = null;
  private readonly _cleanups: Array<() => void> = [];

  protected override createRenderRoot() { return this; }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  protected override firstUpdated() {
    this._start();
  }

  override connectedCallback() {
    super.connectedCallback();
    // Re-arm after a detach and re-attach; firstUpdated only ever runs once.
    if (this.hasUpdated) this._start();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._stop();
  }

  protected override updated(changed: Map<string, unknown>) {
    if (changed.has('model') || changed.has('railWidth') || changed.has('lampWidth')) this._relayout();
    else if (changed.has('anchors')) this._invalidate();
  }

  private _start() {
    if (this._canvas) return;
    const canvas = this.querySelector<HTMLCanvasElement>('canvas.field-canvas');
    if (!canvas) return;
    this._canvas = canvas;
    // Opaque: the field paints its own ground, and a canvas the compositor
    // need not blend with what is behind it is cheaper every frame.
    this._ctx = canvas.getContext('2d', { alpha: false });
    this._static = document.createElement('canvas');
    this._staticCtx = this._static.getContext('2d', { alpha: false });
    if (!this._ctx || !this._staticCtx) return;
    // A canvas can lose its backing store — a GPU reset, a long sleep — and
    // comes back blank. Nothing here is kept on the canvas that the next
    // frame cannot paint again.
    this._listen(canvas, 'contextrestored', () => {
      this._painter?.reset();
      this._invalidate();
    });

    const measureCtx = this._staticCtx;
    this._fitter = new TextFitter((text: string, style: TextStyle) => {
      measureCtx.font = style.font;
      if ('letterSpacing' in measureCtx) measureCtx.letterSpacing = `${style.spacing}px`;
      return measureCtx.measureText(text).width;
    });
    this._painter = new Painter(
      readPalette(getComputedStyle(document.documentElement)),
      this._fitter,
      (width, height): Surface => {
        const surface = document.createElement('canvas');
        surface.width = width;
        surface.height = height;
        return surface as unknown as Surface;
      },
    );

    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(this);

    this._motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this._reduced = this._motionQuery.matches;
    this._listen(this._motionQuery, 'change', () => {
      this._reduced = this._motionQuery?.matches ?? false;
      this._relayout();
    });
    this._listen(document, 'visibilitychange', () => {
      if (!document.hidden) this._invalidate();
    });
    this._listen(canvas, 'pointerdown', (event) => this._onPointerDown(event as PointerEvent));
    this._listen(canvas, 'pointermove', (event) => this._onPointerMove(event as PointerEvent));
    this._listen(canvas, 'pointerup', (event) => this._onPointerUp(event as PointerEvent));
    this._listen(canvas, 'pointercancel', () => {
      this._press = null;
      this._setHover(null);
    });
    this._listen(canvas, 'pointerleave', () => this._setHover(null));
    this._listen(canvas, 'wheel', (event) => this._onWheel(event as WheelEvent), { passive: false });

    // Text is measured to be fitted, and a measurement taken before a face
    // has loaded is of the wrong face: load them, then measure again.
    const fonts = document.fonts;
    const remeasure = () => {
      this._fitter?.clear();
      this._invalidate();
    };
    void Promise.allSettled(FONT_FACES.map((face) => fonts.load(face))).then(remeasure);
    this._listen(fonts, 'loadingdone', remeasure);

    this._watchPixelRatio();
    this._resize();
  }

  private _stop() {
    if (this._raf !== null) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    for (const cleanup of this._cleanups.splice(0)) cleanup();
    this._canvas = null;
    this._ctx = null;
    this._static = null;
    this._staticCtx = null;
    this._painter = null;
    this._press = null;
    // The next `_start` makes a new static layer at a canvas's default size,
    // so its first `_resize` must not find the size unchanged and skip it.
    this._width = 0;
    this._height = 0;
    this._lastFrameMs = 0;
  }

  private _listen(target: EventTarget, type: string, handler: (event: Event) => void, options?: AddEventListenerOptions) {
    target.addEventListener(type, handler, options);
    this._cleanups.push(() => target.removeEventListener(type, handler, options));
  }

  /** The pixel ratio changes with the zoom, and with the screen the window is
   *  on; a query for the current one fires once when it stops being true. */
  private _watchPixelRatio() {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this._ratioQuery = query;
    const onChange = () => {
      query.removeEventListener('change', onChange);
      if (this._ratioQuery !== query || !this._canvas) return;
      this._resize();
      this._watchPixelRatio();
    };
    query.addEventListener('change', onChange);
    this._cleanups.push(() => query.removeEventListener('change', onChange));
  }

  // ── Layout ─────────────────────────────────────────────────────────────────

  private _resize() {
    const canvas = this._canvas;
    const still = this._static;
    if (!canvas || !still) return;
    const box = this.getBoundingClientRect();
    const width = Math.max(1, Math.round(box.width));
    const height = Math.max(1, Math.round(box.height));
    const dpr = Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1);
    if (width === this._width && height === this._height && dpr === this._dpr) return;
    this._width = width;
    this._height = height;
    this._dpr = dpr;
    for (const surface of [canvas, still]) {
      surface.width = Math.round(width * dpr);
      surface.height = Math.round(height * dpr);
    }
    this._relayout();
  }

  private _relayout() {
    const model = this.model;
    if (!model || !this._canvas || this._width === 0) return;
    this._labels = repoLabels([...model.works.map((work) => work.repo), ...model.ribbon.map((line) => line.repo)]);
    this._layout = layoutField(model, {
      width: this._width,
      height: this._height,
      railWidth: this.railWidth,
      lampWidth: this.lampWidth,
    });
    this._scrollY = clamp(this._scrollY, 0, maxScroll(this._layout));
    this._animator.sync(this._layout, performance.now(), this._reduced);
    this._invalidate();
  }

  // ── The loop ───────────────────────────────────────────────────────────────

  /** The picture has changed: paint all of it on the next frame. */
  private _invalidate() {
    this._staticDirty = true;
    this._schedule();
  }

  private _schedule() {
    if (this._raf !== null || !this._canvas || document.hidden) return;
    this._raf = requestAnimationFrame((ms) => this._frame(ms));
  }

  private _frame(ms: number) {
    this._raf = null;
    const { _ctx: ctx, _staticCtx: staticCtx, _static: still, _painter: painter, _layout: layout, model } = this;
    if (!ctx || !staticCtx || !still || !painter || !layout || !model) return;

    // A long gap between frames is taken in one stride: the springs are solved
    // in closed form, so a slow machine sees fewer frames of a move, not a slower move.
    const dt = this._lastFrameMs === 0 ? 0 : Math.min(0.25, (ms - this._lastFrameMs) / 1000);
    this._lastFrameMs = ms;

    let coasting = false;
    if (Math.abs(this._scrollVelocity) > 6 && this._press === null) {
      const limit = maxScroll(layout);
      const next = clamp(this._scrollY + this._scrollVelocity * dt, 0, limit);
      this._scrollVelocity = next === 0 || next === limit ? 0 : this._scrollVelocity * Math.exp(-SCROLL_FRICTION * dt);
      this._scrollY = next;
      coasting = true;
    }
    const moving = this._animator.step(dt);
    this._animator.prunePings(ms);
    if (moving || coasting) this._staticDirty = true;

    // Only the small marks are moving: thirty frames a second is plenty.
    if (!this._staticDirty && ms - this._lastPaintMs < AMBIENT_FRAME_MS) {
      this._schedule();
      return;
    }
    this._lastPaintMs = ms;

    const frame: Frame = {
      layout,
      model,
      placed: this._animator.placed(),
      pings: this._animator.pings,
      scrollY: this._scrollY,
      anchors: this.anchors,
      hover: this._hover,
      focus: this._focus,
      nowMs: ms,
      reducedMotion: this._reduced,
      pixelRatio: this._dpr,
      repoLabel: (repo) => this._labels.get(repo) ?? repo,
    };
    const dpr = this._dpr;

    if (this._staticDirty) {
      staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      painter.paintStatic(staticCtx, frame);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(still, 0, 0);
      this._staticDirty = false;
    } else {
      this._restore(ctx, still, dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._dirty = painter.paintDynamic(ctx, frame, ms / 1000);

    if (moving || coasting || painter.hasMotion(frame)) this._schedule();
    else this._lastFrameMs = 0;
  }

  /** Put the static picture back wherever the last frame's moving marks were drawn. */
  private _restore(ctx: CanvasRenderingContext2D, still: HTMLCanvasElement, dpr: number) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this._dirty.length > MAX_DIRTY_RECTS) {
      ctx.drawImage(still, 0, 0);
      return;
    }
    for (const box of this._dirty) {
      // Whole device pixels, a pixel wider than drawn, so no edge is left behind.
      const x = Math.max(0, Math.floor(box.x * dpr) - 1);
      const y = Math.max(0, Math.floor(box.y * dpr) - 1);
      const w = Math.min(still.width - x, Math.ceil(box.w * dpr) + 3);
      const h = Math.min(still.height - y, Math.ceil(box.h * dpr) + 3);
      if (w > 0 && h > 0) ctx.drawImage(still, x, y, w, h, x, y, w, h);
    }
  }

  // ── Pointer ────────────────────────────────────────────────────────────────

  private _local(event: MouseEvent): Point {
    const box = this._canvas!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  private _hit(point: Point): Hit | null {
    return this._layout ? hitTest(this._layout, point.x, point.y, this._scrollY) : null;
  }

  private _hoverId(hit: Hit | null): string | null {
    if (!hit) return null;
    if (hit.kind === 'work' || hit.kind === 'engine') return hit.node.id;
    return hit.kind;
  }

  private _setHover(id: string | null) {
    if (id === this._hover) return;
    this._hover = id;
    if (this._canvas) this._canvas.style.cursor = id ? 'pointer' : '';
    this._invalidate();
  }

  private _onPointerDown(event: PointerEvent) {
    if (event.button !== 0 || !this._layout) return;
    const point = this._local(event);
    this._scrollVelocity = 0;
    this._press = { id: event.pointerId, x: point.x, y: point.y, scroll: this._scrollY, dragging: false, lastY: point.y, lastMs: event.timeStamp };
    this._canvas?.setPointerCapture(event.pointerId);
    // A finger has no hover to say what it is about to pick: light what is under it as it lands.
    if (event.pointerType !== 'mouse') this._setHover(this._hoverId(this._hit(point)));
  }

  private _onPointerMove(event: PointerEvent) {
    const point = this._local(event);
    const press = this._press;
    if (!press || press.id !== event.pointerId) {
      // No hover on a touch screen: a finger is either pressing or it is not there.
      if (event.pointerType === 'mouse') this._setHover(this._hoverId(this._hit(point)));
      return;
    }
    const layout = this._layout;
    if (!layout) return;
    const travelled = point.y - press.y;
    if (!press.dragging && Math.abs(travelled) > TAP_SLOP && maxScroll(layout) > 0) {
      press.dragging = true;
      if (event.pointerType !== 'mouse') this._setHover(null);
    }
    if (!press.dragging) return;
    this._scrollY = clamp(press.scroll - travelled, 0, maxScroll(layout));
    const elapsed = Math.max(1, event.timeStamp - press.lastMs);
    // A running average, so one jittery sample does not decide the flick.
    this._scrollVelocity = this._scrollVelocity * 0.4 + ((press.lastY - point.y) / elapsed) * 1000 * 0.6;
    press.lastY = point.y;
    press.lastMs = event.timeStamp;
    this._invalidate();
  }

  private _onPointerUp(event: PointerEvent) {
    const press = this._press;
    if (!press || press.id !== event.pointerId) return;
    this._press = null;
    if (event.pointerType !== 'mouse') this._setHover(null);
    if (press.dragging) {
      // A finger that stopped before it lifted meant to stop the scroll.
      if (event.timeStamp - press.lastMs > 80) this._scrollVelocity = 0;
      this._schedule();
      return;
    }
    this._scrollVelocity = 0;
    const point = this._local(event);
    if (Math.hypot(point.x - press.x, point.y - press.y) > TAP_SLOP) return;
    this._tap(this._hit(point));
  }

  private _onWheel(event: WheelEvent) {
    const layout = this._layout;
    if (!layout || maxScroll(layout) <= 0) return;
    event.preventDefault();
    const lines = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? layout.scroll.h : 1;
    this._scrollVelocity = 0;
    this._scrollY = clamp(this._scrollY + event.deltaY * lines, 0, maxScroll(layout));
    this._invalidate();
  }

  private _tap(hit: Hit | null) {
    if (hit?.kind === 'ribbon') {
      this.dispatchEvent(new CustomEvent('field-log', { bubbles: true, composed: true }));
      return;
    }
    if (hit?.kind === 'title') {
      const url = this.model?.vitals.homeUrl;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    const selection: Selection | null =
      hit === null ? null
        : hit.kind === 'work' ? { kind: 'work', key: hit.key }
          : hit.kind === 'engine' ? { kind: 'engine', index: hit.index }
            : hit.kind === 'hold' ? { kind: 'hold' }
              : { kind: 'usage' };
    this.dispatchEvent(new CustomEvent<Selection | null>('field-select', { detail: selection, bubbles: true, composed: true }));
  }

  // ── The same picture, as markup ────────────────────────────────────────────

  private _onMirrorFocus(event: FocusEvent) {
    const id = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-node]')?.dataset['node'] ?? null;
    this._focus = id;
    const layout = this._layout;
    const node = id && layout ? layout.nodes.find((candidate) => candidate.id === id) : undefined;
    if (node && layout) {
      // Bring what has the focus into the window, as a page would scroll to it.
      const top = node.rect.y - 12;
      const bottom = node.rect.y + node.rect.h + 12 - layout.scroll.h;
      this._scrollY = clamp(Math.min(top, Math.max(bottom, this._scrollY)), 0, maxScroll(layout));
    }
    this._invalidate();
  }

  private _onMirrorBlur() {
    this._focus = null;
    this._invalidate();
  }

  private _workItem(work: WorkView, multiProject: boolean) {
    const id = `work:${work.key}`;
    const number = work.number !== null ? `#${work.number} ` : '';
    const pr = work.pair.pr;
    const first = work.issueUrl ?? work.prUrl;
    return html`<li>
      ${first
        ? html`<a class="gh-link" data-node="${id}" href="${first}" target="_blank" rel="noopener noreferrer">${number}${work.title}</a>`
        : html`<span data-node="${id}">${number}${work.title}</span>`}
      ${pr && work.prUrl && work.issueUrl
        ? html` · <a class="gh-link" href="${work.prUrl}" target="_blank" rel="noopener noreferrer">PR #${pr.number}</a>`
        : ''}
      · ${work.status.text}${multiProject && work.repo ? html` · ${work.repo}` : ''}
    </li>`;
  }

  private _mirror(model: FieldModel) {
    const { vitals } = model;
    const onReactors = model.reactors.flatMap((reactor) => (reactor.work ? [reactor.work] : []));
    const engines = [...model.reactors.map((reactor) => reactor.engine), ...model.bench].sort((a, b) => a.index - b.index);
    return html`
      <div class="field-mirror" @focusin=${this._onMirrorFocus} @focusout=${this._onMirrorBlur}>
        <h1><a class="gh-link" data-node="title" href="${vitals.homeUrl}" target="_blank" rel="noopener noreferrer">${vitals.title}</a></h1>
        <p>
          ${vitals.subtitle ? html`${vitals.subtitle}. ` : ''}${vitals.cycle > 0 ? html`Cycle ${vitals.cycle}. ` : ''}${vitals.countdown
            ? html`${vitals.countdown.held ? 'Waiting' : 'Next cycle in'} ${vitals.countdown.value}. `
            : ''}${vitals.usage.title}.
          ${vitals.phase === 'shut-down' ? 'Yoke has shut down.' : vitals.phase === 'shutting-down' ? 'Yoke is shutting down.' : ''}
          ${vitals.connection === 'disconnected' ? 'The connection to yoke is lost.' : ''}
        </p>
        ${vitals.hold ? html`<p class="field-mirror-hold" role="status">
          Waiting <span class="hold-duration">${vitals.hold.remaining}</span>
          until <span class="hold-deadline">${vitals.hold.deadline}</span>
          for ${vitals.hold.reason} · no work is planned or started until then
        </p>` : ''}
        <h2>Engines: ${vitals.burning} of ${vitals.engines} burning</h2>
        <ul>
          ${engines.map((engine) => html`<li data-node="engine:${engine.index}">
            Engine ${engine.index + 1}: ${engine.line}${engine.model && engine.status === 'active' ? html` · ${engine.model}` : ''}${model.multiProject && engine.repo ? html` · ${engine.repo}` : ''}
          </li>`)}
        </ul>
        ${onReactors.length > 0 ? html`
          <h2>Burning (${onReactors.length})</h2>
          <ul>${onReactors.map((work) => this._workItem(work, model.multiProject))}</ul>` : ''}
        ${model.strata.map((stratum) => html`
          <h2>${LEVEL_NAMES[stratum.level]} (${stratum.works.length})</h2>
          <ul>${stratum.works.map((work) => this._workItem(work, model.multiProject))}</ul>`)}
      </div>`;
  }

  override render() {
    return html`
      <canvas class="field-canvas" aria-hidden="true"></canvas>
      ${this.model ? this._mirror(this.model) : ''}
    `;
  }
}

customElements.define('yoke-field', YokeField);
