import test from "node:test";
import assert from "node:assert/strict";

import {
  DENSITIES,
  HOLD_HEIGHT,
  HUD_HEIGHT,
  hitTest,
  layoutField,
  maxScroll,
  type FieldLayout,
  type FieldNode,
  type Viewport,
  type WorkNode,
} from "../src/dashboard/field/layout.js";
import { fieldModel, fieldRepoLabels, levelCounts, repoLabels, RIBBON_MAX_LINES, stratumLevel } from "../src/dashboard/field/model.js";
import { issueColor } from "../src/dashboard/shared/issue-colors.js";
import { dashboardReducer, initialState } from "../src/dashboard/store/dashboard-store.js";
import type { CylinderState, DashboardState, LifecyclePair } from "../src/dashboard/store/types.js";
import { cylinder, makeEvent, stateWith, withPairs } from "./dashboard-helpers.js";

// The layout is where the field answers what it was built to answer: nothing
// on it has a box of fixed size to be fitted into. These pin that a piece of
// work takes the room its state has earned, that the whole field steps down
// to denser sizes before it scrolls, and that things stay where they are
// unless their own state changed.

const NOW = Date.parse("2026-11-10T12:00:00Z");
const DESK: Viewport = { width: 1512, height: 860, railWidth: 378, lampWidth: 132 };

function issue(number: number, overrides: Partial<LifecyclePair> = {}): LifecyclePair {
  return { issue: { number, title: `Issue ${number}`, state: "open" }, pr: null, prPhase: "absent", ...overrides };
}

function burning(index: number, issueNumber: number): CylinderState {
  const c = issueColor(issueNumber);
  return cylinder({ index, issueNumber, color: c.hex, colorRgb: c.rgb });
}

function idle(index: number): CylinderState {
  return cylinder({ index, status: "idle", actionType: null, issueNumber: null, nextCycleAtMs: NOW + 30_000 });
}

type Counts = { queued?: number; waiting?: number; cold?: number };

/** `queued` unblocked issues from #100, `waiting` blocked ones from #200 and `cold` out of the queue from #300. */
function levelPairs(counts: Counts): LifecyclePair[] {
  const pairs: LifecyclePair[] = [];
  for (let i = 0; i < (counts.queued ?? 0); i++) pairs.push(issue(100 + i));
  for (let i = 0; i < (counts.waiting ?? 0); i++) pairs.push(issue(200 + i, { blockedByIssueNumbers: [100] }));
  for (let i = 0; i < (counts.cold ?? 0); i++) pairs.push(issue(300 + i, { prPhase: "inactive", projectStatus: "Backlog" }));
  return pairs;
}

/** What each engine burning in project o/a is implementing. */
function burningPairs(engines: CylinderState[]): LifecyclePair[] {
  return engines.flatMap((cyl) => (cyl.status === "active" && cyl.issueNumber !== null ? [issue(cyl.issueNumber, { prPhase: "planning" })] : []));
}

/** A dashboard of one project, o/a, with `engines` and work at each level. */
function fieldState(engines: CylinderState[], counts: Counts = {}): DashboardState {
  return stateWith([...burningPairs(engines), ...levelPairs(counts)], "o/a", { cylinders: engines });
}

/** A dashboard shared by several projects, each with work at each level; the engines burn on o/a's. */
function projectsState(engines: CylinderState[], projects: ReadonlyArray<readonly [string, Counts]>): DashboardState {
  let state = stateWith(burningPairs(engines), "o/a", { cylinders: engines, multiProject: true });
  for (const [repo, counts] of projects) {
    state = withPairs(state, repo, [...(repo === "o/a" ? burningPairs(engines) : []), ...levelPairs(counts)]);
  }
  return state;
}

function lay(state: DashboardState, viewport: Viewport = DESK): FieldLayout {
  return layoutField(fieldModel(state, NOW), viewport);
}

const works = (layout: FieldLayout): WorkNode[] => layout.nodes.filter((node): node is WorkNode => node.kind === "work");
const rowsAt = (layout: FieldLayout, level: string): WorkNode[] => works(layout).filter((node) => node.mode === "row" && node.level === level);
const rowsOf = (layout: FieldLayout, repo: string): WorkNode[] => works(layout).filter((node) => node.mode === "row" && node.work.repo === repo);
const headerIds = (layout: FieldLayout): string[] => layout.nodes.filter((node) => node.kind === "header").map((node) => node.id);
const byId = (layout: FieldLayout, id: string): FieldNode => {
  const node = layout.nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `${id} is on the field`);
  return node;
};

function overlaps(a: FieldNode, b: FieldNode): boolean {
  return a.rect.x < b.rect.x + b.rect.w - 0.5 && b.rect.x < a.rect.x + a.rect.w - 0.5 &&
    a.rect.y < b.rect.y + b.rect.h - 0.5 && b.rect.y < a.rect.y + a.rect.h - 0.5;
}

// ── the model: what goes where ───────────────────────────────────────────────

test("the model: an engine running an action is a reactor with its work; the rest of the pool is on the bench", () => {
  const model = fieldModel(fieldState([burning(1, 7), idle(2), burning(3, 9)], { queued: 2, waiting: 1 }), NOW);

  assert.deepEqual(model.reactors.map((reactor) => [reactor.engine.index, reactor.work?.number]), [[0, 7], [2, 9]]);
  assert.deepEqual(model.bench.map((engine) => engine.index), [1]);
  assert.deepEqual(model.strata.map((stratum) => [stratum.repo, stratum.works.length]), [["o/a", 3]], "one project: one group, under its own name");
  assert.ok(model.strata.every((stratum) => stratum.works.every((work) => work.number !== 7 && work.number !== 9)), "burning work is drawn once, on its reactor");
  assert.equal(model.loaded, true);
});

test("the model: below the reactors work is grouped by project, in the order of the projects' names (#290)", () => {
  const state = projectsState([burning(1, 7)], [
    ["northwind/ledger", { queued: 1, waiting: 1 }],
    ["northwind/atlas", { cold: 2 }],
    ["o/a", {}],
    ["Northwind/beacon", { waiting: 1 }],
  ]);
  const model = fieldModel(state, NOW);
  assert.deepEqual(model.strata.map((stratum) => stratum.repo), ["northwind/atlas", "Northwind/beacon", "northwind/ledger"],
    "by name, whatever order they reported in, and o/a — whose only work is burning — has no group");
  for (const stratum of model.strata) {
    assert.ok(stratum.works.every((work) => work.repo === stratum.repo), `${stratum.repo} holds only its own work`);
  }
  assert.equal(model.strata.reduce((n, stratum) => n + stratum.works.length, 0), model.works.length - 1, "everything but the reactor, once");

  // The order holds as the work changes: it is the projects' names that set it.
  const later = withPairs(state, "northwind/atlas", levelPairs({ queued: 3 }));
  assert.deepEqual(fieldModel(later, NOW).strata.map((stratum) => stratum.repo), model.strata.map((stratum) => stratum.repo));
});

test("the model: within a project, queued work comes ahead of waiting work, and waiting ahead of cold", () => {
  const pairs = [
    issue(300, { prPhase: "inactive", projectStatus: "Backlog" }),
    issue(201, { blockedByIssueNumbers: [100] }),
    issue(101),
    { issue: { number: 50, title: "Merged", state: "open" }, pr: { number: 51, title: "Merged", state: "open", checksStatus: "success" }, prPhase: "completed" },
    issue(200, { blockedByIssueNumbers: [100] }),
    issue(100),
  ] satisfies LifecyclePair[];
  const [stratum] = fieldModel(stateWith(pairs, "o/a", { cylinders: [idle(1)] }), NOW).strata;
  assert.deepEqual(stratum!.works.map((work) => [stratumLevel(work), work.number]), [
    ["queued", 100], ["queued", 101], ["waiting", 200], ["waiting", 201], ["cold", 50], ["cold", 300],
  ]);
  assert.deepEqual(levelCounts(stratum!.works), [{ level: "queued", count: 2 }, { level: "waiting", count: 2 }, { level: "cold", count: 2 }]);
  assert.deepEqual(levelCounts(stratum!.works.slice(0, 2)), [{ level: "queued", count: 2 }], "a level with none is left out");
});

test("the model: work that names no project is grouped under the dashboard's own", () => {
  const state: DashboardState = { ...stateWith([issue(4), issue(5, { blockedByIssueNumbers: [4] })], "", { cylinders: [idle(1)] }), owner: "acme", repo: "app" };
  const model = fieldModel(state, NOW);
  assert.deepEqual(model.strata.map((stratum) => [stratum.repo, stratum.works.length]), [["acme/app", 2]]);
  assert.equal(fieldRepoLabels(model).get("acme/app"), "app", "and goes by its name, like any other project");
  const nameless = fieldModel({ ...state, owner: "", repo: "" }, NOW);
  assert.deepEqual(nameless.strata.map((stratum) => stratum.repo), [""], "with no name to give it, still one group rather than none");
});

test("the model: a project goes by its name alone when every project has the same owner", () => {
  assert.deepEqual([...repoLabels(["northwind/ledger", "northwind/atlas", ""])], [["northwind/ledger", "ledger"], ["northwind/atlas", "atlas"]]);
  assert.deepEqual([...repoLabels(["acme/app", "other/app"])], [["acme/app", "acme/app"], ["other/app", "other/app"]], "two owners: both are said");
});

test("the model: the ribbon is the last few lines of the log, stamped and labelled", () => {
  let state: DashboardState = { ...initialState(), multiProject: true };
  for (let i = 0; i < 9; i++) {
    state = dashboardReducer(state, makeEvent("log-message", { level: "info", message: `line ${i}`, repo: "o/a" }, new Date(NOW + i * 1000).toISOString()));
  }
  const { ribbon } = fieldModel(state, NOW);
  assert.equal(ribbon.length, RIBBON_MAX_LINES);
  assert.deepEqual(ribbon.map((line) => line.text), ["line 5", "line 6", "line 7", "line 8"], "oldest first");
  assert.equal(ribbon[0]?.repo, "o/a");
  assert.equal(fieldModel({ ...state, multiProject: false }, NOW).ribbon[0]?.repo, "", "one project: nothing to label a line with");
});

// ── room by what a state has earned ──────────────────────────────────────────

test("the hotter a piece of work, the higher it is set within its project, and a reactor has the most room", () => {
  const layout = lay(fieldState([burning(1, 7), idle(2)], { queued: 2, waiting: 2, cold: 2 }));
  const reactor = works(layout).find((node) => node.mode === "reactor")!;
  const [queued] = rowsAt(layout, "queued");
  const [waiting] = rowsAt(layout, "waiting");
  const [cold] = rowsAt(layout, "cold");

  assert.ok(reactor.rect.y < queued!.rect.y && queued!.rect.y < waiting!.rect.y && waiting!.rect.y < cold!.rect.y, "heat rises");
  assert.ok(reactor.rect.h > queued!.rect.h, "a reactor has the most room");
  assert.equal(layout.density, 0, "with room to spare, the roomiest sizes");
  assert.equal(queued!.lines, 2, "where work yoke does next has a second line of detail");
  assert.deepEqual([queued!.level, waiting!.level, cold!.level], ["queued", "waiting", "cold"], "each line keeps its own level, to be drawn at its weight");
});

test("a project's lines are all one size, that of the hottest level it holds (#290)", () => {
  const layout = lay(projectsState([idle(1)], [["o/a", { queued: 1, waiting: 2, cold: 2 }], ["o/b", { waiting: 2, cold: 1 }], ["o/c", { cold: 3 }]]));
  const sizes = (repo: string) => [...new Set(rowsOf(layout, repo).map((node) => `${node.rect.w}×${node.rect.h}/${node.lines}`))];
  const density = DENSITIES[layout.density]!;
  for (const repo of ["o/a", "o/b", "o/c"]) assert.equal(sizes(repo).length, 1, `${repo}: one size, so its bands rule it evenly`);
  assert.equal(rowsOf(layout, "o/a")[0]!.rect.h, density.rowH.queued, "a project with queued work is set at the queued size");
  assert.equal(rowsOf(layout, "o/b")[0]!.rect.h, density.rowH.waiting, "one that waits at most, at the waiting size");
  assert.equal(rowsOf(layout, "o/c")[0]!.rect.h, density.rowH.cold, "and one that nothing is coming for in small print");
});

test("each project is headed by its name, and its work lies between its heading and the next (#290)", () => {
  const layout = lay(projectsState([burning(1, 7), idle(2)], [["o/b", { queued: 3, waiting: 2 }], ["o/a", { queued: 1, cold: 4 }]]));
  assert.deepEqual(headerIds(layout), ["header:burning", "header:project:o/a", "header:project:o/b"], "no heading for a level");
  const heading = byId(layout, "header:project:o/a");
  assert.ok(heading.kind === "header" && heading.heads === "project" && heading.repo === "o/a");
  assert.deepEqual(heading.kind === "header" && [heading.count, heading.levels], [5, [{ level: "queued", count: 1 }, { level: "cold", count: 4 }]]);

  const a = byId(layout, "header:project:o/a").rect;
  const b = byId(layout, "header:project:o/b").rect;
  for (const row of rowsOf(layout, "o/a")) assert.ok(row.rect.y >= a.y + a.h && row.rect.y + row.rect.h <= b.y, `${row.id} is under o/a`);
  for (const row of rowsOf(layout, "o/b")) assert.ok(row.rect.y >= b.y + b.h, `${row.id} is under o/b`);
  assert.ok(rowsOf(layout, "o/a").every((row) => row.id === `work:${row.work.key}`), "every line is still known by its work");

  const single = lay(fieldState([idle(1)], { queued: 2, waiting: 1 }));
  assert.deepEqual(headerIds(single), ["header:burning", "header:project:o/a"], "one project is headed by its name just the same");
});

test("a project with nothing below the reactors takes no room at all: no header, no gap", () => {
  const withB = lay(projectsState([burning(1, 7)], [["o/a", { queued: 2 }], ["o/b", { waiting: 2 }]]));
  const without = lay(projectsState([burning(1, 7)], [["o/a", { queued: 2 }], ["o/b", {}]]));
  assert.ok(without.contentHeight < withB.contentHeight);
  assert.deepEqual(headerIds(without), ["header:burning", "header:project:o/a"]);

  // o/a's only work below the reactors is taken up by an engine: its group goes too.
  const allBurning = lay(stateWith([issue(7, { prPhase: "planning" })], "o/a", { cylinders: [burning(1, 7)] }));
  assert.deepEqual(headerIds(allBurning), ["header:burning"]);
});

test("work that changes level stays in its project: it moves within the group, and the groups below stay put", () => {
  const before = projectsState([idle(1)], [["o/a", { queued: 4, waiting: 1 }], ["o/b", { queued: 2 }]]);
  // #101 is blocked: it is waiting now, after the rest of o/a's queued work.
  const after = withPairs(before, "o/a", before.lifecycleByRepo.get("o/a")!.map((pair) =>
    pair.issue?.number === 101 ? { ...pair, blockedByIssueNumbers: [100] } : pair));
  const first = lay(before);
  const second = lay(after);

  const moved = byId(second, "work:o/a#101");
  assert.ok(moved.kind === "work" && moved.level === "waiting");
  assert.ok(moved.rect.y > byId(first, "work:o/a#101").rect.y, "it sinks below the queued work, in its own group");
  assert.deepEqual(rowsOf(second, "o/a").map((row) => row.work.number), [100, 102, 103, 101, 200]);
  assert.deepEqual(byId(second, "work:o/a#100").rect, byId(first, "work:o/a#100").rect, "what was above it does not move");
  assert.deepEqual(byId(second, "header:project:o/b").rect, byId(first, "header:project:o/b").rect, "nor does the next project");
  assert.deepEqual(byId(second, "work:o/b#100").rect, byId(first, "work:o/b#100").rect);
});

test("nothing on the field overlaps anything else, at any size or density", () => {
  const states = [
    fieldState([burning(1, 7), burning(2, 8), idle(3), burning(4, 9), idle(5), burning(6, 10)], { queued: 9, waiting: 8, cold: 3 }),
    projectsState([burning(1, 7), idle(2)], [["o/a", { queued: 5, waiting: 3 }], ["o/b", { waiting: 7, cold: 2 }], ["o/c", { cold: 9 }]]),
    fieldState([idle(1), idle(2), idle(3)], { queued: 1 }),
    fieldState([burning(1, 7), burning(2, 8), burning(3, 9), burning(4, 10), burning(5, 11), burning(6, 12)], { queued: 40, waiting: 30, cold: 30 }),
  ];
  const viewports: Viewport[] = [
    DESK,
    { width: 1920, height: 1080, railWidth: 400, lampWidth: 132 },
    { width: 1024, height: 768, railWidth: 300, lampWidth: 132 },
    { width: 390, height: 844, railWidth: 68, lampWidth: 52 },
    { width: 3840, height: 2160, railWidth: 68, lampWidth: 132 },
  ];
  for (const state of states) {
    for (const viewport of viewports) {
      const layout = lay(state, viewport);
      for (const [i, a] of layout.nodes.entries()) {
        assert.ok(a.rect.x >= -0.5 && a.rect.x + a.rect.w <= layout.scroll.w + 0.5, `${a.id} is inside the field at ${viewport.width} wide`);
        assert.ok(a.rect.w > 0 && a.rect.h > 0);
        for (const b of layout.nodes.slice(i + 1)) {
          assert.ok(!overlaps(a, b), `${a.id} and ${b.id} overlap at ${viewport.width}×${viewport.height}`);
        }
      }
      assert.equal(layout.scroll.x + layout.scroll.w, layout.field.x + layout.field.w);
      assert.ok(layout.field.x + layout.field.w <= viewport.width - viewport.railWidth, "the field keeps clear of the inbox");
    }
  }
});

// ── denser before it scrolls ─────────────────────────────────────────────────

test("when the window cannot hold everything, the field steps down to denser sizes before it scrolls", () => {
  const engines = [burning(1, 7), burning(2, 8), burning(3, 9)];
  const densities = [2, 12, 30, 60].map((queued) => lay(fieldState(engines, { queued, waiting: queued, cold: queued })));

  assert.deepEqual(densities.map((layout) => layout.density), [...densities.map((layout) => layout.density)].sort((a, b) => a - b), "never roomier for more work");
  assert.equal(densities[0]!.density, 0);
  assert.equal(densities[densities.length - 1]!.density, DENSITIES.length - 1);
  for (const layout of densities.slice(0, -1)) {
    if (layout.density < DENSITIES.length - 1) assert.equal(maxScroll(layout), 0, "a density that was chosen fits");
  }
  assert.ok(maxScroll(densities[densities.length - 1]!) > 0, "only then does it scroll");
});

test("the densities only ever shrink, and each keeps the hot above the cold", () => {
  for (const [i, density] of DENSITIES.entries()) {
    assert.ok(density.reactorH > density.rowH.queued, "a reactor is always more than a line");
    assert.ok(density.rowH.queued >= density.rowH.waiting && density.rowH.waiting >= density.rowH.cold);
    const roomier = DENSITIES[i - 1];
    if (!roomier) continue;
    assert.ok(density.reactorH <= roomier.reactorH && density.ringD <= roomier.ringD);
    for (const level of ["queued", "waiting", "cold"] as const) {
      assert.ok(density.rowH[level] <= roomier.rowH[level], `${level} rows never grow at a denser size`);
      assert.ok(density.colMinW[level] <= roomier.colMinW[level]);
    }
  }
});

test("the ribbon keeps one line whatever happens, and takes more only from room nothing else wants", () => {
  let roomy = fieldState([idle(1)], { queued: 1 });
  let crowded = fieldState([burning(1, 7)], { queued: 80, waiting: 80 });
  for (let i = 0; i < 6; i++) {
    const event = makeEvent("log-message", { level: "info", message: `line ${i}` });
    roomy = dashboardReducer(roomy, event);
    crowded = dashboardReducer(crowded, event);
  }
  assert.equal(lay(roomy).ribbon.lines, RIBBON_MAX_LINES);
  assert.equal(lay(crowded).ribbon.lines, 1);
  assert.equal(lay(fieldState([idle(1)])).ribbon.lines, 1, "with nothing logged yet there is nothing to give lines to");
  const layout = lay(crowded);
  assert.equal(layout.ribbon.rect.y + layout.ribbon.rect.h, DESK.height, "along the bottom edge");
  assert.equal(layout.scroll.y + layout.scroll.h, layout.ribbon.rect.y, "and the content stops where it starts");
});

// ── things stay where they are ───────────────────────────────────────────────

test("a reactor keeps its width, whatever the engines around it are doing", () => {
  const all = lay(fieldState([burning(1, 7), burning(2, 8), burning(3, 9), burning(4, 10), burning(5, 11), burning(6, 12)]));
  const some = lay(fieldState([burning(1, 7), idle(2), burning(3, 9), idle(4), idle(5), burning(6, 12)]));
  const one = lay(fieldState([idle(1), idle(2), burning(3, 9), idle(4), idle(5), idle(6)]));

  const width = (layout: FieldLayout, key: string) => byId(layout, `work:o/a#${key}`).rect.w;
  assert.equal(width(all, "9"), width(some, "9"));
  assert.equal(width(all, "9"), width(one, "9"), "the columns are set by the size of the pool");

  // Engines are set in order, and the first is always at the top left.
  assert.deepEqual([byId(all, "engine:0").rect.x, byId(some, "engine:0").rect.x], [0, 0]);
  assert.equal(byId(one, "engine:2").rect.x, 0);
  const xs = [0, 1, 2, 3, 4, 5].map((i) => byId(all, `engine:${i}`).rect.x);
  assert.ok(xs[1]! > xs[0]!, "left to right");
});

test("six engines that fit four across are set three and three, not four and two", () => {
  const wide: Viewport = { width: 2000, height: 1200, railWidth: 68, lampWidth: 132 };
  const layout = lay(fieldState([burning(1, 7), burning(2, 8), burning(3, 9), burning(4, 10), burning(5, 11), burning(6, 12)]), wide);
  const ys = [0, 1, 2, 3, 4, 5].map((i) => byId(layout, `engine:${i}`).rect.y);
  assert.equal(new Set(ys.slice(0, 3)).size, 1, "three on the first row");
  assert.equal(new Set(ys.slice(3)).size, 1, "three on the second");
  assert.ok(ys[3]! > ys[0]!);
});

test("the bench is balanced too: six idle engines are three and three, not five and one", () => {
  const layout = lay(fieldState([idle(1), idle(2), idle(3), idle(4), idle(5), idle(6)]));
  const ys = [0, 1, 2, 3, 4, 5].map((i) => byId(layout, `engine:${i}`).rect.y);
  assert.deepEqual([new Set(ys.slice(0, 3)).size, new Set(ys.slice(3)).size], [1, 1]);
  assert.ok(layout.nodes.filter((node) => node.kind === "engine").every((node) => node.kind === "engine" && node.mode === "bench"));
});

test("work fills a stratum down each column in turn, so one leaving moves only what was under it", () => {
  const wide: Viewport = { width: 2200, height: 1200, railWidth: 68, lampWidth: 132 };
  const before = lay(fieldState([idle(1)], { queued: 8 }), wide);
  const rows = rowsAt(before, "queued");
  const columns = new Set(rows.map((row) => row.rect.x)).size;
  assert.ok(columns >= 2, "the test needs columns to mean anything");
  const perColumn = Math.ceil(rows.length / columns);
  assert.equal(rows[1]!.rect.x, rows[0]!.rect.x, "the second is under the first");
  assert.ok(rows[1]!.rect.y > rows[0]!.rect.y);
  assert.ok(rows[perColumn]!.rect.x > rows[0]!.rect.x, "and the next column starts when the first is full");

  // Take the second piece of work away: the first does not move at all.
  const pairs = fieldModel(fieldState([idle(1)], { queued: 8 }), NOW).works.filter((work) => work.number !== 101).map((work) => work.pair);
  const after = lay(stateWith(pairs, "o/a", { cylinders: [idle(1)] }), wide);
  assert.deepEqual(byId(after, "work:o/a#100").rect, byId(before, "work:o/a#100").rect);
  assert.equal(byId(after, "work:o/a#102").rect.x, byId(before, "work:o/a#102").rect.x, "what was under it closes up in its own column");
});

test("a stratum is never set in more columns than it has work for, nor a line drawn too wide to read across", () => {
  const wide: Viewport = { width: 3840, height: 2160, railWidth: 68, lampWidth: 132 };
  const one = rowsAt(lay(fieldState([idle(1)], { cold: 1 }), wide), "cold");
  assert.equal(one.length, 1);
  assert.ok(one[0]!.rect.w <= 760, "one piece of work is one column, of a width its status can be read across");

  const three = rowsAt(lay(fieldState([idle(1)], { cold: 3 }), wide), "cold");
  assert.equal(new Set(three.map((row) => row.rect.x)).size, 3, "three pieces of work: three columns, not three quarters of four");
});

// ── the instruments, the hold, and nothing at all ────────────────────────────

test("the instruments give way in order as the window narrows: the cycle first, the usage gauge last", () => {
  const state = fieldState([{ ...idle(1), iterationNumber: 4 }]);
  const kinds = (width: number) => lay(state, { width, height: 800, railWidth: 68, lampWidth: 132 }).hud.slots.map((slot) => slot.kind);

  assert.deepEqual(kinds(1512), ["cycle", "countdown", "usage"]);
  assert.deepEqual(kinds(924), ["countdown", "usage"]);
  assert.deepEqual(kinds(760), ["usage"]);
  assert.deepEqual(kinds(360), [], "and on a phone the title has the top to itself");

  const lost = lay({ ...state, connection: "disconnected" }, { width: 640, height: 800, railWidth: 68, lampWidth: 52 });
  assert.equal(lost.hud.slots[0]?.kind, "state", "a lost connection is said before anything else is");
});

test("a hold is set above everything, the full width of the field", () => {
  const state = { ...fieldState([idle(1)], { queued: 2 }), hold: { kind: "claude-usage-limit", reason: "Claude usage limit", untilMs: NOW + 3_600_000 } };
  const layout = lay(state);
  const hold = byId(layout, "hold");
  assert.equal(layout.nodes[0], hold);
  assert.equal(hold.rect.w, layout.scroll.w);
  assert.equal(hold.rect.h, HOLD_HEIGHT);
  assert.ok(layout.nodes.slice(1).every((node) => node.rect.y >= hold.rect.y + hold.rect.h));
});

test("with no work to draw, the field says so in words where the work would be", () => {
  const connecting = lay({ ...initialState(), cylinders: [] });
  assert.deepEqual(connecting.nodes.map((node) => node.kind === "note" && node.text), ["Connecting to yoke…"]);

  const empty = lay(stateWith([], "o/a", { cylinders: [idle(1)] }));
  assert.equal(empty.nodes.find((node) => node.kind === "note")?.kind === "note" && (empty.nodes.find((node) => node.kind === "note") as { text: string }).text, "No open issues or pull requests.");
});

// ── what is under a finger ───────────────────────────────────────────────────

test("hitTest: a point on the field is a piece of work, an engine, an instrument, the log — or nothing", () => {
  const state = {
    ...fieldState([burning(1, 7), idle(2)], { queued: 2 }),
    hold: { kind: "claude-usage-limit", reason: "Claude usage limit", untilMs: NOW + 3_600_000 },
  };
  const layout = lay(state);
  const at = (node: FieldNode, dx = 4, dy = 4) => hitTest(layout, layout.scroll.x + node.rect.x + dx, layout.scroll.y + node.rect.y + dy, 0);

  const reactor = works(layout).find((node) => node.mode === "reactor")!;
  assert.deepEqual(at(reactor)?.kind === "work" && (at(reactor) as { key: string }).key, "o/a#7");
  const row = rowsAt(layout, "queued")[0]!;
  assert.equal((at(row) as { key: string }).key, row.work.key);
  assert.deepEqual(at(byId(layout, "engine:0")), { kind: "engine", index: 0, node: byId(layout, "engine:0") });
  assert.equal(at(byId(layout, "engine:1"))?.kind, "engine", "an engine on the bench can be picked out too");
  assert.equal(at(byId(layout, "hold"))?.kind, "hold");
  assert.equal(at(byId(layout, "header:project:o/a")), null, "a heading is not something to pick out");

  const usage = layout.hud.slots.find((slot) => slot.kind === "usage")!;
  assert.deepEqual(hitTest(layout, usage.rect.x + 10, 30, 0), { kind: "usage" });
  assert.deepEqual(hitTest(layout, layout.hud.title.x + 10, 30, 0), { kind: "title" });
  assert.deepEqual(hitTest(layout, layout.ribbon.rect.x + 10, layout.ribbon.rect.y + 10, 0), { kind: "ribbon" });
  assert.equal(hitTest(layout, DESK.width - 20, 400, 0), null, "under the inbox the field has nothing to pick");
  assert.equal(hitTest(layout, usage.rect.x + usage.rect.w + 20, HUD_HEIGHT - 4, 0), null, "nor where the keep-awake lamp sits");
});

test("hitTest follows the scroll: what is under a point is what was scrolled there", () => {
  const layout = lay(fieldState([burning(1, 7)], { queued: 80, waiting: 80 }));
  assert.ok(maxScroll(layout) > 200);
  const row = rowsAt(layout, "waiting").find((node) => node.rect.y > layout.scroll.h + 100)!;
  assert.ok(row, "a line below the bottom of the window");
  const x = layout.scroll.x + row.rect.x + 60;

  assert.equal(hitTest(layout, x, layout.scroll.y + row.rect.y, 0), null, "out of the window: nothing is there");
  const scrolled = row.rect.y - 100;
  const hit = hitTest(layout, x, layout.scroll.y + 100 + 4, scrolled);
  assert.equal(hit?.kind === "work" && hit.key, row.work.key);
});
