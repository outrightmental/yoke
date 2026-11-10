import { LitElement, html, css } from 'lit';
import type { EventLine } from '../store/types.js';
import { formatLogTime } from '../shared/format.js';

export class EventStream extends LitElement {
  static override styles = css`
    :host { display: block; height: 100%; }

    .event-stream {
      height: 100%;
      overflow-y: auto;
      overflow-x: hidden;
    }

    .event-line {
      display: flex;
      align-items: flex-start;
      gap: 5px;
      padding: 2px 0;
      font-size: 10px;
      line-height: 1.5;
      animation: fadeIn 0.2s ease-in;
    }

    .event-dot {
      flex-shrink: 0;
      font-size: 7px;
      line-height: 16px;
      color: rgba(255, 255, 255, 0.2);
      width: 9px;
      text-align: center;
    }

    .event-time {
      flex-shrink: 0;
      color: rgba(255, 255, 255, 0.22);
      font-size: 9px;
      width: 54px;
    }

    .event-repo {
      flex-shrink: 0;
      color: rgba(255, 255, 255, 0.3);
      font-size: 9px;
      white-space: nowrap;
    }

    .event-content {
      flex: 1;
      color: rgba(255, 255, 255, 0.55);
      word-break: break-word;
      overflow: hidden;
    }

    /* A line with neither an engine's color nor a status color is trim, and
       so are the emoji the font draws in color on it (📍 📊 🔄) (#280). */
    .event-content.plain { filter: grayscale(1); }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateX(-4px); }
      to   { opacity: 1; transform: translateX(0); }
    }

    .event-stream::-webkit-scrollbar { width: 4px; }
    .event-stream::-webkit-scrollbar-thumb {
      background: rgba(var(--trim-rgb), 0.3);
      border-radius: 2px;
    }
  `;

  static override properties = {
    events: { type: Array },
    multiProject: { type: Boolean },
  };

  events: EventLine[] = [];
  multiProject = false;

  override updated() {
    const el = this.shadowRoot?.querySelector('.event-stream');
    if (el) el.scrollTop = el.scrollHeight;
  }

  override render() {
    return html`
      <div class="event-stream">
        ${this.events.map(line => {
          const contentStyle = this._contentStyle(line);
          return html`
          <div class="event-line">
            <span class="event-dot" style="${line.color ? `color:${line.color};text-shadow:0 0 5px ${line.color}` : ''}">●</span>
            <span class="event-time">${formatLogTime(line.atMs)}</span>
            ${this.multiProject && line.repo ? html`<span class="event-repo">${line.repo}</span>` : ''}
            <span class="event-content${contentStyle ? '' : ' plain'}" style="${contentStyle}">${line.text}</span>
          </div>
        `;
        })}
      </div>
    `;
  }

  private _contentStyle(line: EventLine): string {
    if (line.color) return `color:${line.color}`;
    if (line.level === 'error') return 'color:var(--color-red)';
    if (line.level === 'success') return 'color:var(--color-green)';
    if (line.level === 'warning') return 'color:var(--color-yellow)';
    return '';
  }
}

customElements.define('event-stream', EventStream);
