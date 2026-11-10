import type { WorkGlyph } from '../shared/work-view.js';
import { rgba, type Rgb } from './palette.js';

/**
 * The marks the field is drawn with: the track of a work's five stages, an
 * engine's comet, and the small glyph at the end of a line of work. Each is a
 * few strokes straight onto the canvas — no icon font, no images, so they
 * scale to any ring or line height and take any color.
 */
type Ctx = CanvasRenderingContext2D;

const TAU = Math.PI * 2;

export interface TrackStyle {
  /** Distance between the centres of two marks. */
  pitch: number;
  /** Radius of the mark the work has reached; the others are smaller. */
  dot: number;
  /** The work's color, as an "r,g,b" triplet. */
  color: string;
  trim: Rgb;
  alpha: number;
}

/** The x of the centre of mark `stage` on a track whose first mark starts at `x`. */
export function trackMarkX(x: number, stage: number, style: Pick<TrackStyle, 'pitch' | 'dot'>): number {
  return x + style.dot + stage * style.pitch;
}

/** The width a track of `marks` marks takes. */
export function trackWidth(marks: number, style: Pick<TrackStyle, 'pitch' | 'dot'>): number {
  return (marks - 1) * style.pitch + style.dot * 2;
}

/**
 * A work's place on the lifecycle: `marks` marks on a line, colored up to the
 * one it has reached. What is behind it is its color, what is ahead is trim.
 */
export function drawTrack(ctx: Ctx, x: number, cy: number, stage: number, marks: number, style: TrackStyle): void {
  const { pitch, dot, color, trim, alpha } = style;
  const first = trackMarkX(x, 0, style);
  const here = trackMarkX(x, stage, style);
  const last = trackMarkX(x, marks - 1, style);

  ctx.lineWidth = 1;
  ctx.lineCap = 'butt';
  if (stage < marks - 1) {
    ctx.strokeStyle = rgba(trim, 0.2 * alpha);
    ctx.beginPath();
    ctx.moveTo(here, cy);
    ctx.lineTo(last, cy);
    ctx.stroke();
  }
  if (stage > 0) {
    ctx.strokeStyle = rgba(color, 0.55 * alpha);
    ctx.beginPath();
    ctx.moveTo(first, cy);
    ctx.lineTo(here, cy);
    ctx.stroke();
  }
  for (let i = 0; i < marks; i++) {
    const cx = first + i * pitch;
    ctx.beginPath();
    if (i === stage) {
      ctx.fillStyle = rgba(color, alpha);
      ctx.arc(cx, cy, dot, 0, TAU);
    } else if (i < stage) {
      ctx.fillStyle = rgba(color, 0.7 * alpha);
      ctx.arc(cx, cy, dot * 0.6, 0, TAU);
    } else {
      ctx.fillStyle = rgba(trim, 0.34 * alpha);
      ctx.arc(cx, cy, dot * 0.5, 0, TAU);
    }
    ctx.fill();
  }
}

/**
 * An engine at work: a comet chasing its tail round the ring. It is the old
 * spinner (#262) with a tail that fades, which lets it turn slowly — a ring
 * this size spinning at the old speed would be the loudest thing on screen.
 */
export function drawComet(
  ctx: Ctx,
  cx: number,
  cy: number,
  r: number,
  angle: number,
  color: string,
  width: number,
  alpha: number,
): void {
  const tail = Math.PI * 1.45;
  const start = angle - tail;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  if (typeof ctx.createConicGradient === 'function') {
    const gradient = ctx.createConicGradient(start, cx, cy);
    const span = tail / TAU;
    gradient.addColorStop(0, rgba(color, 0));
    gradient.addColorStop(span * 0.5, rgba(color, 0.32 * alpha));
    gradient.addColorStop(span, rgba(color, alpha));
    gradient.addColorStop(Math.min(1, span + 0.02), rgba(color, 0));
    ctx.strokeStyle = gradient;
  } else {
    ctx.strokeStyle = rgba(color, 0.7 * alpha);
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, angle);
  ctx.stroke();

  // The head: a white-hot point with the work's color around it.
  const hx = cx + r * Math.cos(angle);
  const hy = cy + r * Math.sin(angle);
  const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, width * 3.2);
  halo.addColorStop(0, rgba(color, 0.7 * alpha));
  halo.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(hx, hy, width * 3.2, 0, TAU);
  ctx.fill();
  ctx.fillStyle = rgba('255,255,255', 0.92 * alpha);
  ctx.beginPath();
  ctx.arc(hx, hy, width * 0.62, 0, TAU);
  ctx.fill();
}

/** How open the review eye is at `t` seconds: open, with a blink now and then. */
export function eyeOpenness(t: number): number {
  const phase = t % 3.6;
  if (phase > 0.16) return 1;
  // Shut and open again inside 160 ms.
  return Math.max(0.12, Math.abs(phase - 0.08) / 0.08);
}

/** Which of a work's glyphs move, and so are drawn afresh every frame. */
export function glyphMoves(glyph: WorkGlyph | null): boolean {
  return glyph === 'checks' || glyph === 'eye';
}

export interface GlyphColors {
  /** The work's color, as an "r,g,b" triplet. */
  color: string;
  green: Rgb;
  coral: Rgb;
  alpha: number;
}

/**
 * The glyph at the end of a line of work, centred on (`cx`, `cy`) in a box
 * about 16 pixels square, as it looks `t` seconds in.
 */
export function drawGlyph(ctx: Ctx, glyph: WorkGlyph, cx: number, cy: number, t: number, colors: GlyphColors): void {
  const { color, alpha } = colors;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (glyph) {
    case 'engine': {
      // An engine was on it when the pills went dark (#268): the comet, stopped.
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = rgba(color, 0.28 * alpha);
      ctx.beginPath();
      ctx.arc(cx, cy, 5.6, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = rgba(color, alpha);
      ctx.beginPath();
      ctx.arc(cx, cy, 5.6, -Math.PI / 2, 0.2);
      ctx.stroke();
      return;
    }
    case 'checks': {
      // Its checks are running: three points in orbit, none of them an engine.
      const turn = (t / 2.4) * TAU;
      for (let i = 0; i < 3; i++) {
        const a = turn - i * (TAU / 3);
        ctx.fillStyle = rgba(color, alpha * (1 - i * 0.32));
        ctx.beginPath();
        ctx.arc(cx + 5.2 * Math.cos(a), cy + 5.2 * Math.sin(a), 1.7 - i * 0.25, 0, TAU);
        ctx.fill();
      }
      return;
    }
    case 'eye': {
      // Ready for review: an eye on it, blinking now and then.
      const open = eyeOpenness(t);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = rgba(color, alpha);
      ctx.beginPath();
      ctx.moveTo(cx - 7, cy);
      ctx.quadraticCurveTo(cx, cy - 7.2 * open, cx + 7, cy);
      ctx.quadraticCurveTo(cx, cy + 7.2 * open, cx - 7, cy);
      ctx.closePath();
      ctx.stroke();
      if (open > 0.5) {
        ctx.fillStyle = rgba(color, alpha);
        ctx.beginPath();
        ctx.arc(cx, cy, 2.1, 0, TAU);
        ctx.fill();
      }
      return;
    }
    case 'person': {
      // Manual: in a person's hands.
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = rgba(color, alpha);
      ctx.beginPath();
      ctx.arc(cx - 1, cy - 4.8, 2.1, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - 1, cy - 2.4);
      ctx.lineTo(cx - 1, cy + 2.4);
      ctx.lineTo(cx - 3.6, cy + 7);
      ctx.moveTo(cx - 1, cy + 2.4);
      ctx.lineTo(cx + 1.6, cy + 7);
      ctx.moveTo(cx - 1, cy - 0.6);
      ctx.lineTo(cx - 4.4, cy + 1.8);
      ctx.moveTo(cx - 1, cy - 0.6);
      ctx.lineTo(cx + 4.6, cy - 4.4);
      ctx.stroke();
      return;
    }
    case 'approved':
    case 'merged': {
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = glyph === 'approved' ? rgba(colors.green, alpha) : rgba(color, alpha);
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy + 0.4);
      ctx.lineTo(cx - 1.6, cy + 3.8);
      ctx.lineTo(cx + 5.2, cy - 3.8);
      ctx.stroke();
      return;
    }
    case 'failing': {
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = rgba(colors.coral, alpha);
      ctx.beginPath();
      ctx.moveTo(cx - 3.8, cy - 3.8);
      ctx.lineTo(cx + 3.8, cy + 3.8);
      ctx.moveTo(cx + 3.8, cy - 3.8);
      ctx.lineTo(cx - 3.8, cy + 3.8);
      ctx.stroke();
      return;
    }
    case 'blocked': {
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = rgba(colors.coral, 0.9 * alpha);
      ctx.beginPath();
      ctx.arc(cx, cy, 5.4, 0, TAU);
      ctx.moveTo(cx - 3.8, cy + 3.8);
      ctx.lineTo(cx + 3.8, cy - 3.8);
      ctx.stroke();
      return;
    }
  }
}
