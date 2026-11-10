import { LitElement, html } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import type { Point } from '../field/geometry.js';
import { INSPECTOR_CARD_ID } from '../field/model.js';
import { cardsToShield, type InboxAction, type InboxCard, type InboxLink, type Inspection } from '../shared/inbox.js';
import type { ApproveTarget } from '../shared/pill-approval.js';

/**
 * How long a button is deaf after its card arrives or moves. One press of
 * Approve merges a pull request (#278), so the list must never be the thing
 * that chose which: when a card above leaves and the next slides up under a
 * finger already on its way down, that press lands on nothing.
 */
export const TAP_SHIELD_MS = 600;

/**
 * The inbox: every interaction the dashboard offers, down the right-hand edge
 * of the screen, top to bottom — where the hand of someone using a touch
 * screen right-handed already is, and where reaching for it never puts an arm
 * across the picture.
 *
 * It only draws cards; what cards there are is `buildInbox`'s business. Every
 * target on it is sized for a finger, and nothing on it depends on hovering.
 */
export class YokeInbox extends LitElement {
  static override properties = {
    cards: { attribute: false },
    inspection: { attribute: false },
    selectedCardId: { type: String },
    multiProject: { type: Boolean },
    open: { type: Boolean },
    overlay: { type: Boolean },
    logOpen: { type: Boolean },
  };

  /** The cards, top to bottom (`buildInbox`). */
  cards: InboxCard[] = [];
  /** What was tapped on the field, to say more about; null for nothing. */
  inspection: Inspection | null = null;
  /** The card about the work picked out on the field, if one of them is. */
  selectedCardId: string | null = null;
  multiProject = false;
  /** Whether the rail is drawn at its full width, with its cards showing. */
  open = false;
  /** Whether the open rail lies over the field, as on a narrow screen, rather than beside it. */
  overlay = false;
  logOpen = false;

  /** Where each card sat when last drawn, and until when its button is deaf. */
  private _tops = new Map<string, number>();
  private _shieldUntil = new Map<string, number>();
  private _anchorsKey = '';
  private _resizeObserver: ResizeObserver | null = null;

  protected override createRenderRoot() { return this; }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
  }

  protected override firstUpdated() {
    this._resizeObserver = new ResizeObserver(() => this._reportAnchors());
    this._resizeObserver.observe(this);
  }

  protected override updated(changed: Map<string, unknown>) {
    this._shieldMoved();
    this._reportAnchors();
    if (changed.has('selectedCardId') && this.selectedCardId) this._reveal(this.selectedCardId);
  }

  /**
   * Bring a card into view by scrolling the list, and only the list. Not
   * `scrollIntoView`: that scrolls every box it can on the way up, and the
   * page itself must never move.
   */
  private _reveal(cardId: string) {
    const list = this.querySelector<HTMLElement>('.inbox-list');
    const card = list?.querySelector<HTMLElement>(`[data-card="${CSS.escape(cardId)}"]`);
    if (!list || !card) return;
    const top = card.offsetTop;
    const bottom = top + card.offsetHeight;
    let target = list.scrollTop;
    if (top < list.scrollTop) target = top - 8;
    else if (bottom > list.scrollTop + list.clientHeight) target = bottom - list.clientHeight + 8;
    if (target !== list.scrollTop) list.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }

  /** Make the button of every card that has just arrived or moved deaf for a moment. */
  private _shieldMoved() {
    const now = performance.now();
    const tops = new Map<string, number>();
    for (const element of this.querySelectorAll<HTMLElement>('.inbox-list [data-card]')) {
      tops.set(element.dataset['card']!, element.offsetTop);
    }
    for (const id of cardsToShield(this._tops, tops)) this._shieldUntil.set(id, now + TAP_SHIELD_MS);
    for (const id of this._shieldUntil.keys()) {
      if (!tops.has(id)) this._shieldUntil.delete(id);
    }
    this._tops = tops;
  }

  private _shielded(id: string): boolean {
    return performance.now() < (this._shieldUntil.get(id) ?? 0);
  }

  /**
   * Tell the field where each card is, so it can draw the line from a piece of
   * work to the card about it: the point on the card's left edge, in the
   * window's coordinates. A card scrolled out of the list is anchored at the
   * edge it left by.
   */
  private _reportAnchors() {
    const anchors = new Map<string, Point>();
    const list = this.querySelector<HTMLElement>('.inbox-list')?.getBoundingClientRect();
    if (this.open) {
      for (const element of this.querySelectorAll<HTMLElement>('[data-card]')) {
        const box = element.getBoundingClientRect();
        if (box.width === 0) continue;
        const inList = element.closest('.inbox-list') !== null;
        const low = inList && list ? list.top + 10 : box.top + 10;
        const high = inList && list ? list.bottom - 10 : box.bottom - 10;
        anchors.set(element.dataset['card']!, {
          x: Math.round(box.left),
          y: Math.round(Math.max(low, Math.min(high, box.top + 26))),
        });
      }
    }
    const key = [...anchors].map(([id, point]) => `${id}:${point.x},${point.y}`).join('|');
    if (key === this._anchorsKey) return;
    this._anchorsKey = key;
    this.dispatchEvent(new CustomEvent<Map<string, Point>>('inbox-anchors', { detail: anchors, bubbles: true, composed: true }));
  }

  private _emit<T>(name: string, detail?: T) {
    this.dispatchEvent(new CustomEvent<T>(name, { detail: detail as T, bubbles: true, composed: true }));
  }

  /** One press approves (#278): if it was pressed, it was meant. Only Approve
   *  and Retry can be pressed, and neither the moment its card has moved. */
  private _onApprove(event: Event, card: InboxCard, action: Extract<InboxAction, { type: 'approve' }>) {
    event.stopPropagation();
    if (action.disabled || this._shielded(card.id)) return;
    this._emit<ApproveTarget>('inbox-approve', action.target);
  }

  private _onKeepAwake(event: Event, card: InboxCard) {
    event.stopPropagation();
    if (this._shielded(card.id)) return;
    this._emit('inbox-keep-awake');
  }

  private _onCardClick(card: InboxCard) {
    if (card.workKey !== null) this._emit<string>('inbox-select', card.workKey);
  }

  private _action(card: InboxCard, action: InboxAction) {
    switch (action.type) {
      case 'approve':
        return html`<button
          class="inbox-action approve ${action.step}"
          type="button"
          title="${action.hint}"
          aria-label="${action.hint}"
          ?disabled=${action.disabled}
          @click=${(event: Event) => this._onApprove(event, card, action)}
        >${action.label}</button>`;
      case 'open':
        return html`<a
          class="inbox-action open"
          href="${action.href}"
          target="_blank"
          rel="noopener noreferrer"
          title="${action.hint}"
          @click=${(event: Event) => event.stopPropagation()}
        >${action.label}<span class="inbox-out" aria-hidden="true">↗</span></a>`;
      case 'keep-awake':
        return html`<button
          class="inbox-action wake"
          type="button"
          title="${action.hint}"
          @click=${(event: Event) => this._onKeepAwake(event, card)}
        >${action.label}</button>`;
    }
  }

  /** The row under a card's title: its links to GitHub, each a target of its
   *  own, and whatever short facts there are beside them. */
  private _meta(links: readonly InboxLink[], facts: readonly string[]) {
    if (links.length === 0 && facts.length === 0) return '';
    return html`<div class="inbox-meta">
      ${links.map((link) => html`<a
        class="inbox-link"
        href="${link.href}"
        target="_blank"
        rel="noopener noreferrer"
        @click=${(event: Event) => event.stopPropagation()}
      >${link.label}<span class="inbox-out" aria-hidden="true">↗</span></a>`)}
      ${facts.length > 0 ? html`<span class="inbox-facts">${facts.join(' · ')}</span>` : ''}
    </div>`;
  }

  private _accentStyle(color: { hex: string; rgb: string } | null): string {
    return color ? `--card-color:${color.hex};--card-rgb:${color.rgb}` : '';
  }

  private _card(card: InboxCard) {
    const step = card.action?.type === 'approve' ? ` step-${card.action.step}` : '';
    const selected = card.id === this.selectedCardId ? ' is-selected' : '';
    const line = card.line;
    return html`<article
      class="inbox-card source-${card.source} accent-${card.accent}${step}${selected}"
      data-card="${card.id}"
      style="${this._accentStyle(card.color)}"
      @click=${() => this._onCardClick(card)}
    >
      <div class="inbox-card-head">
        <span class="inbox-eyebrow">${card.eyebrow}</span>
        ${this.multiProject && card.repo ? html`<span class="inbox-repo">${card.repo}</span>` : ''}
        ${card.dismissible ? html`<button
          class="inbox-dismiss"
          type="button"
          aria-label="Dismiss: ${card.title}"
          @click=${(event: Event) => { event.stopPropagation(); this._emit<string>('inbox-dismiss', card.id); }}
        ><span aria-hidden="true">×</span></button>` : ''}
      </div>
      <h3 class="inbox-title">${card.title}</h3>
      ${this._meta(card.links, card.facts)}
      ${card.action ? this._action(card, card.action) : ''}
      <p class="inbox-line${line ? ` ${line.tone}` : ''}" role="status" aria-live="polite">${line ? line.text : ''}</p>
    </article>`;
  }

  private _inspector(inspection: Inspection) {
    return html`<article
      class="inbox-card inbox-inspector accent-work"
      data-card="${INSPECTOR_CARD_ID}"
      style="${this._accentStyle(inspection.color)}"
    >
      <div class="inbox-card-head">
        <span class="inbox-eyebrow">${inspection.eyebrow}</span>
        ${this.multiProject && inspection.repo ? html`<span class="inbox-repo">${inspection.repo}</span>` : ''}
        <button
          class="inbox-dismiss"
          type="button"
          aria-label="Close"
          @click=${() => this._emit('inbox-close-inspector')}
        ><span aria-hidden="true">×</span></button>
      </div>
      <h3 class="inbox-title">${inspection.title}</h3>
      ${inspection.body.map((text) => html`<p class="inbox-body">${text}</p>`)}
      ${this._meta(inspection.links, inspection.facts)}
    </article>`;
  }

  override render() {
    const count = this.cards.length;
    const waiting = count === 0 ? 'Nothing is waiting on you' : `${count} waiting on you`;
    const summary = count === 0 ? 'nothing waiting' : 'waiting on you';
    return html`
      <aside
        class="inbox ${this.open ? 'is-open' : 'is-closed'}${this.overlay ? ' is-overlay' : ''}"
        aria-label="Inbox: ${waiting}"
      >
        <header class="inbox-head">
          <button
            class="inbox-badge${count > 0 ? ' has-cards' : ''}"
            type="button"
            aria-label="${waiting}"
            aria-expanded="${this.open ? 'true' : 'false'}"
            @click=${() => this._emit('inbox-toggle')}
          >${count}</button>
          <span class="inbox-heading">Inbox</span>
          <span class="inbox-summary">${summary}</span>
        </header>
        <div class="inbox-list" @scroll=${() => this._reportAnchors()}>
          ${count === 0
            ? html`<p class="inbox-empty">Approvals, reviews and anything else that needs a person turn up here.</p>`
            // Keyed, so that an element stays the card it was drawn as: when the
            // card above it leaves, a button never becomes another PR's
            // button between a finger going down and coming up.
            : repeat(this.cards, (card) => card.id, (card) => this._card(card))}
        </div>
        ${this.inspection ? this._inspector(this.inspection) : ''}
        <footer class="inbox-foot">
          <button
            class="inbox-log${this.logOpen ? ' is-on' : ''}"
            type="button"
            aria-pressed="${this.logOpen ? 'true' : 'false'}"
            aria-label="${this.logOpen ? 'Close the activity log' : 'Open the activity log'}"
            @click=${() => this._emit('inbox-log')}
          ><span class="inbox-log-word">${this.logOpen ? 'Close log' : 'Log'}</span></button>
        </footer>
      </aside>
    `;
  }
}

customElements.define('yoke-inbox', YokeInbox);
