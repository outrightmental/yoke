import { LitElement, html } from 'lit';
import { KeepAwake, type KeepAwakeStatus } from '../shared/keep-awake.js';

/**
 * The "ON" light in the upper-right corner (#246), sized to the header's text (#250).
 *
 * The lamp's glow is not CSS — it is a looping, muted video, playing for the
 * whole time the Dashboard is open. That playing video is what stops the
 * machine from sleeping or locking mid-run; putting it in the corner as the
 * keep-awake indicator makes the trick visible instead of hiding it offscreen.
 */
export class KeepAwakeLight extends LitElement {
  static override properties = {
    _status: { attribute: false, state: true },
  };

  private _status: KeepAwakeStatus = 'idle';
  private _keepAwake: KeepAwake | null = null;

  protected override createRenderRoot() { return this; }

  protected override firstUpdated() {
    this._startKeepAwake();
  }

  override connectedCallback() {
    super.connectedCallback();
    // Re-arm after a detach/re-attach; firstUpdated only ever runs once.
    if (this.hasUpdated) this._startKeepAwake();
  }

  private _startKeepAwake() {
    if (this._keepAwake) return;
    const video = this.querySelector('video');
    if (!video) return;
    this._keepAwake = new KeepAwake({
      video,
      onStatusChange: status => {
        this._status = status;
        // The inbox lists a refused loop as something to tap, so it has to hear of it.
        this.dispatchEvent(new CustomEvent<KeepAwakeStatus>('keep-awake-status', {
          detail: status,
          bubbles: true,
          composed: true,
        }));
      },
    });
    void this._keepAwake.start();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    void this._keepAwake?.stop();
    this._keepAwake = null;
  }

  /** Start the loop the browser refused to autoplay: for the lamp's own click,
   *  and for the inbox's card that offers the same thing to a finger. */
  resume() {
    void this._keepAwake?.resume();
  }

  /** Autoplay can be refused until the page has been interacted with. */
  private _onClick() {
    this.resume();
  }

  override render() {
    const blocked = this._status === 'blocked';
    const title = blocked
      ? 'Click to start the keep-awake loop — the browser refused to autoplay it.'
      : 'A looping video plays here for as long as the Dashboard is open, so the computer will not sleep or lock mid-run.';
    return html`
      <div class="keep-awake ${blocked ? 'is-blocked' : ''}" title="${title}">
        <div class="keep-awake-text">
          <div class="keep-awake-label">KEEP AWAKE</div>
          <div class="keep-awake-state">${blocked ? 'CLICK' : 'ON'}</div>
        </div>
        <div class="keep-awake-lamp" @click=${this._onClick}>
          <video
            class="keep-awake-video"
            muted
            loop
            autoplay
            playsinline
            disablepictureinpicture
            disableremoteplayback
            preload="auto"
            aria-hidden="true"
          >
            <source src="/assets/keep-awake.webm" type="video/webm" />
            <source src="/assets/keep-awake.mp4" type="video/mp4" />
          </video>
        </div>
      </div>
    `;
  }
}

customElements.define('keep-awake-light', KeepAwakeLight);
