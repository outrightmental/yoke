import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { BroadcastEventData, CylinderState, EventLine, LifecyclePair } from "../src/dashboard/store/types.js";
import { issueColor, NEUTRAL_COLOR } from "../src/dashboard/shared/issue-colors.js";
import { StatusBar } from "../src/dashboard/components/status-bar.js";
import { LifecycleList } from "../src/dashboard/components/lifecycle-list.js";
import { EventStream } from "../src/dashboard/components/event-stream.js";
import { BroadcastEventCard } from "../src/dashboard/components/broadcast-event-card.js";

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

function flatten(value: unknown): string {
  if (value === null || value === undefined || typeof value === "symbol") return "";
  if (Array.isArray(value)) return value.map(flatten).join("");
  if (typeof value === "object" && "strings" in value && "values" in value) {
    const { strings, values } = value as { strings: readonly string[]; values: readonly unknown[] };
    return strings.reduce((out, s, i) => out + s + (i < values.length ? flatten(values[i]) : ""), "");
  }
  return String(value);
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
  const body = /^body\s*\{([^}]*)\}/m.exec(css)?.[1] ?? "";
  assert.match(body, /color:\s*var\(--trim\);/, "body text is trim gray");
});

test("the status bar marks a shutdown with a class, not an inline color", () => {
  const bar = new StatusBar();
  Object.assign(bar, { appShutdown: true });
  const markup = flatten(bar.render());
  assert.match(markup, /class="connection-status shutdown"/);
  assert.doesNotMatch(markup, /style=/);
  const css = readFileSync(GLOBAL_CSS, "utf-8");
  const rule = /^\.connection-status\.shutdown\s*\{([^}]*)\}/m.exec(css)?.[1] ?? "";
  assert.match(rule, /color:\s*var\(--color-orange\);/, "shut down reads orange, like the shut-down cylinders");
});

test("a pill for a PR that closes no issue takes the PR's own color, as its cylinder does (#280)", () => {
  const list = new LifecycleList();
  const orphan: LifecyclePair = { issue: null, pr: { number: 300, title: "Orphan", state: "open" }, prPhase: "review" };
  const withIssue: LifecyclePair = { issue: { number: 7, title: "X", state: "open" }, pr: null, prPhase: "planning" };
  Object.assign(list, { pairs: [orphan, withIssue], cylinders: [] as CylinderState[] });
  const colors = [...flatten(list.render()).matchAll(/data-key="([^"]+)"[\s\S]*?\.color=(#[0-9a-f]{6})/g)]
    .map((m) => m[2]);
  assert.deepEqual(colors.sort(), [issueColor(300).hex, issueColor(7).hex].sort());
  assert.ok(!colors.includes(NEUTRAL_COLOR), "no pill of work is gray");
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
