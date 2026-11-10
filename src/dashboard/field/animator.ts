import type { FieldLayout, FieldNode } from './layout.js';
import { settleSpring, spring, stepSpring, type Spring } from './spring.js';

/**
 * What stands between the layout and the painter: the layout says where
 * everything belongs, and this says where everything is on the way there.
 *
 * A node keeps its identity for as long as the thing it stands for exists —
 * `work:<key>` for a piece of work, `engine:<n>` for an engine's ring — so
 * when a new layout moves it, it moves: a PR whose checks pass slides up a
 * stratum, and an engine's ring swings from the bench out to the work it has
 * just taken and back when it is done. That is how the field shows a change of
 * state, which the old panes could only show by redrawing.
 */

/** A node as it is drawn right now. */
export interface PlacedNode {
  node: FieldNode;
  /** The top-left of its box, in the scrolling content's coordinates. */
  x: number;
  y: number;
  /** An engine's ring, which grows and shrinks as well as moves. */
  ring: { cx: number; cy: number; r: number } | null;
  /** 0 (not there yet, or gone) to 1. */
  alpha: number;
}

/** A ring spreading from a piece of work whose state has just changed. */
export interface Ping {
  /** The id of the node it spreads from. */
  id: string;
  bornMs: number;
}

/** How long a ping lasts. */
export const PING_MS = 1100;
/** How long a node takes to fade in, and out. */
const FADE_IN_S = 0.26;
const FADE_OUT_S = 0.18;
/** A node this far from where it belongs is drawn at its faintest, so that
 *  things crossing on their way are not two lines of text set on top of one
 *  another: they firm up as they arrive. */
const FAR_PX = 220;
const FAR_ALPHA = 0.3;

/** How solid a node is drawn, for how far it still has to travel. */
function arriving(track: { x: Spring; y: Spring }): number {
  const distance = Math.hypot(track.x.value - track.x.target, track.y.value - track.y.target);
  return 1 - (1 - FAR_ALPHA) * Math.min(1, distance / FAR_PX);
}

interface Track {
  node: FieldNode;
  x: Spring;
  y: Spring;
  ring: { cx: Spring; cy: Spring; r: Spring } | null;
  alpha: number;
  /** False once the layout no longer has it, while it fades away. */
  present: boolean;
  /** What it is drawn as. A node that changes shape is cross-faded: nothing
   *  about a line of work can be tweened into a reactor. */
  shape: string;
  /** What about it sets off a ping when it changes. */
  mark: string;
}

function shapeOf(node: FieldNode): string {
  return node.kind === 'work' || node.kind === 'engine' ? `${node.kind}:${node.mode}` : node.kind;
}

/** What a piece of work has to change for the field to mark the change with a
 *  ping: where it is on the lifecycle, how hot it is, how its checks stand,
 *  what it is doing, and where its approval has got to. Not its clocks. */
function markOf(node: FieldNode): string {
  if (node.kind !== 'work') return '';
  const { work } = node;
  return [work.stage, node.level, work.checks, work.activity, work.approval.button?.step ?? '', work.approval.approved].join('|');
}

export class Animator {
  private readonly _tracks = new Map<string, Track>();
  private _pings: Ping[] = [];
  private _ghosts = 0;
  private _synced = false;

  /**
   * Take up a new layout. With `instant` nothing moves or fades — everything
   * is simply where it belongs — which is how the field behaves for a person
   * who has asked their system for less motion.
   */
  sync(layout: FieldLayout, nowMs: number, instant = false): void {
    const first = !this._synced;
    this._synced = true;
    const seen = new Set<string>();

    for (const node of layout.nodes) {
      seen.add(node.id);
      const shape = shapeOf(node);
      const mark = markOf(node);
      let track = this._tracks.get(node.id);

      if (track === undefined) {
        track = {
          node,
          x: spring(node.rect.x),
          y: spring(node.rect.y),
          ring: node.kind === 'engine'
            ? { cx: spring(node.ring.cx), cy: spring(node.ring.cy), r: spring(node.ring.r) }
            : null,
          alpha: instant ? 1 : 0,
          present: true,
          shape,
          mark,
        };
        this._tracks.set(node.id, track);
        continue;
      }

      if (track.shape !== shape && !instant) {
        // Leave the old shape fading where it was, and bring the new one in
        // from the same spot.
        this._tracks.set(`ghost:${this._ghosts++}`, {
          ...track,
          x: { ...track.x, target: track.x.value },
          y: { ...track.y, target: track.y.value },
          ring: track.ring && {
            cx: { ...track.ring.cx, target: track.ring.cx.value },
            cy: { ...track.ring.cy, target: track.ring.cy.value },
            r: { ...track.ring.r, target: track.ring.r.value },
          },
          present: false,
        });
        track.alpha = 0;
      }
      if (track.mark !== mark && !instant && !first) {
        this._pings.push({ id: node.id, bornMs: nowMs });
      }

      track.node = node;
      track.shape = shape;
      track.mark = mark;
      track.present = true;
      track.x.target = node.rect.x;
      track.y.target = node.rect.y;
      if (node.kind === 'engine') {
        track.ring ??= { cx: spring(node.ring.cx), cy: spring(node.ring.cy), r: spring(node.ring.r) };
        track.ring.cx.target = node.ring.cx;
        track.ring.cy.target = node.ring.cy;
        track.ring.r.target = node.ring.r;
      }
    }

    for (const [id, track] of this._tracks) {
      if (seen.has(id)) continue;
      if (instant) this._tracks.delete(id);
      else track.present = false;
    }

    if (instant) {
      for (const track of this._tracks.values()) {
        settleSpring(track.x);
        settleSpring(track.y);
        if (track.ring) {
          settleSpring(track.ring.cx);
          settleSpring(track.ring.cy);
          settleSpring(track.ring.r);
        }
        track.alpha = 1;
      }
      this._pings = [];
    }
  }

  /**
   * Advance by `dt` seconds. Returns true while anything is still moving or
   * fading, which is when the whole field has to be painted again.
   */
  step(dt: number): boolean {
    let moving = false;
    for (const [id, track] of this._tracks) {
      if (stepSpring(track.x, dt)) moving = true;
      if (stepSpring(track.y, dt)) moving = true;
      if (track.ring) {
        if (stepSpring(track.ring.cx, dt)) moving = true;
        if (stepSpring(track.ring.cy, dt)) moving = true;
        if (stepSpring(track.ring.r, dt)) moving = true;
      }
      if (track.present && track.alpha < 1) {
        track.alpha = Math.min(1, track.alpha + dt / FADE_IN_S);
        moving = true;
      } else if (!track.present) {
        track.alpha -= dt / FADE_OUT_S;
        if (track.alpha <= 0) this._tracks.delete(id);
        moving = true;
      }
    }
    return moving;
  }

  /** Drop the pings that have run their course. Returns true while any are left. */
  prunePings(nowMs: number): boolean {
    if (this._pings.length > 0) {
      this._pings = this._pings.filter((ping) => nowMs - ping.bornMs < PING_MS && this._tracks.has(ping.id));
    }
    return this._pings.length > 0;
  }

  get pings(): readonly Ping[] {
    return this._pings;
  }

  /** Every node as it is drawn right now, the ones fading away first so that
   *  what is arriving is drawn over what is leaving. */
  placed(): PlacedNode[] {
    const leaving: PlacedNode[] = [];
    const staying: PlacedNode[] = [];
    for (const track of this._tracks.values()) {
      (track.present ? staying : leaving).push({
        node: track.node,
        x: track.x.value,
        y: track.y.value,
        ring: track.ring && { cx: track.ring.cx.value, cy: track.ring.cy.value, r: track.ring.r.value },
        alpha: Math.max(0, Math.min(1, track.alpha)) * arriving(track),
      });
    }
    return [...leaving, ...staying];
  }

  /** Where node `id` is drawn right now, or null when it is not on the field. */
  find(id: string): PlacedNode | null {
    const track = this._tracks.get(id);
    if (track === undefined || !track.present) return null;
    return {
      node: track.node,
      x: track.x.value,
      y: track.y.value,
      ring: track.ring && { cx: track.ring.cx.value, cy: track.ring.cy.value, r: track.ring.r.value },
      alpha: track.alpha,
    };
  }
}
