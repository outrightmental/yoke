import { LitElement, html } from 'lit';
import { formatDuration } from '../shared/format.js';
import { usageGaugeView } from '../shared/usage-gauge.js';
import type { AccountUsage } from '../store/types.js';
import './keep-awake-light.js';

export class YokeHeader extends LitElement {
  static override properties = {
    owner: { type: String },
    repo: { type: String },
    title: { type: String },
    multiProject: { type: Boolean },
    projectCount: { type: Number },
    iteration: { type: Number },
    nextCycleAtMs: { type: Number },
    holdUntilMs: { type: Number },
    usage: { attribute: false },
    tick: { type: Number },
  };

  owner = '';
  repo = '';
  title = '';
  multiProject = false;
  projectCount = 0;
  iteration = 0;
  nextCycleAtMs: number | null = null;
  /** Deadline of a hold parking the whole pool, or null when work is free. */
  holdUntilMs: number | null = null;
  /** Latest Claude account usage reading, or null until the first arrives. */
  usage: AccountUsage | null = null;
  tick = 0;

  protected override createRenderRoot() { return this; }

  /**
   * What the header counts down to. A hold wins over the next-cycle timer:
   * showing "NEXT 1m" while every engine is parked for three hours is the
   * single most misleading thing the header can say.
   */
  private _countdown(): { label: string; value: string } | null {
    const target = this.holdUntilMs ?? this.nextCycleAtMs;
    if (target === null) return null;
    const ms = target - Date.now();
    if (ms <= 0) return null;
    return {
      label: this.holdUntilMs !== null ? 'WAITING' : 'NEXT',
      value: formatDuration(ms),
    };
  }

  override render() {
    // In multi-project mode there is no single repo, so link to the org (or
    // GitHub) and show how many projects share this dashboard.
    const baseUrl = this.multiProject
      ? `https://github.com/${this.owner || ''}`
      : `https://github.com/${this.owner}/${this.repo}`;
    const countdown = this._countdown();
    const gauge = usageGaugeView(this.usage, Date.now());
    const subtitle = this.multiProject && this.projectCount > 1
      ? `${this.projectCount} PROJECTS · AI SDLC BROADCAST`
      : 'AI SDLC BROADCAST';
    return html`
      <div class="header">
        <div>
          <div class="header-title">
            <a class="gh-link" href="${baseUrl}" target="_blank" rel="noopener noreferrer">⚡ ${(this.title || 'YOKE').toUpperCase()}</a>
            <span>${subtitle}</span>
          </div>
        </div>
        ${this.iteration > 0 ? html`
          <div class="iteration-info">
            <div class="iteration-label">CYCLE</div>
            <div class="iteration-number">${this.iteration}</div>
          </div>
        ` : ''}
        ${countdown !== null ? html`
          <div class="countdown state-waiting">
            <div class="countdown-label">${countdown.label}</div>
            <div class="countdown-timer">${countdown.value}</div>
          </div>
        ` : ''}
        <div class="usage-gauge tone-${gauge.tone}" title="${gauge.title}">
          <div class="usage-gauge-reading">
            <div class="usage-gauge-label">CLAUDE 5H</div>
            <div class="usage-gauge-row">
              <div class="usage-gauge-value">${gauge.percentText}</div>
              <div class="usage-gauge-meter">
                <div class="usage-gauge-fill" style="--usage-fill:${gauge.fillPercent}%"></div>
              </div>
            </div>
          </div>
          <div class="usage-gauge-reading">
            <div class="usage-gauge-label">RESETS IN</div>
            <div class="usage-gauge-value">${gauge.resetText}</div>
          </div>
        </div>
        <keep-awake-light></keep-awake-light>
      </div>
    `;
  }
}

customElements.define('yoke-header', YokeHeader);
