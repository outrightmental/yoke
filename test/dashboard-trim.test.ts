import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { BroadcastEventData, EventLine, LifecyclePair } from "../src/dashboard/store/types.js";
import { issueColor, NEUTRAL_COLOR } from "../src/dashboard/shared/issue-colors.js";
import { EventStream } from "../src/dashboard/components/event-stream.js";
import { BroadcastEventCard } from "../src/dashboard/components/broadcast-event-card.js";
import { parseColor, readPalette } from "../src/dashboard/field/palette.js";
import { withoutColorEmoji } from "../src/dashboard/field/text.js";
import { workViews } from "../src/dashboard/shared/work-view.js";
import { dashboardReducer, initialState } from "../src/dashboard/store/dashboard-store.js";
import { cylinder, flatten, makeEvent, paintField, parseRgba, stateWith, tokensPalette, tokenStyle, triplet } from "./dashboard-helpers.js";

// The dashboard's trim is hue-free gray and its saturated colors mean live
// computing burn (issue #280). These guard the split: the trim tokens have no
// hue, and nothing outside tokens.css brings a saturated color of its own.

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DASHBOARD = join(ROOT, "src", "dashboard");
const TOKENS_CSS = join(DASHBOARD, "styles", "tokens.css");
const GLOBAL_CSS = join(DASHBOARD, "styles", "global.css");

type Rgb = [number, number, number];

/** Source text without its comments, whose issue numbers (`#236`) read like hex colors. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every color literal in `text` — `#hex`, or `rgb()`/`rgba()` with numeric channels. */
function colorLiterals(text: string): Array<{ literal: string; rgb: Rgb }> {
  const found: Array<{ literal: string; rgb: Rgb }> = [];
  for (const m of text.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
    const hex = m[1]!;
    if (![3, 4, 6, 8].includes(hex.length)) continue;
    const full = hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join("") : hex.slice(0, 6);
    found.push({ literal: m[0], rgb: [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb });
  }
  for (const m of text.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
    found.push({ literal: m[0], rgb: [Number(m[1]), Number(m[2]), Number(m[3])] });
  }
  return found;
}

function hueFree([r, g, b]: Rgb): boolean {
  return r === g && g === b;
}

/** The custom properties declared in tokens.css, by name. */
function tokens(): Map<string, string> {
  const css = withoutComments(readFileSync(TOKENS_CSS, "utf-8"));
  return new Map([...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

/** A token's color: an `r, g, b` triplet for the `-rgb` tokens, else its one literal. */
function tokenRgb(name: string, value: string): Rgb {
  if (name.endsWith("-rgb")) {
    const channels = value.split(",").map((v) => Number(v.trim()));
    assert.equal(channels.length, 3, `--${name} should be an r, g, b triplet`);
    return channels as Rgb;
  }
  const literals = colorLiterals(value);
  assert.equal(literals.length, 1, `--${name} should be one color`);
  return literals[0]!.rgb;
}

/** Every dashboard source the browser runs or styles with, except tokens.css. */
function dashboardSources(dir = DASHBOARD): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return dashboardSources(path);
    return /\.(ts|css|html)$/.test(entry.name) && path !== TOKENS_CSS ? [path] : [];
  });
}

test("trim and background tokens are fully desaturated: r = g = b, no hue at all", () => {
  const all = tokens();
  const trim = [...all].filter(([name]) => name.startsWith("trim") || name.startsWith("bg-"));
  assert.ok(trim.some(([name]) => name === "trim-rgb"), "the trim has an r, g, b triplet for rgba()");
  for (const [name, value] of trim) {
    const rgb = tokenRgb(name, value);
    assert.ok(hueFree(rgb), `--${name}: ${value} has a hue; trim must be gray`);
  }
});

test("the only saturated colors in tokens.css are the named status signals, each with a matching triplet", () => {
  const all = tokens();
  for (const [name, value] of all) {
    for (const { literal, rgb } of colorLiterals(value)) {
      assert.ok(hueFree(rgb) || name.startsWith("color-"), `--${name} brings ${literal}; only --color-* status tokens may be saturated`);
    }
  }
  for (const [name, value] of all) {
    if (!name.startsWith("color-") || name.endsWith("-rgb")) continue;
    const triplet = all.get(`${name}-rgb`);
    assert.ok(triplet !== undefined, `--${name} needs --${name}-rgb for rgba()`);
    assert.deepEqual(tokenRgb(`${name}-rgb`, triplet), tokenRgb(name, value), `--${name}-rgb should be --${name}`);
  }
});

test("nothing else in the dashboard brings a saturated color of its own", () => {
  const offenders: string[] = [];
  for (const file of dashboardSources()) {
    for (const { literal, rgb } of colorLiterals(withoutComments(readFileSync(file, "utf-8")))) {
      if (!hueFree(rgb)) offenders.push(`${relative(ROOT, file)}: ${literal}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "saturated color means live computing burn: use a trim token, an engine color, or a --color-* status token",
  );
});

test("the base UI is not green: green is a status signal, never trim", () => {
  const css = withoutComments(readFileSync(GLOBAL_CSS, "utf-8"));
  assert.doesNotMatch(css, /--color-green/, "global.css styles structure, which is gray");
  assert.doesNotMatch(withoutComments(readFileSync(join(DASHBOARD, "styles", "drawer.css"), "utf-8")), /--color-/, "as is the drawer");
  const body = /^body\s*\{([^}]*)\}/m.exec(css)?.[1] ?? "";
  assert.match(body, /color:\s*var\(--trim\);/, "body text is trim gray");
});

test("the stylesheets keep green for the one place it is a signal: an approval going through", () => {
  for (const file of dashboardSources().filter((path) => path.endsWith(".css") && path !== TOKENS_CSS)) {
    const css = withoutComments(readFileSync(file, "utf-8"));
    for (const [, selectors] of css.matchAll(/([^{}]+)\{[^{}]*--color-green[^{}]*\}/g)) {
      assert.match(
        selectors!,
        /\.approve\.(queued|approving|merged)|\.inbox-line\.approved/,
        `${relative(ROOT, file)}: ${selectors!.trim()} is green`,
      );
    }
  }
});

// ── the canvas ───────────────────────────────────────────────────────────────

test("the canvas paints with the dashboard's own tokens, and brings no color of its own", () => {
  const all = tokens();
  const palette = readPalette(tokenStyle());
  const named: Array<[keyof typeof palette, string]> = [
    ["bg", "bg-dark"], ["bgAlt", "bg-dark-alt"], ["trim", "trim"], ["trimBright", "trim-bright"], ["trimDim", "trim-dim"],
    ["green", "color-green"], ["yellow", "color-yellow"], ["orange", "color-orange"], ["red", "color-red"], ["coral", "color-coral"],
  ];
  for (const [key, token] of named) {
    assert.deepEqual([...palette[key]], tokenRgb(token, all.get(token)!), `${key} is --${token}`);
  }
  // A stylesheet that has not loaded costs the canvas its signals, but never invents a color.
  for (const color of Object.values(readPalette({ getPropertyValue: () => "" }))) {
    assert.ok(hueFree([...color] as Rgb), "every fallback is gray");
  }
  assert.deepEqual(parseColor("#f05"), [255, 0, 85]);
  assert.deepEqual(parseColor(" 0, 255, 136 "), [0, 255, 136]);
  assert.equal(parseColor("var(--trim)"), null);
});

test("everything the canvas draws is trim, a status signal, or the color of a piece of work", () => {
  const pairs: LifecyclePair[] = [
    { issue: { number: 7, title: "Burning", state: "open" }, pr: null, prPhase: "planning" },
    { issue: { number: 8, title: "Checks", state: "open" }, pr: { number: 80, title: "Checks", state: "open", draft: true, checksStatus: "pending" }, prPhase: "active" },
    { issue: { number: 9, title: "Blocked", state: "open" }, pr: null, prPhase: "absent", blockedByIssueNumbers: [8] },
    { issue: { number: 10, title: "Merged", state: "open" }, pr: { number: 81, title: "Merged", state: "open", checksStatus: "success" }, prPhase: "completed" },
  ];
  let state = stateWith(pairs, "o/a", { cylinders: [cylinder({ ...issueColorOf(7) }), cylinder({ index: 2, status: "idle", actionType: null, issueNumber: null })] });
  state = dashboardReducer(state, makeEvent("log-message", { level: "info", message: "📊 Snapshot" }));
  const painted = paintField(state);

  const palette = tokensPalette();
  const allowed = new Set<string>(["255,255,255", ...Object.values(palette).map((color) => triplet(color))]);
  for (const work of workViews(state, Date.now())) {
    allowed.add(work.color.rgb);
    allowed.add(work.hue.rgb);
  }
  const strays = painted.fills
    .map((fill) => ({ text: fill.text, ink: parseRgba(fill.fill) }))
    .filter(({ ink }) => ink !== undefined && !allowed.has(ink.rgb));
  assert.deepEqual(strays, [], "no other color reaches the canvas");
  assert.ok(painted.texts.length > 10, "and plenty was drawn");
});

test("the field marks a shutdown in orange, like the shut-down engines", () => {
  const palette = tokensPalette();
  let state = stateWith([], "o/a", { cylinders: [cylinder({ status: "idle", actionType: null, issueNumber: null })] });
  state = dashboardReducer(state, makeEvent("engine-shutdown", { engineIndex: 0 }));
  state = dashboardReducer(state, makeEvent("app-shutdown", {}));
  const painted = paintField(state);
  assert.equal(painted.inkOf("SHUT DOWN")?.rgb, triplet(palette.orange), "said among the instruments");
  assert.equal(painted.inkOf("shut down")?.rgb, triplet(palette.orange), "and by each engine");
});

test("the field marks a lost connection in red, and connecting in trim", () => {
  const palette = tokensPalette();
  assert.equal(paintField({ ...initialState(), connection: "disconnected" }).inkOf("LOST")?.rgb, triplet(palette.red));
  assert.equal(paintField({ ...initialState(), connection: "connecting" }).inkOf("CONNECTING")?.rgb, triplet(palette.trimDim));
  assert.equal(paintField({ ...initialState(), connection: "connected" }).inkOf("LOST"), undefined, "connected, it says nothing");
});

test("an idle engine is trim, and work is never gray: an orphan PR takes its own number's color (#280)", () => {
  const orphan: LifecyclePair = { issue: null, pr: { number: 300, title: "Orphan", state: "open" }, prPhase: "review" };
  const withIssue: LifecyclePair = { issue: { number: 7, title: "X", state: "open" }, pr: null, prPhase: "planning" };
  const state = stateWith([orphan, withIssue], "o/a", { cylinders: [cylinder({ status: "idle", actionType: null, issueNumber: null })] });
  const hues = workViews(state, Date.now()).map((work) => work.hue.hex);
  assert.deepEqual(hues.sort(), [issueColor(300).hex, issueColor(7).hex].sort());
  assert.ok(!hues.includes(NEUTRAL_COLOR), "no piece of work is gray");
  for (const work of workViews(state, Date.now())) {
    assert.ok(!hueFree(parseColor(work.color.rgb)! as unknown as Rgb), "nor is it gray at its burn level");
  }
  const painted = paintField(state);
  assert.equal(painted.inkOf("idle")?.rgb, triplet(tokensPalette().trimDim), "an engine with no work is trim");
});

test("a line of the ribbon with no color of its own is trim, with no picture-emoji to bring one in (#280)", () => {
  let state = initialState();
  state = dashboardReducer(state, makeEvent("log-message", { level: "info", message: "📊 Snapshot: 3 issues" }));
  state = dashboardReducer(state, makeEvent("log-message", { level: "success", message: "✅ approved" }));
  const painted = paintField(state);
  const palette = tokensPalette();
  assert.equal(painted.inkOf("Snapshot: 3 issues")?.rgb, triplet(palette.trim), "the chart is gone, and the line is trim");
  assert.equal(painted.inkOf("✅ approved")?.rgb, triplet(palette.green), "an outcome keeps its color, emoji and all");

  assert.equal(withoutColorEmoji("📍 Phase: implementation"), "Phase: implementation");
  assert.equal(withoutColorEmoji("🔄 Engine 6 · cycle 2"), "Engine 6 · cycle 2");
  assert.equal(withoutColorEmoji("▶ [1/6] Implement #40 ✓"), "▶ [1/6] Implement #40 ✓", "plain glyphs stay");
  assert.equal(withoutColorEmoji("⏸\uFE0F waiting"), "⏸ waiting", "without the selector that asks for the picture");
});

test("an event-log line with no color of its own is trim, color emoji and all (#280)", () => {
  const stream = new EventStream();
  const line = (text: string, level: string, color: string | null = null): EventLine =>
    ({ text, level, color, cylinderIdx: color ? 0 : -1, atMs: 0 });
  Object.assign(stream, {
    events: [
      line("📊 Snapshot", "info"),
      line("✓ done", "success"),
      line("working", "info", issueColor(7).hex),
    ],
  });
  const classes = [...flatten(stream.render()).matchAll(/class="(event-content[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(classes, ["event-content plain", "event-content", "event-content"]);
  const css = (EventStream.styles as { cssText: string }).cssText;
  assert.match(css, /\.event-content\.plain\s*\{\s*filter:\s*grayscale\(1\);/);
});

test("a broadcast card's ✨ is card chrome, so gray (#280)", () => {
  const card = new BroadcastEventCard();
  Object.assign(card, {
    event: {
      id: "1", category: "ci", label: "WORKFLOW", stateBefore: "", changeHow: "", stateAfter: "",
      excellence: "CI unblocked", atMs: 0, color: NEUTRAL_COLOR,
    } satisfies BroadcastEventData,
  });
  assert.match(flatten(card.render()), /<span class="broadcast-event-sparkle">✨<\/span>/);
  const css = (BroadcastEventCard.styles as { cssText: string }).cssText;
  assert.match(css, /\.broadcast-event-sparkle\s*\{\s*filter:\s*grayscale\(1\);/);
});

/** The full-saturation color of issue `n`, as a cylinder working it carries it. */
function issueColorOf(n: number): { color: string; colorRgb: string; issueNumber: number } {
  const c = issueColor(n);
  return { color: c.hex, colorRgb: c.rgb, issueNumber: n };
}
