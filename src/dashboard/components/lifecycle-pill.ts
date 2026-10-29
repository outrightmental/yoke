import { LitElement, html, css, type TemplateResult } from 'lit';
import type { LifecyclePair, PullRequestApprovalStatus } from '../store/types.js';
import type { PillActivity } from '../shared/pill-activity.js';
import {
  approvalView,
  approveControl,
  approveKey,
  pairApproveTarget,
  type ApprovalView,
  type ApproveClick,
  type ApproveTarget,
} from '../shared/pill-approval.js';

/** The status icon and its tooltip for each pill activity (issue #262). */
const STATUS_ICONS: Record<PillActivity, { title: string; icon: TemplateResult }> = {
  'working': {
    title: 'An engine is working on this',
    icon: html`<span class="meteor"></span>`,
  },
  'waiting-ci': {
    title: 'Waiting for GitHub Actions to finish',
    icon: html`
      <svg viewBox="0 0 18 18" aria-hidden="true">
        <g class="hourglass">
          <path d="M4 2h10M4 16h10M5 2c0 4 3.2 5 3.2 7s-3.2 3-3.2 7M13 2c0 4-3.2 5-3.2 7s3.2 3 3.2 7"/>
          <path class="solid sand-top" d="M6.2 3.5h5.6L9 7z"/>
          <path class="solid sand-bottom" d="M6.2 14.5h5.6L9 11z"/>
        </g>
      </svg>`,
  },
  'review': {
    title: 'Ready for review',
    icon: html`
      <svg viewBox="0 0 18 18" aria-hidden="true">
        <g class="eye">
          <path d="M1.5 9C3.5 5.3 6 3.5 9 3.5s5.5 1.8 7.5 5.5c-2 3.7-4.5 5.5-7.5 5.5S3.5 12.7 1.5 9z"/>
          <circle class="solid pupil" cx="9" cy="9" r="2.4"/>
        </g>
      </svg>`,
  },
  'manual': {
    title: 'Manual — yoke will not work on this',
    icon: html`
      <svg viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="7" cy="4" r="2"/>
        <path d="M7 6.5v5M7 11.5L5 16M7 11.5L9 16M7 8l-3 2.5"/>
        <path class="waving-arm" d="M7 8l4.5-3.5"/>
      </svg>`,
  },
};

export class LifecyclePill extends LitElement {
  static override styles = css`
    :host { display: block; }

    .lifecycle-pill {
      position: relative;
      display: flex;
      height: 52px;
      width: 100%;
      min-width: 380px;
      animation: pillAppear 0.4s cubic-bezier(0.34, 1.3, 0.64, 1);
      transition: opacity 0.5s ease;
    }

    /* Fades in to the pill's own opacity, so a dimmed pill doesn't flash to
       full opacity first. */
    @keyframes pillAppear {
      from { opacity: 0; transform: scaleX(0.85); }
      to   { transform: scaleX(1); }
    }

    /* Every pill no engine cylinder is working right now is dimmed, whatever
       its phase or status icon, so the worked ones stand out by contrast
       (issue #262). Same test as the border pulse below. */
    .lifecycle-pill:not(.working) {
      opacity: 0.55;
    }

    .pill-issue-half {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 0 16px;
      border: 2px solid var(--pill-color);
      border-right: none;
      border-radius: 999px 0 0 999px;
      background: rgba(var(--pill-rgb), 0.1);
      min-width: 0;
      overflow: hidden;
    }

    .pill-issue-half.empty {
      background: rgba(var(--pill-rgb), 0.04);
    }

    .pill-pr-half {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 0 16px;
      border-radius: 0 999px 999px 0;
      transition: background 0.5s ease, opacity 0.5s ease;
      min-width: 0;
      overflow: hidden;
      position: relative;
    }

    .pill-pr-half.absent {
      border: 2px dashed rgba(128, 128, 128, 0.2);
      opacity: 0.35;
    }

    .pill-pr-half.planning {
      border: 2px dashed var(--pill-color);
      background: transparent;
      animation: planningPulse 1.8s ease-in-out infinite;
    }

    @keyframes planningPulse {
      0%, 100% { opacity: 0.5; }
      50%       { opacity: 1; }
    }

    .pill-pr-half.review {
      border: 2px solid var(--pill-color);
      border-left: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(var(--pill-rgb), 0.25);
      box-shadow: 0 0 10px rgba(var(--pill-rgb), 0.35);
    }

    .pill-pr-half.active {
      border: 2px solid var(--pill-color);
      border-left: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(var(--pill-rgb), 0.14);
    }

    .pill-pr-half.inactive {
      border: 2px dashed rgba(120, 120, 135, 0.4);
      opacity: 0.55;
    }

    .pill-pr-half.completed {
      border: 2px solid var(--pill-color);
      border-left: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(var(--pill-rgb), 0.38);
      box-shadow: inset 0 0 14px rgba(var(--pill-rgb), 0.2);
    }

    .pill-pr-half.disabled {
      border: 2px dashed rgba(150, 150, 160, 0.4);
      background: rgba(150, 150, 160, 0.06);
      box-shadow: none;
      opacity: 0.45;
      filter: grayscale(1);
      animation: none;
    }

    .pill-pr-half.absent.blocked {
      border: 2px dashed rgba(255, 100, 80, 0.35);
      opacity: 0.75;
    }

    /* An engine cylinder is working this pill right now (issue #262): its
       border pulses brighter and darker, on the implementing… pulse's beat but
       never dimming as far. Only the border color moves, so each phase's
       dashed/solid style, fill and seam stay as they are; the PR half's gray
       borders (absent, inactive, blocked, manual) are left alone. */
    .lifecycle-pill.working .pill-issue-half {
      animation: workingBorder 1.8s ease-in-out infinite;
    }

    .lifecycle-pill.working .pill-pr-half.planning {
      animation:
        planningPulse 1.8s ease-in-out infinite,
        workingBorder 1.8s ease-in-out infinite;
    }

    .lifecycle-pill.working .pill-pr-half:is(.review, .active, .completed):not(.disabled) {
      animation: workingBorderOuter 1.8s ease-in-out infinite;
    }

    @keyframes workingBorder {
      0%, 100% { border-color: rgba(var(--pill-rgb), 0.7); }
      50%       { border-color: color-mix(in srgb, var(--pill-color), white 40%); }
    }

    /* The same pulse for a PR half with a seam on its left: it keeps the seam. */
    @keyframes workingBorderOuter {
      0%, 100% {
        border-top-color: rgba(var(--pill-rgb), 0.7);
        border-right-color: rgba(var(--pill-rgb), 0.7);
        border-bottom-color: rgba(var(--pill-rgb), 0.7);
      }
      50% {
        border-top-color: color-mix(in srgb, var(--pill-color), white 40%);
        border-right-color: color-mix(in srgb, var(--pill-color), white 40%);
        border-bottom-color: color-mix(in srgb, var(--pill-color), white 40%);
      }
    }

    /* Yoke is shutting down (issue #268): every pill goes dark like the
       shut-down cylinder row — dimmed, with its orange accent on the left
       edge — and every pulse stops. The status icon stays, frozen in place. */
    .lifecycle-pill.shutdown { opacity: 0.5; }

    .lifecycle-pill.shutdown .pill-issue-half { border-left-color: #ff6600; }

    .lifecycle-pill.shutdown .pill-issue-half,
    .lifecycle-pill.shutdown .pill-pr-half { animation: none; }

    .lifecycle-pill.shutdown .pill-status,
    .lifecycle-pill.shutdown .pill-status * { animation-play-state: paused; }

    .pill-label {
      font-size: 8px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--pill-color);
      opacity: 0.6;
      white-space: nowrap;
    }

    /* What a dashboard approval is doing, or why it did not go through (#276),
       on the PR half's label line: "PR · not approved: its checks are
       failing". Visible without hovering, cut short with an ellipsis rather
       than ever widening the half, and kept clear of the button and icon laid
       over the half, like the row below it. */
    .pill-pr-half .pill-label {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .pill-pr-half .pill-label.has-line { opacity: 0.9; }

    .lifecycle-pill.has-status .pill-pr-half .pill-label { padding-right: 24px; }
    .lifecycle-pill.has-approve .pill-pr-half .pill-label { padding-right: 64px; }
    .lifecycle-pill.has-approve.has-status .pill-pr-half .pill-label { padding-right: 88px; }

    .pill-approval-line {
      text-transform: none;
      letter-spacing: 0.3px;
    }

    .pill-approval-line.approved { color: #00ff88; }

    .pill-approval-line.problem { color: rgba(255, 130, 110, 1); }

    .pill-row {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .pill-number {
      font-size: 11px;
      font-weight: 700;
      color: var(--pill-color);
      white-space: nowrap;
    }

    .pill-title {
      font-size: 10px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: rgba(255, 255, 255, 0.75);
    }

    .pill-badge {
      font-size: 8px;
      padding: 1px 5px;
      border-radius: 999px;
      border: 1px solid var(--pill-color);
      color: var(--pill-color);
      opacity: 0.7;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .pill-badge-blocked {
      border-color: rgba(255, 100, 80, 0.7);
      color: rgba(255, 130, 110, 1);
    }

    .pill-badge-inactive {
      border-color: rgba(160, 160, 175, 0.55);
      color: rgba(185, 185, 200, 0.85);
    }

    .pill-project {
      font-size: 8px;
      color: rgba(255, 255, 255, 0.4);
      letter-spacing: 0.3px;
      white-space: nowrap;
      flex-shrink: 0;
      margin-left: auto;
      padding-left: 6px;
    }

    a.gh-link { color: inherit; text-decoration: none; cursor: pointer; }
    a.gh-link:hover { text-decoration: underline; filter: brightness(1.4); }

    /* The animated status icon at the pill's far right (issue #262), sized
       like the engine cylinder's spinner. It sits over the PR half rather than
       inside it, so a manual PR's greyed-out half doesn't grey it out too. The
       room for it is kept inside the PR half's row, not its padding, so both
       halves stay the same width and the seams of all pills line up. */
    .lifecycle-pill.has-status .pill-pr-half .pill-row { padding-right: 24px; }

    .pill-status {
      position: absolute;
      right: 14px;
      top: 50%;
      width: 18px;
      height: 18px;
      margin-top: -9px;
      color: var(--pill-color);
    }

    .pill-status svg {
      display: block;
      width: 18px;
      height: 18px;
      overflow: visible;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.6;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .pill-status .solid { fill: currentColor; stroke: none; }

    /* Working: the engine cylinder's meteor chasing its tail. */
    .pill-status .meteor {
      display: block;
      box-sizing: border-box;
      width: 18px;
      height: 18px;
      border: 2px solid rgba(var(--pill-rgb), 0.2);
      border-top-color: var(--pill-color);
      border-radius: 50%;
      animation: statusSpin 0.8s linear infinite;
    }

    @keyframes statusSpin {
      0%   { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    /* Waiting on GitHub Actions: an hourglass whose sand runs out, then flips. */
    .pill-status .hourglass { transform-origin: 9px 9px; animation: hourglassFlip 2.4s ease-in-out infinite; }
    .pill-status .sand-top { transform-origin: 9px 7px; animation: sandTop 2.4s linear infinite; }
    .pill-status .sand-bottom { transform-origin: 9px 15px; animation: sandBottom 2.4s linear infinite; }

    @keyframes hourglassFlip {
      0%, 75% { transform: rotate(0deg); }
      100%     { transform: rotate(180deg); }
    }

    @keyframes sandTop {
      0%        { transform: scale(1); }
      75%, 100% { transform: scale(0); }
    }

    @keyframes sandBottom {
      0%        { transform: scale(0); }
      75%, 100% { transform: scale(1); }
    }

    /* Ready for review: an eye glancing over the PR, blinking now and then. */
    .pill-status .eye { transform-origin: 9px 9px; animation: eyeBlink 3.2s ease-in-out infinite; }
    .pill-status .pupil { animation: eyeGlance 3.2s ease-in-out infinite; }

    @keyframes eyeBlink {
      0%, 90%, 100% { transform: scaleY(1); }
      95%            { transform: scaleY(0.1); }
    }

    @keyframes eyeGlance {
      0%, 10%, 85%, 100% { transform: translateX(0); }
      25%, 40%           { transform: translateX(-2px); }
      55%, 70%           { transform: translateX(2px); }
    }

    /* Manual: a person waving — this one is in human hands. */
    .pill-status .waving-arm { transform-origin: 7px 8px; animation: armWave 2s ease-in-out infinite; }

    @keyframes armWave {
      0%, 60%, 100% { transform: rotate(0deg); }
      15%, 45%      { transform: rotate(-25deg); }
      30%           { transform: rotate(10deg); }
    }

    /* The Approve button on a PR parked by the review label (#274), in the
       engine cylinder's Cancel-button style but green. Like the status icon it
       sits over the PR half, just left of the icon, with the room for it kept
       inside the PR half's row — so both halves stay the same width and the
       seams of all pills line up. It is the same width in every step —
       Approve, Confirm, Sending, Approving — so arming, sending and following
       yoke's answer never move anything; anything longer goes on the PR
       half's label line (#276). */
    .lifecycle-pill.has-approve .pill-pr-half .pill-row { padding-right: 64px; }
    .lifecycle-pill.has-approve.has-status .pill-pr-half .pill-row { padding-right: 88px; }

    .pill-approve {
      position: absolute;
      right: 14px;
      top: 50%;
      width: 60px;
      margin-top: -9px;
      box-sizing: border-box;
      background: transparent;
      border: 1px solid rgba(0, 255, 136, 0.45);
      color: rgba(0, 255, 136, 0.85);
      font-family: 'IBM Plex Mono', monospace;
      font-size: 9px;
      font-weight: 600;
      line-height: 16px;
      letter-spacing: 0.5px;
      padding: 0;
      text-align: center;
      text-transform: uppercase;
      white-space: nowrap;
      cursor: pointer;
      border-radius: 2px;
      transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
    }

    .lifecycle-pill.has-status .pill-approve { right: 38px; }

    .pill-approve:hover:not(:disabled),
    .pill-approve.confirm {
      background: rgba(0, 255, 136, 0.15);
      border-color: #00ff88;
      color: #00ff88;
    }

    .pill-approve.confirm { box-shadow: 0 0 8px rgba(0, 255, 136, 0.45); }

    .pill-approve:disabled { cursor: not-allowed; }

    /* Greyed out only when it cannot be pressed (failing checks): while
       yoke has the approval in hand it stays green, Approving pulsing. */
    .pill-approve:disabled:not(.sending):not(.approving) {
      border-color: rgba(255, 255, 255, 0.2);
      color: rgba(255, 255, 255, 0.35);
    }

    .pill-approve.approving { animation: approvingPulse 1.8s ease-in-out infinite; }

    @keyframes approvingPulse {
      0%, 100% { opacity: 0.6; }
      50%       { opacity: 1; }
    }
  `;

  static override properties = {
    pair: { type: Object },
    color: { type: String },
    colorRgb: { type: String },
    owner: { type: String },
    repo: { type: String },
    multiProject: { type: Boolean },
    activity: { type: String },
    dark: { type: Boolean },
    approvalStatus: { attribute: false },
    _approveClick: { state: true },
  };

  pair: LifecyclePair | null = null;
  color = '#555577';
  colorRgb = '85,85,119';
  /** What this pill is doing or waiting on right now, if anything. */
  activity: PillActivity | null = null;
  /** Yoke is shutting down, so this pill has gone dark (issue #268). */
  dark = false;
  owner = '';
  repo = '';
  multiProject = false;
  /** Yoke's latest word on a dashboard approval of this pill's PR (#276), if
   *  any: this page's own, another dashboard's, or one replayed on load. */
  approvalStatus: PullRequestApprovalStatus | null = null;
  /** This pill's latest Approve click, if any. Keyed by PR, because the list
   *  reuses pill elements as pills move, so it never carries over to a
   *  different PR. */
  private _approveClick: ApproveClick | null = null;
  /** Re-renders the pill when its approval view next changes on its own. */
  private _approveTimer: ReturnType<typeof setTimeout> | null = null;
  private _approveRefreshAtMs: number | null = null;

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._approveClick = null;
    this._clearApproveTimer();
  }

  override updated() {
    // After every render: wake again when the view changes with nothing new
    // arriving — the confirm window lapsing, no answer coming, an outcome
    // going stale.
    this._clearApproveTimer();
    const refreshAtMs = this._approveRefreshAtMs;
    if (refreshAtMs !== null && this.isConnected) {
      this._approveTimer = setTimeout(() => this.requestUpdate(), Math.max(0, refreshAtMs - Date.now()) + 50);
    }
  }

  private _clearApproveTimer() {
    if (this._approveTimer !== null) clearTimeout(this._approveTimer);
    this._approveTimer = null;
  }

  /** What this pill shows of its PR's approval right now. */
  private _approvalView(pair: LifecyclePair): ApprovalView {
    return approvalView({
      target: pairApproveTarget(pair),
      control: approveControl(pair, this.activity, this.dark),
      status: this.approvalStatus,
      click: this._approveClick,
      nowMs: Date.now(),
    });
  }

  /** First click arms the button; only a second click within a few seconds
   *  approves — the dashboard often hangs on a wall within reach of passers-by.
   *  After that the pill follows yoke's answer. */
  private _onApproveClick(event: Event, target: ApproveTarget) {
    event.stopPropagation();
    const pair = this.pair;
    if (!pair) return;
    const button = this._approvalView(pair).button;
    if (!button || button.disabled) return;
    const key = approveKey(target);
    if (button.step !== 'confirm') {
      this._approveClick = { key, step: 'confirm', atMs: Date.now() };
      return;
    }
    // The app cancels the event when it could not send the request (no live
    // connection): the pill says so rather than read as sent.
    const sent = this.dispatchEvent(new CustomEvent<ApproveTarget>('pill-approve', {
      detail: target,
      bubbles: true,
      composed: true,
      cancelable: true,
    }));
    this._approveClick = { key, step: sent ? 'sent' : 'unsent', atMs: Date.now() };
  }

  private _approveButton(view: ApprovalView, target: ApproveTarget | null) {
    const button = view.button;
    if (!button || !target) return '';
    const stepClass = button.step === 'idle' ? '' : ` ${button.step}`;
    return html`<button
      class="pill-approve${stepClass}"
      type="button"
      title="${button.title}"
      aria-label="${button.title}"
      ?disabled=${button.disabled}
      @click=${(event: Event) => this._onApproveClick(event, target)}
    >${button.label}</button>`;
  }

  /** The PR half's label, with the approval's line after it when there is one.
   *  The line's live region is always there, so a screen reader announces
   *  each change to it. */
  private _prLabel(view: ApprovalView) {
    const line = view.line;
    return html`<div class="pill-label${line ? ' has-line' : ''}" title="${line ? `PR · ${line.text}` : ''}">PR<span
      class="pill-approval-line${line ? ` ${line.tone}` : ''}"
      role="status"
      aria-live="polite"
    >${line ? ` · ${line.text}` : ''}</span></div>`;
  }

  /** GitHub base URL for this pill: the pair's own repo, else the global one. */
  private _baseUrl(): string {
    return `https://github.com/${this.pair?.repo ?? `${this.owner}/${this.repo}`}`;
  }

  private _prHalf(view: ApprovalView) {
    const pair = this.pair!;
    const baseUrl = this._baseUrl();
    const isBlocked = (pair.blockedByIssueNumbers?.length ?? 0) > 0;
    const prClass = `pill-pr-half ${pair.prPhase ?? 'absent'}${isBlocked ? ' blocked' : ''}${pair.disabled ? ' disabled' : ''}`;

    if (!pair.pr) {
      if (pair.prPhase === 'planning') {
        return html`
          <div class="${prClass}">
            <div class="pill-label">PR</div>
            <div class="pill-row"><span class="pill-title">${this.dark ? 'shut down' : 'implementing…'}</span></div>
          </div>`;
      }
      if (pair.prPhase === 'inactive' && pair.projectStatus) {
        return html`
          <div class="${prClass}">
            <div class="pill-label">Status</div>
            <div class="pill-row"><span class="pill-badge pill-badge-inactive">${pair.projectStatus}</span></div>
          </div>`;
      }
      if (isBlocked) {
        return html`
          <div class="${prClass}">
            <div class="pill-label">Blocked by</div>
            <div class="pill-row">
              ${(pair.blockedByIssueNumbers ?? []).map(n => html`
                <span class="pill-badge pill-badge-blocked">
                  <a class="gh-link" href="${baseUrl}/issues/${n}" target="_blank" rel="noopener noreferrer">#${n}</a>
                </span>
              `)}
            </div>
          </div>`;
      }
      return html`
        <div class="${prClass}">
          <div class="pill-label">PR</div>
          <div class="pill-row"><span class="pill-title">—</span></div>
        </div>`;
    }

    const pr = pair.pr;
    const prUrl = `${baseUrl}/pull/${pr.number}`;
    const badges: string[] = [];
    if (pair.disabled) badges.push('MANUAL');
    if (pr.draft) badges.push('DRAFT');
    if (pair.prPhase === 'review') badges.push(pair.approval === 'approved' || view.approved ? 'APPROVED' : 'READY');
    if (pair.prPhase === 'completed') badges.push('MERGED');
    const checksIcon = pr.checksStatus === 'success' ? '✓' : pr.checksStatus === 'failure' ? '✗' : pr.checksStatus === 'pending' ? '…' : '';
    if (checksIcon) badges.push(checksIcon);

    return html`
      <div class="${prClass}">
        ${this._prLabel(view)}
        <div class="pill-row">
          <span class="pill-number"><a class="gh-link" href="${prUrl}" target="_blank" rel="noopener noreferrer">#${pr.number}</a></span>
          ${badges.map(b => html`<span class="pill-badge">${b}</span>`)}
          <span class="pill-title">${pr.title}</span>
        </div>
      </div>`;
  }

  /** The animated icon at the pill's far right; nothing when there's no activity. */
  private _statusIcon() {
    if (!this.activity) return '';
    const { title, icon } = STATUS_ICONS[this.activity];
    return html`<span class="pill-status ${this.activity}" role="img" title="${title}" aria-label="${title}">${icon}</span>`;
  }

  override render() {
    const pair = this.pair;
    if (!pair) return html``;

    const baseUrl = this._baseUrl();
    const style = `--pill-color:${this.color};--pill-rgb:${this.colorRgb};--pill-glow:rgba(${this.colorRgb},0.3)`;
    const projectChip = this.multiProject && pair.repo
      ? html`<span class="pill-project">${pair.repo}</span>`
      : '';
    const stateClass = this.dark ? ' shutdown' : this.activity === 'working' ? ' working' : '';
    const view = this._approvalView(pair);
    this._approveRefreshAtMs = view.refreshAtMs;
    const target = pairApproveTarget(pair);
    const pillClass = `lifecycle-pill${stateClass}${this.activity ? ' has-status' : ''}${view.button ? ' has-approve' : ''}`;

    if (!pair.issue) {
      return html`
        <div class="${pillClass}" style="${style}">
          <div class="pill-issue-half empty">${projectChip}</div>
          ${this._prHalf(view)}
          ${this._approveButton(view, target)}
          ${this._statusIcon()}
        </div>`;
    }

    const issue = pair.issue;
    const issueUrl = `${baseUrl}/issues/${issue.number}`;
    return html`
      <div class="${pillClass}" style="${style}">
        <div class="pill-issue-half">
          <div class="pill-label">Issue</div>
          <div class="pill-row">
            <span class="pill-number">
              <a class="gh-link" href="${issueUrl}" target="_blank" rel="noopener noreferrer">#${issue.number}</a>
            </span>
            <span class="pill-badge">${issue.state.toUpperCase()}</span>
            <span class="pill-title">${issue.title}</span>
            ${projectChip}
          </div>
        </div>
        ${this._prHalf(view)}
        ${this._approveButton(view, target)}
        ${this._statusIcon()}
      </div>`;
  }
}

customElements.define('lifecycle-pill', LifecyclePill);
