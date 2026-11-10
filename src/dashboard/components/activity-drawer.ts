import { LitElement, html } from 'lit';
import type { BroadcastEventData, EventLine } from '../store/types.js';
import './broadcast-event-card.js';
import './event-stream.js';

/**
 * The activity drawer: the whole event log and the feed of GitHub activity,
 * for when the few lines along the bottom of the field are not enough.
 *
 * They used to be two panels that were always on screen, a quarter of it
 * between them, for something read a few times a day. Now they are out of
 * the way until asked for — by the Log button at the foot of the inbox, or a
 * tap on the lines along the bottom of the field — and take the room they
 * need when they are.
 */
export class ActivityDrawer extends LitElement {
  static override properties = {
    open: { type: Boolean },
    events: { attribute: false },
    feed: { attribute: false },
    baseUrl: { type: String },
    multiProject: { type: Boolean },
    eventCount: { type: Number },
    sessionCount: { type: Number },
  };

  open = false;
  events: EventLine[] = [];
  feed: BroadcastEventData[] = [];
  baseUrl = '';
  multiProject = false;
  eventCount = 0;
  sessionCount = 0;

  protected override createRenderRoot() { return this; }

  private _close() {
    this.dispatchEvent(new CustomEvent('drawer-close', { bubbles: true, composed: true }));
  }

  private _onKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') this._close();
  }

  override render() {
    const sessions = `${this.sessionCount} session${this.sessionCount === 1 ? '' : 's'}`;
    const events = `${this.eventCount} event${this.eventCount === 1 ? '' : 's'}`;
    // Closed, it is not rendered at all: a log nobody is reading is not worth
    // laying out three hundred lines for on every event.
    return html`
      <section
        class="drawer${this.open ? ' is-open' : ''}"
        aria-label="Activity"
        aria-hidden="${this.open ? 'false' : 'true'}"
        @keydown=${(event: KeyboardEvent) => this._onKeyDown(event)}
      >
        <header class="drawer-head">
          <h2 class="drawer-title">Activity</h2>
          <span class="drawer-counts">${events} · ${sessions}</span>
          <button class="drawer-close" type="button" @click=${() => this._close()}>Close</button>
        </header>
        ${this.open ? html`
          <div class="drawer-body">
            <div class="drawer-log">
              <h3 class="drawer-heading">Event log</h3>
              <event-stream .events=${this.events} .multiProject=${this.multiProject}></event-stream>
            </div>
            <div class="drawer-feed">
              <h3 class="drawer-heading">GitHub activity</h3>
              <div class="drawer-feed-list">
                ${this.feed.length === 0
                  ? html`<p class="drawer-empty">Nothing yet.</p>`
                  : this.feed.map((event) => html`
                    <broadcast-event-card
                      .event=${event}
                      .baseUrl=${this.baseUrl}
                      .multiProject=${this.multiProject}
                    ></broadcast-event-card>`)}
              </div>
            </div>
          </div>` : ''}
      </section>
    `;
  }
}

customElements.define('activity-drawer', ActivityDrawer);
