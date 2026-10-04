import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { KeepAwake, type KeepAwakeStatus } from "../src/dashboard/shared/keep-awake.js";

// `import.meta.url` rather than `import.meta.dirname`, which needs Node 20.11+.
const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// ── Fakes ─────────────────────────────────────────────────────────────────────

class FakeVideo {
  muted = false;
  paused = true;
  playCalls = 0;
  /** When set, play() rejects — i.e. the browser refused to autoplay. */
  refuse = false;

  async play(): Promise<void> {
    this.playCalls++;
    if (this.refuse) throw new Error("NotAllowedError");
    this.paused = false;
  }
}

class FakeDocument {
  visibilityState = "visible";
  listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    let set = this.listeners.get(type);
    if (!set) { set = new Set(); this.listeners.set(type, set); }
    set.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  async dispatch(type: string): Promise<void> {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
    // Listeners kick off async work (play / wake lock); let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

class FakeWakeLock {
  requests = 0;
  released = 0;
  /** When set, request() rejects — i.e. the API exists but policy says no. */
  refuse = false;
  private onRelease: (() => void) | null = null;

  async request(type: string): Promise<{ release(): Promise<void>; addEventListener(t: "release", cb: () => void): void }> {
    assert.equal(type, "screen", "should request a screen wake lock");
    this.requests++;
    if (this.refuse) throw new Error("NotAllowedError");
    const self = this;
    return {
      async release() { self.released++; self.onRelease?.(); },
      addEventListener(_t: "release", cb: () => void) { self.onRelease = cb; },
    };
  }

  /** Simulate the browser dropping the lock on its own (tab switch, policy). */
  dropFromBrowser(): void {
    this.onRelease?.();
    this.onRelease = null;
  }
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Controller ────────────────────────────────────────────────────────────────

test("KeepAwake: start() plays the loop muted and reports 'awake'", async () => {
  const video = new FakeVideo();
  const doc = new FakeDocument();
  const statuses: KeepAwakeStatus[] = [];
  const keepAwake = new KeepAwake({ video, doc, wakeLock: null, onStatusChange: (s) => statuses.push(s) });

  await keepAwake.start();

  assert.equal(video.playCalls, 1, "should play the loop on start");
  assert.equal(video.muted, true, "the loop must be muted — autoplay policies require it");
  assert.equal(keepAwake.getStatus(), "awake");
  assert.deepEqual(statuses, ["awake"]);

  await keepAwake.stop();
});

test("KeepAwake: a refused autoplay reports 'blocked' and retries on the next user gesture", async () => {
  const video = new FakeVideo();
  const doc = new FakeDocument();
  const statuses: KeepAwakeStatus[] = [];
  const keepAwake = new KeepAwake({ video, doc, wakeLock: null, onStatusChange: (s) => statuses.push(s) });

  video.refuse = true;
  await keepAwake.start();

  assert.equal(keepAwake.getStatus(), "blocked", "a refused play should report blocked");
  assert.ok(doc.count("pointerdown") > 0, "should listen for a user gesture while blocked");

  // The user clicks somewhere; autoplay is now permitted.
  video.refuse = false;
  await doc.dispatch("pointerdown");

  assert.equal(keepAwake.getStatus(), "awake", "the gesture should start the loop");
  assert.equal(doc.count("pointerdown"), 0, "gesture listeners should be dropped once playing");
  assert.deepEqual(statuses, ["blocked", "awake"]);

  await keepAwake.stop();
});

test("KeepAwake: the watchdog restarts a loop that stopped playing", async () => {
  const video = new FakeVideo();
  const doc = new FakeDocument();
  const keepAwake = new KeepAwake({ video, doc, wakeLock: null, watchdogMs: 10 });

  await keepAwake.start();
  assert.equal(video.playCalls, 1);

  // Something paused the video behind our back.
  video.paused = true;
  await waitMs(40);

  assert.ok(video.playCalls > 1, "the watchdog should play the loop again");
  assert.equal(video.paused, false, "the loop should be playing again");

  await keepAwake.stop();
});

test("KeepAwake: returning to a backgrounded tab re-plays the loop", async () => {
  const video = new FakeVideo();
  const doc = new FakeDocument();
  const keepAwake = new KeepAwake({ video, doc, wakeLock: null });

  await keepAwake.start();
  const playsAfterStart = video.playCalls;

  // Browsers pause offscreen media; the tab comes back.
  doc.visibilityState = "hidden";
  video.paused = true;
  await doc.dispatch("visibilitychange");
  assert.equal(video.playCalls, playsAfterStart, "should not fight the browser while hidden");

  doc.visibilityState = "visible";
  await doc.dispatch("visibilitychange");
  assert.ok(video.playCalls > playsAfterStart, "should re-play when the tab is visible again");

  await keepAwake.stop();
});

test("KeepAwake: also holds a Screen Wake Lock, and re-acquires one the browser drops", async () => {
  const video = new FakeVideo();
  const doc = new FakeDocument();
  const wakeLock = new FakeWakeLock();
  const keepAwake = new KeepAwake({ video, doc, wakeLock, watchdogMs: 10 });

  await keepAwake.start();
  assert.equal(wakeLock.requests, 1, "should request a screen wake lock");
  assert.equal(keepAwake.hasWakeLock(), true);

  wakeLock.dropFromBrowser();
  assert.equal(keepAwake.hasWakeLock(), false, "a dropped lock should be forgotten");

  await waitMs(40);
  assert.ok(wakeLock.requests > 1, "the watchdog should take the wake lock back");

  await keepAwake.stop();
});

test("KeepAwake: a wake lock blocked by policy leaves the video loop running", async () => {
  const video = new FakeVideo();
  const doc = new FakeDocument();
  const wakeLock = new FakeWakeLock();
  wakeLock.refuse = true;
  const keepAwake = new KeepAwake({ video, doc, wakeLock });

  await keepAwake.start();

  assert.equal(keepAwake.getStatus(), "awake", "the video is the mechanism; the wake lock is a bonus");
  assert.equal(keepAwake.hasWakeLock(), false);
  assert.equal(video.paused, false);

  await keepAwake.stop();
});

test("KeepAwake: stop() releases the wake lock and every listener", async () => {
  const video = new FakeVideo();
  const doc = new FakeDocument();
  const wakeLock = new FakeWakeLock();
  const keepAwake = new KeepAwake({ video, doc, wakeLock, watchdogMs: 10 });

  video.refuse = true;
  await keepAwake.start();
  video.refuse = false;

  await keepAwake.stop();

  assert.equal(keepAwake.getStatus(), "idle");
  assert.equal(doc.count("visibilitychange"), 0, "should stop listening for visibility changes");
  assert.equal(doc.count("pointerdown"), 0, "should stop listening for gestures");
  assert.equal(wakeLock.released, 1, "should release the wake lock");

  const playsAtStop = video.playCalls;
  video.paused = true;
  await waitMs(40);
  assert.equal(video.playCalls, playsAtStop, "the watchdog should be cancelled");
});

// ── The bundled loop ──────────────────────────────────────────────────────────

test("the keep-awake loop is committed, tiny, and in both WebM and MP4", () => {
  for (const [file, magic] of [
    ["keep-awake.webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],   // EBML
    ["keep-awake.mp4", Buffer.from("ftyp", "ascii")],              // ISO-BMFF, at offset 4
  ] as const) {
    const assetPath = join(ROOT, "src", "dashboard", "assets", file);
    const bytes = readFileSync(assetPath);
    assert.ok(bytes.includes(magic), `${file} should be a real ${file.endsWith("webm") ? "WebM" : "MP4"} file`);
    assert.ok(
      statSync(assetPath).size < 64 * 1024,
      `${file} is bundled into every Dashboard load — keep it tiny (is ${statSync(assetPath).size} bytes)`,
    );
  }
});

test("the keep-awake lamp plays both bundled sources", () => {
  const component = readFileSync(join(ROOT, "src", "dashboard", "components", "keep-awake-light.ts"), "utf-8");
  assert.match(component, /\/assets\/keep-awake\.webm/, "lamp should source the WebM loop");
  assert.match(component, /\/assets\/keep-awake\.mp4/, "lamp should source the MP4 loop");
  assert.match(component, /\bloop\b/, "the video must loop or the machine sleeps when it ends");
  assert.match(component, /\bmuted\b/, "the video must be muted or autoplay is refused");
  assert.match(component, /\bplaysinline\b/, "the video must play inline, not fullscreen");
});

test("the Dashboard mounts the keep-awake lamp whenever it is open", () => {
  const header = readFileSync(join(ROOT, "src", "dashboard", "components", "yoke-header.ts"), "utf-8");
  assert.match(
    header,
    /<keep-awake-light><\/keep-awake-light>/,
    "the lamp is unconditional — the Dashboard keeps the machine awake whenever it is open (#246)",
  );
});
