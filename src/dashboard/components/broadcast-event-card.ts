import { LitElement, html, css } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import type { BroadcastEventData } from '../store/types.js';
import { linkifyTextHtml } from '../shared/linkify.js';
import { NEUTRAL_COLOR } from '../shared/issue-colors.js';

/**
 * Monochrome glyph per action type (issue #236): the feed distinguishes types
 * of activity by shape and label, never by color — color is reserved for
 * connecting an event to its issue.
 */
export function eventGlyph(ev: Pick<BroadcastEventData, 'category' | 'label'>): string {
  switch (ev.label) {
    case 'NEW ISSUE':      return '◉';
    case 'ISSUE CLOSED':   return '⊘';
    case 'PR OPENED':      return '◆';
    case 'PR MERGED':
    case 'PR CLOSED':      return '◈';
    case 'WORKFLOW':       return '▶';
    case 'REVIEW COMMENT': return '✎';
    default: break;
  }
  switch (ev.category) {
    case 'issue':  return '◎';
    case 'pr':     return '◇';
    case 'commit': return '▪';
    case 'ci':     return '▲';
    default:       return '○';
  }
}

export class BroadcastEventCard extends LitElement {
  static override styles = css`
    :host { display: block; }

    .broadcast-event {
      padding: 12px 14px;
      margin: 8px 0;
      border-left: 3px solid var(--event-color, #8a8f98);
      border-radius: 2px;
      animation: broadcastEventEntry 0.9s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
      position: relative;
      overflow: hidden;
      cursor: default;
      font-family: 'IBM Plex Mono', monospace;
    }

    .broadcast-event-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }

    .broadcast-event-header-left {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .broadcast-event-glyph {
      display: inline-block;
      width: 14px;
      text-align: center;
      font-size: 12px;
      line-height: 1;
      color: rgba(255, 255, 255, 0.8);
      flex-shrink: 0;
    }

    .broadcast-event-type {
      font-weight: 700;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: rgba(255, 255, 255, 0.75);
    }

    .broadcast-event-issue-chip {
      font-size: 9px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 999px;
      border: 1px solid currentColor;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .broadcast-event-time {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.35);
      flex-shrink: 0;
    }

    .broadcast-event-project {
      font-size: 9px;
      color: rgba(255, 255, 255, 0.4);
      letter-spacing: 0.3px;
      white-space: nowrap;
    }

    .broadcast-event-flow {
      display: flex;
      flex-direction: column;
      gap: 3px;
      font-size: 11px;
      line-height: 1.5;
    }

    .broadcast-event-row {
      display: flex;
      align-items: baseline;
      gap: 6px;
      padding: 1px 0;
    }

    .broadcast-event-row.before-row { color: rgba(255, 255, 255, 0.45); }
    .broadcast-event-row.how-row { color: rgba(255, 255, 255, 0.6); padding-left: 4px; }
    .broadcast-event-row.after-row { color: #ffffff; font-weight: 600; }

    .broadcast-event-tag {
      display: inline-block;
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 1.5px;
      padding: 1px 4px;
      border-radius: 2px;
      flex-shrink: 0;
    }

    .broadcast-event-row.before-row .broadcast-event-tag {
      background: rgba(255, 255, 255, 0.08);
      color: rgba(255, 255, 255, 0.45);
    }

    .broadcast-event-row.how-row .broadcast-event-tag {
      background: rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.65);
      border: 1px solid rgba(255, 255, 255, 0.25);
    }

    .broadcast-event-row.after-row .broadcast-event-tag {
      background: rgba(255, 255, 255, 0.85);
      color: #000;
    }

    .broadcast-event-excellence {
      margin-top: 7px;
      padding-top: 5px;
      border-top: 1px solid rgba(255, 255, 255, 0.12);
      font-size: 10px;
      color: rgba(255, 255, 255, 0.55);
      font-style: italic;
      line-height: 1.4;
    }

    @keyframes broadcastEventEntry {
      0% { transform: translateX(50px) scale(0.88); opacity: 0; filter: brightness(4) blur(4px); }
      20% { transform: translateX(-6px) scale(1.05); opacity: 1; filter: brightness(2.5) blur(0); }
      55% { transform: translateX(2px) scale(1.01); filter: brightness(1.4); }
      100% { transform: translateX(0) scale(1); filter: brightness(1); }
    }

    a.gh-link { color: inherit; text-decoration: none; cursor: pointer; }
    a.gh-link:hover { text-decoration: underline; filter: brightness(1.4); }
  `;

  static override properties = {
    event: { type: Object },
    baseUrl: { type: String },
    multiProject: { type: Boolean },
  };

  event: BroadcastEventData | null = null;
  baseUrl = '';
  multiProject = false;

  override render() {
    const ev = this.event;
    if (!ev) return html``;

    // The card chrome is neutral gray; the issue's stable color appears only
    // when the event pertains to an issue (left border, faint wash, chip).
    const hasIssue = ev.issueNumber != null;
    const color = hasIssue ? ev.color : NEUTRAL_COLOR;
    const r = parseInt(color.slice(1, 3), 16) || 0;
    const g = parseInt(color.slice(3, 5), 16) || 0;
    const b = parseInt(color.slice(5, 7), 16) || 0;
    const ctx = { prNumber: ev.prNumber, issueNumber: ev.issueNumber, commitHash: ev.commitHash, runId: ev.runId };
    // Link feed text to the event's own project; fall back to the global base
    // URL in single-project mode.
    const baseUrl = ev.repo ? `https://github.com/${ev.repo}` : this.baseUrl;

    const cardStyle = `border-left-color:${color};background:rgba(${r},${g},${b},${hasIssue ? 0.07 : 0.04})`;

    return html`
      <div class="broadcast-event" style="${cardStyle}">
        <div class="broadcast-event-header">
          <div class="broadcast-event-header-left">
            <span class="broadcast-event-glyph">${eventGlyph(ev)}</span>
            <span class="broadcast-event-type">${ev.label || ev.category.toUpperCase()}</span>
            ${hasIssue ? html`
              <a
                class="gh-link broadcast-event-issue-chip"
                style="color:${color}"
                href="${baseUrl}/issues/${ev.issueNumber}"
                target="_blank" rel="noopener noreferrer"
              >#${ev.issueNumber}</a>
            ` : ''}
            ${this.multiProject && ev.repo ? html`<span class="broadcast-event-project">${ev.repo}</span>` : ''}
          </div>
          <span class="broadcast-event-time">${ev.time}</span>
        </div>
        <div class="broadcast-event-flow">
          <div class="broadcast-event-row before-row">
            <span class="broadcast-event-tag">WAS</span>
            <span>${unsafeHTML(linkifyTextHtml(ev.stateBefore, baseUrl, ctx))}</span>
          </div>
          <div class="broadcast-event-row how-row">
            <span class="broadcast-event-tag">HOW</span>
            <span>${unsafeHTML(linkifyTextHtml(ev.changeHow, baseUrl, ctx))}</span>
          </div>
          <div class="broadcast-event-row after-row">
            <span class="broadcast-event-tag">NOW</span>
            <span>${unsafeHTML(linkifyTextHtml(ev.stateAfter, baseUrl, ctx))}</span>
          </div>
        </div>
        ${ev.excellence ? html`
          <div class="broadcast-event-excellence">
            ✨ ${unsafeHTML(linkifyTextHtml(ev.excellence, baseUrl, ctx))}
          </div>
        ` : ''}
      </div>
    `;
  }
}

customElements.define('broadcast-event-card', BroadcastEventCard);
