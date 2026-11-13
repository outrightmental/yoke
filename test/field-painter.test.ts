import test from "node:test";
import assert from "node:assert/strict";

import { YokeField } from "../src/dashboard/components/yoke-field.js";
import { Animator, PING_MS } from "../src/dashboard/field/animator.js";
import { eyeOpenness, glyphMoves, trackMarkX, trackWidth } from "../src/dashboard/field/glyphs.js";
import { layoutField, type FieldLayout, type Viewport } from "../src/dashboard/field/layout.js";
import { fieldModel } from "../src/dashboard/field/model.js";
import { Painter, type Surface } from "../src/dashboard/field/painter.js";
import { settleSpring, spring, SPRING_OMEGA, stepSpring } from "../src/dashboard/field/spring.js";
import { mono, sans, TextFitter } from "../src/dashboard/field/text.js";
import { buildInbox } from "../src/dashboard/shared/inbox.js";
import type { Rgb } from "../src/dashboard/field/palette.js";
import { issueColor } from "../src/dashboard/shared/issue-colors.js";
import { briefStatus, workViews } from "../src/dashboard/shared/work-view.js";
import { dashboardReducer, FAILURE_SHOW_MS, initialState } from "../src/dashboard/store/dashboard-store.js";
import type { CylinderState, DashboardState, LifecyclePair } from "../src/dashboard/store/types.js";
import {
  cylinder,
  fakeCanvas,
  fakeFitter,
  fakeSurface,
  flatten,
  makeEvent,
  paintField,
  parseRgba,
  stateWith,
  tokensPalette,
  triplet,
} from "./dashboard-helpers.js";

// The field is painted, so there is no markup to read back. These paint it on
// a canvas that only remembers what it was asked to draw, and check what was
// drawn, in what color, and how little is drawn again while nothing changes.

const NOW = Date.parse("2026-11-10T12:00:00Z");
const PALETTE = tokensPalette();

function issue(number: number, title: string, overrides: Partial<LifecyclePair> = {}): LifecyclePair {
  return { issue: { number, title, state: "open" }, pr: null, prPhase: "absent", ...overrides };
}

function burning(index: number, issueNumber: number, overrides: Partial<CylinderState> = {}): CylinderState {
  const c = issueColor(issueNumber);
  return cylinder({ index, issueNumber, color: c.hex, colorRgb: c.rgb, actionStartedAt: NOW - 84_000, model: "claude-sonnet-5-5", ...overrides });
}

const idle = (index: number): CylinderState =>
  cylinder({ index, status: "idle", actionType: null, issueNumber: null, nextCycleAtMs: NOW + 30_500 });

/** The field painted as it stands at NOW, so that no clock on it depends on when the test ran. */
const paint = (state: DashboardState, options: Parameters<typeof paintField>[1] = {}) =>
  paintField(state, { nowMs: NOW, ...options });

/** A dashboard with one engine implementing #7, one idle, and work at every other level. */
function busyState(overrides: Partial<DashboardState> = {}): DashboardState {
  return stateWith([
    issue(7, "Record working time", { prPhase: "planning" }),
    { issue: { number: 8, title: "Draw constellation rays", state: "open" }, pr: { number: 80, title: "Draw constellation rays", state: "open", draft: true, checksStatus: "pending" }, prPhase: "active" },
    issue(9, "Snap the compass to north"),
    { issue: { number: 10, title: "Refer to a Top Model", state: "open" }, pr: { number: 81, title: "Refer to a Top Model", state: "open", draft: false, checksStatus: "success" }, prPhase: "review", approval: "awaiting-approval" },
    issue(11, "Cache tiles by content hash", { blockedByIssueNumbers: [9] }),
    issue(12, "Paginate the digest", { prPhase: "inactive", projectStatus: "Backlog" }),
  ], "o/a", { cylinders: [burning(1, 7), idle(2)], ...overrides });
}

// ── springs ──────────────────────────────────────────────────────────────────

test("a spring reaches its target without ever overshooting it", () => {
  const s = spring(0);
  s.target = 300;
  let last = 0;
  let moving = true;
  for (let i = 0; i < 120 && moving; i++) {
    moving = stepSpring(s, 1 / 60);
    assert.ok(s.value >= last - 1e-9, "it only ever closes on its target");
    assert.ok(s.value <= 300 + 1e-9, "and never passes it");
    last = s.value;
  }
  assert.equal(moving, false, "inside two seconds it has arrived");
  assert.equal(s.value, 300);
  assert.equal(s.velocity, 0);
});

test("a spring lands in the same place whatever the frame rate", () => {
  const at = (frames: number): number => {
    const s = spring(0);
    s.target = 100;
    for (let i = 0; i < frames; i++) stepSpring(s, 0.3 / frames);
    return s.value;
  };
  const sixty = at(18);
  assert.ok(Math.abs(at(9) - sixty) < 0.5, "thirty frames a second");
  assert.ok(Math.abs(at(1) - sixty) < 0.5, "or one long frame: a slow machine sees fewer frames of a move, not a slower move");
  assert.ok(sixty > 90 && sixty < 100, `most of the way in a third of a second (${sixty.toFixed(1)})`);
  assert.ok(SPRING_OMEGA > 0);
});

test("a spring at rest stays at rest, and can be put straight to its target", () => {
  const s = spring(40);
  assert.equal(stepSpring(s, 1 / 60), false);
  s.target = 90;
  settleSpring(s);
  assert.deepEqual(s, { value: 90, velocity: 0, target: 90 });
});

// ── the animator ─────────────────────────────────────────────────────────────

const VIEW: Viewport = { width: 1400, height: 900, railWidth: 0, lampWidth: 132 };
const layoutOf = (state: DashboardState): FieldLayout => layoutField(fieldModel(state, NOW), VIEW);

test("the animator: everything fades in where it belongs the first time, and is simply there when motion is off", () => {
  const layout = layoutOf(busyState());
  const fading = new Animator();
  fading.sync(layout, 0);
  assert.ok(fading.placed().every((placed) => placed.alpha === 0), "not there yet");
  assert.ok(fading.placed().every((placed) => placed.x === placed.node.rect.x && placed.y === placed.node.rect.y), "but in its place");
  for (let i = 0; i < 40; i++) fading.step(1 / 60);
  assert.ok(fading.placed().every((placed) => placed.alpha === 1));

  const still = new Animator();
  still.sync(layout, 0, true);
  assert.ok(still.placed().every((placed) => placed.alpha === 1));
  assert.equal(still.step(1 / 60), false, "nothing to animate");
});

test("the animator: a piece of work whose state changes moves to its new place, and is the same node all the way", () => {
  const animator = new Animator();
  const state = busyState();
  animator.sync(layoutOf(state), 0, true);
  const before = animator.find("work:o/a#8")!;
  assert.equal(before.node.kind === "work" && before.node.level, "queued");

  // Its checks pass, its self-review is clean, and it is parked for approval:
  // it is no longer yoke's to work next, so it sinks a stratum.
  const parked = stateWith(
    state.lastLifecyclePairs.map((pair) =>
      pair.issue?.number === 8
        ? { ...pair, prPhase: "review", approval: "awaiting-approval" as const, pr: { ...pair.pr!, draft: false, checksStatus: "success" } }
        : pair),
    "o/a",
    { cylinders: state.cylinders },
  );
  const target = layoutOf(parked);
  animator.sync(target, 1000);
  const goal = target.nodes.find((node) => node.id === "work:o/a#8")!;
  assert.equal(goal.kind === "work" && goal.level, "waiting");
  assert.ok(goal.rect.y > before.y, "it has somewhere new to be, lower down");

  assert.equal(animator.step(1 / 60), true);
  const under = animator.find("work:o/a#8")!;
  assert.ok(before.y < under.y && under.y < goal.rect.y, "on its way, between the two");
  for (let i = 0; i < 120; i++) animator.step(1 / 60);
  assert.equal(animator.find("work:o/a#8")!.y, goal.rect.y);
  assert.equal(animator.step(1 / 60), false, "and then the field is still again");
});

test("the animator: something on its way is drawn faint, and firms up as it arrives", () => {
  const animator = new Animator();
  animator.sync(layoutOf(busyState({ cylinders: [burning(1, 7), idle(2)] })), 0, true);
  // The queued work is taken away, so what was below it has a long way to rise.
  const state = busyState();
  const fewer = stateWith(state.lastLifecyclePairs.filter((pair) => pair.issue?.number === 7 || pair.issue?.number === 12), "o/a", { cylinders: state.cylinders });
  animator.sync(layoutOf(fewer), 0);
  animator.step(1 / 600);
  const rising = animator.placed().find((placed) => placed.node.id === "work:o/a#12")!;
  assert.ok(rising.alpha < 1, `faint while it travels (${rising.alpha.toFixed(2)})`);
  for (let i = 0; i < 120; i++) animator.step(1 / 60);
  assert.equal(animator.placed().find((placed) => placed.node.id === "work:o/a#12")!.alpha, 1);
});

test("the animator: what leaves the field fades where it was, and is then gone", () => {
  const animator = new Animator();
  const state = busyState();
  animator.sync(layoutOf(state), 0, true);
  const fewer = stateWith(state.lastLifecyclePairs.filter((pair) => pair.issue?.number !== 12), "o/a", { cylinders: state.cylinders });
  animator.sync(layoutOf(fewer), 0);

  assert.equal(animator.find("work:o/a#12"), null, "no longer of the field");
  assert.ok(animator.placed().some((placed) => placed.node.id === "work:o/a#12"), "but still drawn, fading");
  for (let i = 0; i < 30; i++) animator.step(1 / 60);
  assert.ok(!animator.placed().some((placed) => placed.node.id === "work:o/a#12"));
});

test("the animator: an engine keeps its ring from the bench out to its work, growing as it goes", () => {
  const animator = new Animator();
  const waiting = stateWith([issue(9, "Snap the compass")], "o/a", { cylinders: [idle(1)] });
  animator.sync(layoutOf(waiting), 0, true);
  const onBench = animator.find("engine:0")!;
  assert.equal(onBench.node.kind === "engine" && onBench.node.mode, "bench");

  const started = stateWith([issue(9, "Snap the compass", { prPhase: "planning" })], "o/a", { cylinders: [burning(1, 9)] });
  animator.sync(layoutOf(started), 0);
  animator.step(1 / 60);
  const growing = animator.find("engine:0")!;
  assert.equal(growing.node.kind === "engine" && growing.node.mode, "reactor");
  assert.ok(growing.ring!.r > onBench.ring!.r && growing.ring!.r < (growing.node.kind === "engine" ? growing.node.ring.r : 0), "between a bench ring and a reactor's");
  // The words beside the ring are a different thing drawn in the same place: cross-faded, not tweened.
  assert.ok(animator.placed().some((placed) => placed.node.id === "work:o/a#9" && placed.node.kind === "work" && placed.node.mode === "row"), "the line it was fades out");
  assert.ok(animator.placed().some((placed) => placed.node.id === "work:o/a#9" && placed.node.kind === "work" && placed.node.mode === "reactor"), "as the reactor it is fades in");
});

test("the animator: a change of state sets off a ping; a clock ticking over does not", () => {
  const animator = new Animator();
  const state = busyState();
  animator.sync(layoutOf(state), 0, true);

  // A second later only the clocks differ.
  animator.sync(layoutField(fieldModel(state, NOW + 1000), VIEW), 1000);
  assert.deepEqual(animator.pings, []);

  // The checks on PR #80 finish.
  const passed = stateWith(
    state.lastLifecyclePairs.map((pair) => (pair.pr?.number === 80 ? { ...pair, pr: { ...pair.pr, checksStatus: "success" } } : pair)),
    "o/a",
    { cylinders: state.cylinders },
  );
  animator.sync(layoutOf(passed), 2000);
  assert.deepEqual(animator.pings, [{ id: "work:o/a#8", bornMs: 2000 }]);
  assert.equal(animator.prunePings(2000 + PING_MS - 1), true);
  assert.equal(animator.prunePings(2000 + PING_MS), false, "it runs its course and is dropped");
});

// ── fitting text ─────────────────────────────────────────────────────────────

test("text is cut with an ellipsis to the room it has, and left out when there is none", () => {
  const fitter = fakeFitter();
  const style = mono(400, 10); // 6 px a character, as the fake canvas measures it
  assert.equal(fitter.width("abcdef", style), 36);
  assert.equal(fitter.fit("abcdef", style, 36), "abcdef", "it fits: untouched");
  assert.equal(fitter.fit("abcdefghij", style, 36), "abcde…");
  assert.equal(fitter.fit("abc def ghi", style, 30), "abc…", "no space is left before the ellipsis");
  assert.equal(fitter.fit("abcdef", style, 6), "", "no room for one letter and the ellipsis: nothing, not a lone …");
  assert.equal(fitter.fit("abcdef", style, 0), "");
  assert.equal(fitter.fit("", style, 100), "");
});

test("a title is broken at spaces over the lines it is allowed, the last one cut to fit", () => {
  const fitter = fakeFitter();
  const style = sans(600, 10);
  assert.deepEqual(fitter.wrap("one two three", style, 600, 2), ["one two three"]);
  assert.deepEqual(fitter.wrap("one two three four", style, 54, 2), ["one two", "three fo…"], "the last line takes all that is left, and is cut");
  assert.deepEqual(fitter.wrap("one two three four", style, 54, 3), ["one two", "three", "four"]);
  assert.deepEqual(fitter.wrap("one two three", style, 54, 1), ["one two…"]);
  assert.deepEqual(fitter.wrap("supercalifragilistic word", style, 54, 2), ["supercal…", "word"], "a word too long for a line is cut the same way");
  assert.deepEqual(fitter.wrap("", style, 54, 2), []);
});

test("a measurement is taken once and remembered, until the fonts change", () => {
  let measured = 0;
  const fitter = new TextFitter((text) => {
    measured++;
    return text.length * 6;
  });
  const style = mono(400, 10);
  fitter.fit("a long line of text", style, 60);
  const first = measured;
  fitter.fit("a long line of text", style, 60);
  fitter.width("a long line of text", style);
  assert.equal(measured, first, "nothing is measured twice");
  fitter.clear();
  fitter.width("a long line of text", style);
  assert.equal(measured, first + 1, "a font loading makes every width stale");
});

// ── what is painted ──────────────────────────────────────────────────────────

test("the painter: a reactor says what its engine is doing, on what, for how long, and where the work has got to", () => {
  const painted = paint(busyState());

  assert.ok(painted.texts.includes("IMPLEMENTING"), "the action, in capitals");
  assert.equal(painted.inkOf("IMPLEMENTING")?.rgb, issueColor(7).rgb, "in the color of its work, at full saturation");
  assert.ok(painted.texts.includes("· Claude Sonnet 5.5"), "the model running it");
  assert.ok(painted.texts.includes("1m 24s"), "its clock, in the ring");
  assert.ok(painted.texts.includes("ENGINE 1"));
  assert.ok(painted.texts.includes("#7") && painted.texts.includes("Record working time"));
  assert.ok(painted.texts.includes("BUILD"), "the stage it has reached");
});

test("the painter: every stratum is headed by its level and how much is in it", () => {
  const painted = paint(busyState());
  for (const heading of ["BURNING", "QUEUED", "WAITING", "COLD"]) assert.ok(painted.texts.includes(heading), heading);
  assert.ok(painted.texts.includes("1/2"), "one engine of two is burning");
  assert.ok(painted.texts.includes("an engine is running an action"));
  assert.ok(painted.texts.includes("yoke works these next"));
  assert.ok(painted.texts.includes("on someone else first"));
  assert.ok(painted.texts.includes("nothing coming"));
});

test("the painter: a line of work is its number, its title, and where it stands", () => {
  const painted = paint(busyState());
  const work = (n: number) => workViews(busyState(), NOW).find((candidate) => candidate.number === n)!;

  assert.equal(painted.inkOf("#11")?.rgb, work(11).color.rgb, "the number is in the work's color at its level");
  assert.equal(painted.inkOf("#11")?.rgb, triplet(PALETTE.trimDim), "which, below the reactors, is gray (#286)");
  assert.ok(painted.texts.includes("Cache tiles by content hash"));
  assert.equal(painted.inkOf("blocked by #9")?.rgb, triplet(PALETTE.orange), "a block is orange");
  assert.equal(painted.inkOf("checks running")?.rgb, triplet(PALETTE.trimBright));
  assert.ok(painted.texts.includes("awaiting approval"), "in a word or two on a one-line row: the sentence is on its inbox card");
  assert.ok(painted.texts.includes("Backlog"));
  assert.ok(painted.texts.includes("PR #80"), "a line with room for a second says which PR");
  // Heat is brightness too: the hotter the stratum, the firmer the ink.
  assert.ok(painted.inkOf("Snap the compass to north")!.alpha > painted.inkOf("Cache tiles by content hash")!.alpha);
  assert.ok(painted.inkOf("Cache tiles by content hash")!.alpha > painted.inkOf("Paginate the digest")!.alpha);
});

// ── colour below the reactors (#286) ────────────────────────────────────────

/** WCAG contrast of `fill` ("rgba(r,g,b,a)") laid over the gray `ground`. */
function contrastOver(fill: string, ground: number): number {
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(fill);
  assert.ok(m, fill);
  const a = Number(m[4]);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (rgb: number[]) => 0.2126 * lin(rgb[0]! / 255) + 0.7152 * lin(rgb[1]! / 255) + 0.0722 * lin(rgb[2]! / 255);
  const over = [1, 2, 3].map((i) => ground + (Number(m[i]) - ground) * a);
  const [hi, lo] = [lum(over), lum([ground, ground, ground])].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

test("the painter: below the reactors every other line lies on a band, counted down each column", () => {
  const pairs = Array.from({ length: 7 }, (_, i) => issue(100 + i, `Queued ${i}`))
    .concat(Array.from({ length: 3 }, (_, i) => issue(200 + i, `Blocked ${i}`, { blockedByIssueNumbers: [100] })));
  const painted = paint(stateWith(pairs, "o/a", { cylinders: [idle(1)] }), { viewport: { width: 1600 } });
  const headers = painted.layout.nodes.filter((node) => node.kind === "header");
  const bandsOf = (level: string) => {
    const header = headers.find((node) => node.kind === "header" && node.level === level);
    assert.ok(header && header.kind === "header");
    return header.bands;
  };
  assert.deepEqual(bandsOf("burning"), [], "the reactors have their hue, and no bands");

  // Seven lines in two columns are four and three: the second and fourth of
  // the first, and the second of the next.
  const queued = painted.layout.nodes.filter((node) => node.kind === "work" && node.level === "queued");
  const columns = [...new Set(queued.map((node) => node.rect.x))];
  assert.equal(columns.length, 2);
  const banded = (node: (typeof queued)[number]) => bandsOf("queued").some((band) => band.x === node.rect.x && band.y === node.rect.y);
  for (const x of columns) {
    const column = queued.filter((node) => node.rect.x === x).sort((a, b) => a.rect.y - b.rect.y);
    column.forEach((node, i) => assert.equal(banded(node), i % 2 === 1, `line ${i} of its column`));
  }
  assert.equal(bandsOf("waiting").length, 1, "and the same in every stratum below");

  // Each band is painted once, as a soft lift of the trim, behind its line.
  const bands = painted.shapes.filter((shape) => shape.boxes.length === 1 && parseRgba(shape.fill)?.rgb === triplet(PALETTE.trimBright));
  assert.equal(bands.length, bandsOf("queued").length + bandsOf("waiting").length);
  for (const band of bands) assert.ok(parseRgba(band.fill)!.alpha < 0.05, "felt more than seen");
  const ground = PALETTE.bg[0];
  const lifted = Math.round(ground + (PALETTE.trimBright[0] - ground) * parseRgba(bands[0]!.fill)!.alpha);
  const step = contrastOver(`rgba(${lifted},${lifted},${lifted},1)`, ground);
  assert.ok(step > 1.04 && step < 1.1, `a band is a step off the ground (${step.toFixed(3)}:1)`);
  const firstBand = painted.calls.findIndex((call) => call.method === "roundRect");
  const firstWord = painted.calls.findIndex((call) => call.method === "fillText" && call.args[0] === "Queued 0");
  assert.ok(firstBand < firstWord, "under the words");
});

test("the painter: a band belongs to its stratum, so it moves with the stratum and not with the lines sliding past it", () => {
  const before = stateWith([issue(1, "A"), issue(2, "B"), issue(3, "C"), issue(4, "D")], "o/a", { cylinders: [idle(1)] });
  const after = stateWith([issue(2, "B"), issue(3, "C"), issue(4, "D")], "o/a", { cylinders: [idle(1)] });
  const viewport = { width: 700, height: 900, railWidth: 0, lampWidth: 0 };
  const first = layoutField(fieldModel(before, NOW), viewport);
  const second = layoutField(fieldModel(after, NOW), viewport);
  const header = (layout: FieldLayout) => layout.nodes.find((node) => node.id === "header:queued");
  const bandYs = (layout: FieldLayout) => {
    const node = header(layout);
    return node && node.kind === "header" ? node.bands.map((band) => band.y) : [];
  };
  assert.deepEqual(bandYs(second), bandYs(first).slice(0, 1), "#1 left: the lines close up, and the band under the second stays where it was");

  const animator = new Animator();
  animator.sync(first, 0, true);
  animator.sync(second, 0);
  animator.step(0.05);
  const placed = animator.placed();
  const line = placed.find((p) => p.node.id === "work:o/a#3")!;
  const head = placed.find((p) => p.node.id === "header:queued")!;
  assert.ok(line.y > line.node.rect.y, "#3 is still sliding up");
  assert.equal(head.y, head.node.rect.y, "while its stratum, and so its bands, stay put");
});

test("the painter: below the reactors a line keeps its issue's hue in one mark — the one its track has reached", () => {
  const state = busyState();
  const painted = paint(state);
  for (const work of workViews(state, NOW).filter((candidate) => !candidate.engine)) {
    const node = painted.layout.nodes.find((candidate) => candidate.id === `work:${work.key}`)!;
    const marks = painted.shapes.filter((shape) => parseRgba(shape.fill)?.rgb === work.hue.rgb);
    assert.equal(marks.length, 1, `#${work.number}: one mark of its hue`);
    const [cx, cy, r] = marks[0]!.arcs[0]!;
    const rowCy = node.kind === "work" && node.lines === 2 ? node.rect.y + 15 : node.rect.y + node.rect.h / 2;
    assert.equal(cx, painted.layout.nodes.includes(node) ? trackMarkX(node.rect.x + 2, work.stage, { pitch: 8, dot: 2.6 }) : NaN, `#${work.number} at its stage`);
    assert.equal(cy, rowCy);
    assert.equal(r, 2.6);
  }
  // The reactor is in the burning stratum: its hue is everywhere on it.
  assert.equal(painted.inkOf("#7")?.rgb, issueColor(7).rgb);
  assert.equal(painted.inkOf("BUILD")?.rgb, issueColor(7).rgb);
});

test("the painter: a line's one signal colors its status and the mark at its end, at full strength in every stratum", () => {
  const failure = {
    key: "o/a#pr-90", repo: "o/a", actionType: "start-implementation", issueNumber: 12, prNumber: 90,
    issueTitle: null, prTitle: null, error: "boom", atMs: NOW - 60_000, engineIndex: 0,
  };
  const state = stateWith([
    issue(11, "Cache tiles", { blockedByIssueNumbers: [9] }),
    { issue: { number: 12, title: "Failed once", state: "open" }, pr: { number: 90, title: "Failed once", state: "open", draft: true, checksStatus: "success" }, prPhase: "active" },
    { issue: { number: 13, title: "Failing checks", state: "open" }, pr: { number: 91, title: "Failing checks", state: "open", draft: true, checksStatus: "failure" }, prPhase: "active" },
    { issue: { number: 14, title: "For review", state: "open" }, pr: { number: 92, title: "For review", state: "open", draft: false, checksStatus: "success" }, prPhase: "review" },
    { issue: { number: 15, title: "Approved", state: "open" }, pr: { number: 93, title: "Approved", state: "open", draft: false, checksStatus: "success" }, prPhase: "review", approval: "approved" },
    { issue: { number: 16, title: "Merged", state: "open" }, pr: { number: 94, title: "Merged", state: "open", checksStatus: "success" }, prPhase: "completed" },
  ], "o/a", { cylinders: [idle(1)], failures: new Map([[failure.key, failure]]) });
  const painted = paint(state);
  const expected: Array<[string, Rgb | null]> = [
    ["blocked by #9", PALETTE.orange],
    ["implementing failed", PALETTE.red],
    ["checks failing", PALETTE.red],
    ["ready for review", PALETTE.yellow],
    ["approved", PALETTE.green],
    ["merged", null],
  ];
  for (const [text, color] of expected) {
    // A roomy line says the whole sentence, a tight one the first words of it.
    const fill = painted.fills.find((candidate) => candidate.text.startsWith(text));
    const ink = fill ? parseRgba(fill.fill) : undefined;
    assert.ok(ink, `"${text}" is said`);
    if (color === null) {
      assert.equal(ink.rgb, triplet(PALETTE.trimDim), `"${text}" is neutral`);
    } else {
      assert.equal(ink.rgb, triplet(color), `"${text}"`);
      assert.equal(ink.alpha, 1, `"${text}" does not cool with its stratum`);
    }
  }
  // The mark at the end of each line is drawn in its line's signal, and a
  // line with none has a gray one.
  const pairs = state.lastLifecyclePairs;
  const saturatedStrokes = (only: LifecyclePair) => {
    const one = paint(stateWith([only], "o/a", { cylinders: [idle(1)], failures: state.failures }));
    return new Set(one.strokes.map((stroke) => parseRgba(stroke)?.rgb).filter((rgb): rgb is string => {
      if (!rgb) return false;
      const [r, g, b] = rgb.split(",");
      return !(r === g && g === b);
    }));
  };
  const byNumber = (n: number) => pairs.find((pair) => pair.issue?.number === n)!;
  assert.deepEqual([...saturatedStrokes(byNumber(11))], [triplet(PALETTE.orange)], "a barred circle, orange");
  assert.deepEqual([...saturatedStrokes(byNumber(12))], [triplet(PALETTE.red)], "a failed action's cross, red");
  assert.deepEqual([...saturatedStrokes(byNumber(13))], [triplet(PALETTE.red)], "failing checks' cross, red");
  assert.deepEqual([...saturatedStrokes(byNumber(15))], [triplet(PALETTE.green)], "an approval's check, green");
  assert.deepEqual([...saturatedStrokes(byNumber(16))], [], "a merge's check, gray");
});

test("the painter: below the reactors every word clears its contrast floor on the ground", () => {
  const state = busyState({ cylinders: [idle(1), idle(2)] });
  const painted = paint(state);
  const ground = PALETTE.bg[0];
  for (const node of painted.layout.nodes) {
    if (node.kind !== "work" || node.mode !== "row") continue;
    const { work } = node;
    for (const [text, floor] of [[work.title, 4.5], [`#${work.number}`, 4.5]] as const) {
      const fill = painted.fills.find((candidate) => candidate.text === text)?.fill;
      assert.ok(fill, text);
      const ratio = contrastOver(fill, ground);
      assert.ok(ratio >= floor, `${node.level}: "${text}" at ${ratio.toFixed(2)}:1`);
    }
    const status = briefStatus(work.status) || work.status.text;
    const fill = painted.fills.find((candidate) => candidate.text === status)?.fill;
    if (!fill) continue;
    const ratio = contrastOver(fill, ground);
    const floor = work.status.signal ? 4.5 : 3;
    assert.ok(ratio >= floor, `${node.level}: status "${status}" at ${ratio.toFixed(2)}:1`);
  }
});

test("the painter: a reactor keeps its hue while its work has gone dark, and a tether keeps the hue of its work (#286)", () => {
  const dark = busyState({ shutdownRequested: true });
  const frozen = new Map(workViews(busyState(), NOW).map((work) => [work.key, work.activity] as const));
  const painted = paint({ ...dark, frozenPillActivity: frozen });
  assert.equal(painted.inkOf("#7")?.rgb, issueColor(7).rgb, "its engine is still finishing: the reactor keeps the hue");

  const state = busyState();
  const cards = buildInbox({
    works: workViews(state, NOW), failures: [], keepAwake: "awake", dismissed: new Set(), arrivals: new Map(), nowMs: NOW, failureShowMs: FAILURE_SHOW_MS,
  });
  assert.equal(cards[0]?.color?.hex, issueColor(10).hex, "the card is edged in the work's hue, though its line is gray");
  const tethered = paint(state, { cards, anchors: new Map([["approval:o/a#81", { x: 1100, y: 120 }]]), viewport: { railWidth: 340 } });
  const dot = tethered.shapes.at(-1)!;
  assert.equal(parseRgba(dot.fill)?.rgb, issueColor(10).rgb, "and so is the tether that joins them");
});

test("the painter: a status that says only what its stratum says is left unsaid on a one-line row", () => {
  const many = stateWith(
    Array.from({ length: 30 }, (_, i) => issue(100 + i, `Queued ${i}`)).concat(Array.from({ length: 30 }, (_, i) => issue(200 + i, `Blocked ${i}`, { blockedByIssueNumbers: [100] }))),
    "o/a",
    { cylinders: [idle(1)] },
  );
  const dense = paint(many, { viewport: { height: 700 } });
  assert.ok(dense.layout.density > 0, "dense enough for one line each");
  assert.ok(dense.texts.includes("Queued 0"));
  assert.ok(!dense.texts.includes("waiting for an engine"), "thirty lines do not each say they are waiting their turn");
  assert.ok(dense.texts.includes("blocked by #100"), "what a line alone can say, it says");

  const roomy = paint(stateWith([issue(100, "Queued 0")], "o/a", { cylinders: [idle(1)] }));
  assert.ok(roomy.texts.includes("waiting for an engine"), "with a second line to say it on, it is said");
});

test("the painter: a project is named on its work only when several share the dashboard", () => {
  const pairs = [{ ...issue(9, "Snap the compass"), repo: "northwind/atlas" }];
  const single = paint(stateWith(pairs, "northwind/atlas", { cylinders: [idle(1)] }));
  assert.ok(!single.texts.includes("atlas"));
  const multi = paint(stateWith(pairs, "northwind/atlas", { cylinders: [idle(1)], multiProject: true }));
  assert.ok(multi.texts.includes("atlas"), "by its name alone, when every project has the one owner");
});

test("the painter: the bench says each idle engine's number and what it waits on, in trim", () => {
  const painted = paint(busyState());
  assert.ok(painted.texts.includes("2"), "the engine's number, in its ring");
  assert.equal(painted.inkOf("idle · 31s")?.rgb, triplet(PALETTE.trimDim));
});

test("the painter: a hold is said across the top of the field, in the colors of a hold", () => {
  const untilMs = NOW + 2 * 3_600_000 + 14 * 60_000 + 20_000;
  const painted = paint(busyState({ hold: { kind: "claude-usage-limit", reason: "Claude usage limit", untilMs }, cylinders: [idle(1), idle(2)] }));

  const waiting = painted.fills.filter((fill) => fill.text === "WAITING").map((fill) => fill.fill);
  assert.ok(waiting.some((fill) => fill.includes(triplet(PALETTE.orange))));
  assert.equal(painted.inkOf("UNTIL")?.rgb, triplet(PALETTE.orange));
  assert.equal(painted.inkOf("2H 14M")?.rgb, triplet(PALETTE.yellow));
  assert.ok(painted.texts.includes("for Claude usage limit · no work is planned or started until then"));
  assert.ok(painted.texts.includes("every engine is parked"));
});

test("the painter: the last lines of the log run along the bottom, each in its engine's color or its outcome's", () => {
  let state = busyState();
  // Stamped by this file's clock, like everything else it paints.
  const at = new Date(NOW).toISOString();
  state = dashboardReducer(state, makeEvent("action-start", { actionIndex: 1, totalActions: 2, type: "start-implementation", issueNumber: 7, repo: "o/a", description: "Implement #7", startedAt: NOW }, at));
  state = dashboardReducer(state, makeEvent("log-message", { level: "error", message: "it broke" }, at));
  const painted = paint(state);

  assert.equal(painted.inkOf("▶ [1/2] Implement #7")?.rgb, issueColor(7).rgb, "an engine's line is its work's color");
  assert.equal(painted.inkOf("it broke")?.rgb, triplet(PALETTE.red));
  assert.ok(painted.texts.includes("ISSUE · BUILD · DRAFT · READY · MERGED"), "and a key to the five marks");
});

test("the painter: with no work to draw it says so, and still draws the instruments", () => {
  const painted = paint({ ...initialState(), title: "Outright Mental" });
  assert.ok(painted.texts.includes("Connecting to yoke…"));
  assert.ok(painted.texts.includes("OUTRIGHT MENTAL"));
  assert.ok(painted.texts.includes("CLAUDE"), "the usage gauge, which names no window until it has read one");
});

// ── tethers ──────────────────────────────────────────────────────────────────

test("the painter: a tether runs from its work out to a gutter, along it, and in to its card — never across the field", () => {
  const state = busyState();
  const cards = buildInbox({
    works: workViews(state, NOW), failures: [], keepAwake: "awake", dismissed: new Set(), arrivals: new Map(), nowMs: NOW, failureShowMs: FAILURE_SHOW_MS,
  });
  assert.deepEqual(cards.map((card) => card.id), ["approval:o/a#81"]);

  const untethered = paint(state, { cards });
  assert.ok(!untethered.calls.some((call) => call.method === "arcTo"), "a card the inbox has not placed yet has nothing to be joined to");

  const anchor = { x: 1100, y: 120 };
  const painted = paint(state, { cards, anchors: new Map([["approval:o/a#81", anchor]]), viewport: { railWidth: 340 } });
  const corners = painted.calls.filter((call) => call.method === "arcTo").map((call) => call.args as number[]);
  assert.equal(corners.length, 2, "two corners: out to the gutter, and in to the card");
  const fieldRight = painted.layout.scroll.x + painted.layout.scroll.w;
  const [first, second] = corners;
  assert.ok(first![0]! > fieldRight && first![0]! < anchor.x, "the gutter is between the field and the inbox");
  assert.equal(first![0], second![0], "and it runs straight up and down it");
  assert.equal(second![1], anchor.y, "to the height of its card");
  const row = painted.layout.nodes.find((node) => node.id === "work:o/a#10")!;
  assert.ok(Math.abs(first![1]! - (painted.layout.scroll.y + row.rect.y + row.rect.h)) < 1, "leaving along the rule under its own line of work");
});

// ── what never stops moving ──────────────────────────────────────────────────

test("the painter: between changes only the moving marks are painted again, each in a small box of its own", () => {
  const painted = paint(busyState());
  const again = fakeCanvas();
  const boxes = painted.painter.paintDynamic(again.ctx, painted.frame, 1.5);

  assert.equal(again.texts.length, 0, "not a letter is drawn again");
  assert.equal(boxes.length, 3, "the comet on the one burning ring, the checks in orbit, the eye on the PR ready for review");
  const field = painted.layout.viewport.width * painted.layout.viewport.height;
  const touched = boxes.reduce((sum, box) => sum + box.w * box.h, 0);
  assert.ok(touched < field / 50, `a sliver of the field (${((touched / field) * 100).toFixed(2)}%)`);
  assert.equal(painted.painter.hasMotion(painted.frame), true);
});

test("the painter: with no engine burning and nothing in motion, the field asks for no frames at all", () => {
  const quiet = paint(stateWith([issue(9, "Snap the compass"), issue(11, "Cache tiles", { blockedByIssueNumbers: [9] })], "o/a", { cylinders: [idle(1)] }));
  assert.equal(quiet.painter.hasMotion(quiet.frame), false);
  assert.deepEqual(quiet.painter.paintDynamic(fakeCanvas().ctx, quiet.frame, 1.5), []);
});

test("the painter: asked for less motion, nothing loops — the marks are drawn once, still", () => {
  const painted = paint(busyState(), { reducedMotion: true });
  assert.equal(painted.painter.hasMotion(painted.frame), false, "no frame is asked for");
  const a = fakeCanvas();
  const b = fakeCanvas();
  painted.painter.paintDynamic(a.ctx, painted.frame, 1.5);
  painted.painter.paintDynamic(b.ctx, painted.frame, 9.25);
  assert.deepEqual(a.calls, b.calls, "the same picture whenever it is drawn");
});

test("the painter: dark work keeps its mark, frozen — only an engine still finishing its action goes on turning (#268)", () => {
  const dark = busyState({ shutdownRequested: true });
  const frozen = new Map(workViews(busyState(), NOW).map((work) => [work.key, work.activity] as const));
  const painted = paint({ ...dark, frozenPillActivity: frozen });
  const boxes = painted.painter.paintDynamic(fakeCanvas().ctx, painted.frame, 1.5);
  assert.equal(boxes.length, 1, "the comet, and nothing else");

  const stopped = paint({ ...dark, frozenPillActivity: frozen, cylinders: [cylinder({ index: 1, status: "shutdown" }), cylinder({ index: 2, status: "shutdown" })] });
  assert.equal(stopped.painter.hasMotion(stopped.frame), false, "once the engines have stopped, so has the field");
});

test("the painter: the ground is painted once and copied from then on, and the glow is a few small sprites", () => {
  const made: Array<[number, number]> = [];
  const surface = (width: number, height: number): Surface => {
    made.push([width, height]);
    return fakeSurface(width, height);
  };
  const state = busyState();
  const model = fieldModel(state, NOW);
  const layout = layoutField(model, VIEW);
  const animator = new Animator();
  animator.sync(layout, 0, true);
  const painter = new Painter(PALETTE, fakeFitter(), surface);
  const frame = { ...paint(state).frame, layout, model, placed: animator.placed(), pixelRatio: 2 };

  painter.paintStatic(fakeCanvas().ctx, frame);
  const first = made.length;
  assert.ok(made.some(([w, h]) => w === VIEW.width * 2 && h === VIEW.height * 2), "a layer for the ground, at the canvas's own resolution");
  painter.paintStatic(fakeCanvas().ctx, frame);
  painter.paintStatic(fakeCanvas().ctx, frame);
  assert.equal(made.length, first, "nothing is made again for a second picture of the same size");
  assert.ok(made.every(([w, h]) => (w === VIEW.width * 2 && h === VIEW.height * 2) || w * h <= 96 * 96), "and nothing else is bigger than a sprite");

  painter.reset();
  painter.paintStatic(fakeCanvas().ctx, frame);
  assert.ok(made.length > first, "a canvas that lost its layers gets them back");
});

// ── the marks ────────────────────────────────────────────────────────────────

test("the track's marks are evenly set, and only the marks that move are redrawn", () => {
  const style = { pitch: 8, dot: 2.6 };
  assert.equal(trackMarkX(10, 0, style), 12.6);
  assert.equal(trackMarkX(10, 4, style) - trackMarkX(10, 0, style), 32);
  assert.equal(trackWidth(5, style), 37.2);
  assert.equal(glyphMoves("checks"), true);
  assert.equal(glyphMoves("eye"), true);
  for (const still of ["engine", "person", "approved", "failing", "blocked", "merged", null] as const) {
    assert.equal(glyphMoves(still), false, String(still));
  }
  assert.equal(eyeOpenness(1), 1, "open");
  assert.ok(eyeOpenness(0.08) < 0.2, "with a blink now and then");
});

// ── the same picture, as markup ──────────────────────────────────────────────

test("the field renders everything it paints as markup too, for a screen reader and the keyboard", () => {
  const field = new YokeField();
  field.model = fieldModel({ ...busyState(), title: "Outright Mental", owner: "o", repo: "a" }, NOW);
  const html = flatten(field.render()).replace(/\s+/g, " ");

  assert.match(html, /<canvas class="field-canvas" aria-hidden="true"><\/canvas>/, "the canvas itself is not for a screen reader");
  assert.match(html, /<h1><a class="gh-link" data-node="title" href="https:\/\/github\.com\/o\/a" target="_blank" rel="noopener noreferrer">Outright Mental<\/a><\/h1>/);
  assert.match(html, /<h2>Engines: 1 of 2 burning<\/h2>/);
  assert.match(html, /<li data-node="engine:0"> Engine 1: implementing #7 · [\dms ]+ · Claude Sonnet 5\.5 <\/li>/);
  assert.match(html, /<h2>Burning \(1\)<\/h2>/);
  assert.match(html, /<h2>Queued \(2\)<\/h2>/);
  assert.match(html, /<h2>Waiting \(2\)<\/h2>/);
  assert.match(html, /<h2>Cold \(1\)<\/h2>/);
  assert.match(html, /<a class="gh-link" data-node="work:o\/a#8" href="https:\/\/github\.com\/o\/a\/issues\/8" target="_blank" rel="noopener noreferrer">#8 Draw constellation rays<\/a> · <a class="gh-link" href="https:\/\/github\.com\/o\/a\/pull\/80" target="_blank" rel="noopener noreferrer">PR #80<\/a> · checks running/);
  assert.match(html, /blocked by #9/);
  assert.equal(html.match(/data-node="work:/g)?.length, 6, "every piece of work, once");
});

test("the field's markup says a hold and a shutdown in words", () => {
  const field = new YokeField();
  field.model = fieldModel({ ...busyState(), hold: { kind: "claude-usage-limit", reason: "Claude usage limit", untilMs: NOW + 3_600_000 }, shutdownRequested: true }, NOW);
  const html = flatten(field.render()).replace(/\s+/g, " ");
  assert.match(html, /role="status"> Waiting <span class="hold-duration">1h 0m<\/span> until <span class="hold-deadline">[^<]+<\/span> for Claude usage limit · no work is planned or started until then/);
  assert.match(html, /Yoke is shutting down\./);

  field.model = null;
  assert.ok(!flatten(field.render()).includes("field-mirror"), "before the first state there is only the canvas");
});
