/**
 * Keeps the machine awake for as long as the Dashboard is open (#246).
 *
 * The mechanism is deliberately silly: a tiny muted video loops forever. An
 * actively playing video is the one thing observed to defeat the sleep/lock
 * policy on a locked-down corporate laptop — browsers hold a system screen
 * wake lock while a visible video plays, where an idle-timer ping does
 * nothing. The Screen Wake Lock API is requested too when the browser exposes
 * it and policy allows it, but the video is the mechanism that is trusted to
 * work, so the controller keeps it playing come what may.
 *
 * Everything the controller touches is injected, so the logic is testable in
 * Node without a DOM.
 */

export type KeepAwakeStatus =
  /** Not started, or stopped. */
  | 'idle'
  /** The loop is playing — the machine is being held awake. */
  | 'awake'
  /** Autoplay was refused; waiting for a user gesture to start the loop. */
  | 'blocked';

/** The slice of `HTMLVideoElement` the controller uses. */
export interface KeepAwakeVideo {
  muted: boolean;
  readonly paused: boolean;
  play(): Promise<void> | void;
}

export interface WakeLockSentinelLike {
  release(): Promise<void> | void;
  addEventListener?(type: 'release', listener: () => void): void;
}

export interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/** The slice of `document` the controller uses. */
export interface KeepAwakeDocument {
  readonly visibilityState?: string;
  addEventListener(type: string, listener: () => void, options?: unknown): void;
  removeEventListener(type: string, listener: () => void, options?: unknown): void;
}

export interface KeepAwakeOptions {
  video: KeepAwakeVideo;
  /** Defaults to the global `document`. */
  doc?: KeepAwakeDocument;
  /** Defaults to `navigator.wakeLock`; null disables the wake-lock attempt. */
  wakeLock?: WakeLockLike | null;
  /** How often to confirm the loop is still playing. Default 5s. */
  watchdogMs?: number;
  onStatusChange?: (status: KeepAwakeStatus) => void;
}

/** Gestures that let a blocked loop start, per browser autoplay policies. */
const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchstart'];

function defaultDocument(): KeepAwakeDocument | null {
  return typeof document === 'undefined' ? null : (document as unknown as KeepAwakeDocument);
}

function defaultWakeLock(): WakeLockLike | null {
  if (typeof navigator === 'undefined') return null;
  const api = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
  return api ?? null;
}

export class KeepAwake {
  private readonly video: KeepAwakeVideo;
  private readonly doc: KeepAwakeDocument | null;
  private readonly wakeLockApi: WakeLockLike | null;
  private readonly watchdogMs: number;
  private readonly onStatusChange: ((status: KeepAwakeStatus) => void) | null;

  private status: KeepAwakeStatus = 'idle';
  private running = false;
  private gestureArmed = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private sentinel: WakeLockSentinelLike | null = null;
  private wakeLockPending = false;

  private readonly onGesture = () => { void this.resume(); };
  private readonly onVisibilityChange = () => {
    if (this.isHidden()) return;
    // Browsers pause offscreen media and drop the wake lock when the tab is
    // backgrounded; take both back as soon as the Dashboard is on screen.
    void this.resume();
  };

  constructor(options: KeepAwakeOptions) {
    this.video = options.video;
    this.doc = options.doc ?? defaultDocument();
    this.wakeLockApi = options.wakeLock === undefined ? defaultWakeLock() : options.wakeLock;
    this.watchdogMs = options.watchdogMs ?? 5_000;
    this.onStatusChange = options.onStatusChange ?? null;
  }

  getStatus(): KeepAwakeStatus {
    return this.status;
  }

  /** True while a Screen Wake Lock sentinel is held (belt to the video's braces). */
  hasWakeLock(): boolean {
    return this.sentinel !== null;
  }

  /** Start playing the loop and hold it playing until `stop()`. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.doc?.addEventListener('visibilitychange', this.onVisibilityChange);
    this.watchdog = setInterval(() => { void this.tick(); }, this.watchdogMs);
    await this.resume();
  }

  /** Re-assert playback and the wake lock — after a gesture, tab switch or watchdog tick. */
  async resume(): Promise<void> {
    if (!this.running) return;
    await this.play();
    await this.requestWakeLock();
  }

  /** Release everything. Safe to call when never started. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.doc?.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.disarmGesture();
    this.setStatus('idle');
    await this.releaseWakeLock();
  }

  private async tick(): Promise<void> {
    if (!this.running || this.isHidden()) return;
    if (this.video.paused) await this.play();
    if (this.sentinel === null) await this.requestWakeLock();
  }

  private async play(): Promise<void> {
    // Autoplay is only permitted for muted media, and a stray unmute would
    // blast sound from a dashboard nobody is looking at.
    this.video.muted = true;
    try {
      await this.video.play();
      this.setStatus('awake');
      this.disarmGesture();
    } catch {
      // Autoplay refused (no media engagement yet, or a strict policy). The
      // next user gesture anywhere on the page gets another go.
      this.setStatus('blocked');
      this.armGesture();
    }
  }

  private armGesture(): void {
    if (this.gestureArmed || this.doc === null) return;
    this.gestureArmed = true;
    for (const type of GESTURE_EVENTS) {
      this.doc.addEventListener(type, this.onGesture, { passive: true });
    }
  }

  private disarmGesture(): void {
    if (!this.gestureArmed || this.doc === null) return;
    this.gestureArmed = false;
    for (const type of GESTURE_EVENTS) {
      this.doc.removeEventListener(type, this.onGesture);
    }
  }

  private async requestWakeLock(): Promise<void> {
    if (this.wakeLockApi === null || this.sentinel !== null || this.wakeLockPending) return;
    if (!this.running || this.isHidden()) return;
    this.wakeLockPending = true;
    try {
      const sentinel = await this.wakeLockApi.request('screen');
      if (!this.running) {
        await sentinel.release();
        return;
      }
      this.sentinel = sentinel;
      sentinel.addEventListener?.('release', () => {
        if (this.sentinel === sentinel) this.sentinel = null;
      });
    } catch {
      // Unsupported, or blocked by policy. The video loop is the real
      // mechanism; the wake lock is a bonus when it is available.
    } finally {
      this.wakeLockPending = false;
    }
  }

  private async releaseWakeLock(): Promise<void> {
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (sentinel === null) return;
    try {
      await sentinel.release();
    } catch {
      // Already gone.
    }
  }

  private isHidden(): boolean {
    return this.doc?.visibilityState === 'hidden';
  }

  private setStatus(status: KeepAwakeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatusChange?.(status);
  }
}
