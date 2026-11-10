/**
 * A critically damped spring: the fastest way for a value to reach a target
 * without overshooting it. Everything that moves on the field moves on one —
 * a piece of work rising a stratum, an engine's ring swinging out to it — so
 * that a change of state reads as one thing going somewhere, not as one thing
 * vanishing and another appearing.
 *
 * It is stepped with the closed-form solution rather than by integrating the
 * force, so it lands in the same place whatever the frame rate, and a tab that
 * was in the background for a minute cannot make it explode: a long step just
 * arrives.
 */
export interface Spring {
  value: number;
  velocity: number;
  target: number;
}

export function spring(value: number): Spring {
  return { value, velocity: 0, target: value };
}

/** How stiff the field's springs are, as an angular frequency (rad/s): about
 *  a third of a second to cover most of the way, and half a second to settle. */
export const SPRING_OMEGA = 16;

/** Closer to its target than this, and slower than this per second, a spring
 *  has arrived. In CSS pixels, so well under what a screen can show. */
const REST_DISTANCE = 0.05;
const REST_SPEED = 0.5;

/** Advance `s` by `dt` seconds. Returns true while it is still moving. */
export function stepSpring(s: Spring, dt: number, omega = SPRING_OMEGA): boolean {
  const offset = s.value - s.target;
  if (Math.abs(offset) < REST_DISTANCE && Math.abs(s.velocity) < REST_SPEED) {
    s.value = s.target;
    s.velocity = 0;
    return false;
  }
  if (dt <= 0) return true;
  // x(t) = target + (offset + (v + ω·offset)·t)·e^(−ωt)
  const decay = Math.exp(-omega * dt);
  const drift = s.velocity + omega * offset;
  s.value = s.target + (offset + drift * dt) * decay;
  s.velocity = (s.velocity - drift * omega * dt) * decay;
  return true;
}

/** Put `s` at its target at once, as when motion is turned off. */
export function settleSpring(s: Spring): void {
  s.value = s.target;
  s.velocity = 0;
}
