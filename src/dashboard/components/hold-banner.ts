import { LitElement, html } from 'lit';
import type { WorkHold } from '../store/types.js';
import { formatClockTime, formatDuration } from '../shared/format.js';

/**
 * Full-width banner for a hold that has parked the whole pool.
 *
 * During a usage-limit hold every cylinder reports itself idle, which on the
 * dashboard was indistinguishable from a quiet run with nothing to do — the
 * only hint was `rate limited · …` in one cylinder's status line. This says
 * what is being waited on, how long is left, and when it ends, loudly enough
 * that nobody has to go looking for it.
 */
export class HoldBanner extends LitElement {
  static override properties = {
    hold: { attribute: false },
    tick: { type: Number },
  };

  hold: WorkHold | null = null;
  tick = 0;

  protected override createRenderRoot() { return this; }

  override render() {
    const hold = this.hold;
    if (!hold) return html``;
    const remainingMs = hold.untilMs - Date.now();
    if (remainingMs <= 0) return html``;

    return html`
      <div class="hold-banner" role="status">
        <div class="hold-banner-icon">⏸</div>
        <div class="hold-banner-text">
          <div class="hold-banner-headline">
            WAITING <span class="hold-banner-duration">${formatDuration(remainingMs)}</span>
            UNTIL <span class="hold-banner-deadline">${formatClockTime(hold.untilMs)}</span>
          </div>
          <div class="hold-banner-reason">
            for ${hold.reason} · no work is planned or started until then
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('hold-banner', HoldBanner);
