import test from "node:test";
import assert from "node:assert/strict";

import { ActivityDrawer } from "../src/dashboard/components/activity-drawer.js";
import { YokeInbox } from "../src/dashboard/components/yoke-inbox.js";
import { fieldModel, INSPECTOR_CARD_ID } from "../src/dashboard/field/model.js";
import {
  buildInbox,
  cardsToShield,
  failureCardId,
  INBOX_SOURCES,
  InboxLedger,
  inboxWithLedger,
  inspect,
  type InboxInput,
} from "../src/dashboard/shared/inbox.js";
import { lampReserve, RAIL_OVERLAY_BELOW, RAIL_STRIP, railLayout } from "../src/dashboard/shared/rail.js";
import { workViews } from "../src/dashboard/shared/work-view.js";
import { dashboardReducer, failureKey, FAILURE_SHOW_MS, initialState } from "../src/dashboard/store/dashboard-store.js";
import type { DashboardState, LifecyclePair } from "../src/dashboard/store/types.js";
import { click, findTemplate, flatten, makeEvent, renderInbox, stateWith, withPairs } from "./dashboard-helpers.js";

// The inbox is federated: each kind of thing a person can do comes from its
// own source, and they are listed together, top to bottom, down the right-hand
// edge of the screen. These pin what each source lists, the order they are
// listed in, and that the list never moves a button under a finger.

const NOW = Date.parse("2026-11-10T12:00:00Z");
const MINUTE = 60_000;

function ready(issue: number, pr: number, overrides: Partial<LifecyclePair> = {}, prOverrides: Record<string, unknown> = {}): LifecyclePair {
  return {
    issue: { number: issue, title: `Issue ${issue}`, state: "open" },
    pr: { number: pr, title: `PR ${pr}`, state: "open", draft: false, checksStatus: "success", ...prOverrides },
    prPhase: "review",
    ...overrides,
  };
}

const parked = (issue: number, pr: number, prOverrides: Record<string, unknown> = {}) =>
  ready(issue, pr, { approval: "awaiting-approval" }, prOverrides);

function inputFor(state: DashboardState, overrides: Partial<InboxInput> = {}): InboxInput {
  return {
    works: workViews(state, NOW),
    failures: [...state.failures.values()],
    keepAwake: "awake",
    dismissed: new Set(),
    arrivals: new Map(),
    nowMs: NOW,
    failureShowMs: FAILURE_SHOW_MS,
    ...overrides,
  };
}

/** `state` after an engine starts `type` on the work and fails at it, `agoMs` before NOW. */
function withFailure(
  state: DashboardState,
  action: { type: string; issueNumber?: number; pullRequestNumber?: number; error?: string },
  agoMs = 0,
  engine = 1,
): DashboardState {
  const at = new Date(NOW - agoMs).toISOString();
  let next = dashboardReducer(state, makeEvent("action-start", {
    actionIndex: engine, totalActions: 3, repo: "o/a", description: "d", type: action.type,
    issueNumber: action.issueNumber ?? null, pullRequestNumber: action.pullRequestNumber ?? null,
    pullRequestTitle: action.pullRequestNumber !== undefined ? `PR ${action.pullRequestNumber}` : null,
  }, at));
  next = dashboardReducer(next, makeEvent("action-error", {
    actionIndex: engine, totalActions: 3, repo: "o/a", error: action.error ?? "Claude exited with status 1\n    at run (agent.ts:1)",
  }, at));
  // The engine reports itself idle in the same tick, as it does in a real run.
  return dashboardReducer(next, makeEvent("engine-idle", { engineIndex: engine - 1, nextCycleAtMs: NOW + MINUTE }, at));
}

// ── the sources ──────────────────────────────────────────────────────────────

test("the inbox lists its sources in one order, the most pressing first", () => {
  assert.deepEqual([...INBOX_SOURCES], ["keep-awake", "approval", "review", "failure", "manual"]);
});

test("approval: a PR parked by the review label has a card, and so has every approval under way", () => {
  const state = stateWith([
    parked(1, 10),
    ready(2, 20, { approval: "approved" }),
    ready(3, 30),
    { issue: { number: 4, title: "Issue 4", state: "open" }, pr: null, prPhase: "absent" },
  ]);
  const cards = buildInbox(inputFor(state));

  assert.deepEqual(cards.map((card) => card.id), ["approval:o/a#10", "approval:o/a#20"]);
  assert.deepEqual(cards.map((card) => card.eyebrow), ["Approve to merge", "Approval queued"]);
  assert.deepEqual(cards[0]?.action, {
    type: "approve",
    target: { repo: "o/a", pullRequestNumber: 10 },
    step: "idle",
    label: "Approve",
    disabled: false,
    hint: "Approve PR #10: yoke squash-merges it",
  });
  assert.deepEqual(cards[0]?.links, [
    { label: "PR #10", href: "https://github.com/o/a/pull/10" },
    { label: "Issue #1", href: "https://github.com/o/a/issues/1" },
  ]);
  assert.deepEqual(cards[0]?.facts, ["checks passing"]);
  assert.equal(cards[0]?.title, "PR 10", "a card is about the PR, so it goes by the PR's title");
  assert.equal(cards[0]?.dismissible, false, "something still waiting on a person cannot be put away");
});

test("review: a PR yoke has asked a person to review on GitHub has a card that opens it there", () => {
  const state = stateWith([
    ready(1, 10, { awaitingReview: true }),
    ready(2, 20),
    ready(3, 30, { awaitingReview: true, disabled: true }),
  ]);
  const cards = buildInbox(inputFor(state)).filter((card) => card.source === "review");

  assert.deepEqual(cards.map((card) => card.id), ["review:o/a#1"], "only the one that waits on a person, and is not manual");
  assert.equal(cards[0]?.eyebrow, "Ready for your review");
  assert.equal(cards[0]?.action?.type, "open");
  assert.deepEqual(cards[0]?.action?.type === "open" && { href: cards[0].action.href, label: cards[0].action.label }, {
    href: "https://github.com/o/a/pull/10",
    label: "Review PR #10",
  });
  assert.deepEqual(cards[0]?.links, [{ label: "Issue #1", href: "https://github.com/o/a/issues/1" }], "the button is the link to the PR");
});

test("manual: a PR labelled manual is listed as a person's to deal with, until it merges", () => {
  const state = stateWith([
    ready(1, 10, { disabled: true }),
    ready(2, 20, { disabled: true, prPhase: "completed" }),
  ]);
  const cards = buildInbox(inputFor(state));

  assert.deepEqual(cards.map((card) => card.id), ["manual:o/a#1"]);
  assert.equal(cards[0]?.eyebrow, "Manual — yours");
  assert.equal(cards[0]?.action?.type === "open" && cards[0].action.label, "Open PR #10");
});

test("keep-awake: only a loop the browser refused to start is something to tap", () => {
  const state = stateWith([]);
  assert.deepEqual(buildInbox(inputFor(state, { keepAwake: "awake" })), []);
  assert.deepEqual(buildInbox(inputFor(state, { keepAwake: "idle" })), []);

  const [card] = buildInbox(inputFor(state, { keepAwake: "blocked" }));
  assert.equal(card?.id, "keep-awake");
  assert.equal(card?.accent, "warning");
  assert.equal(card?.action?.type, "keep-awake");
  assert.equal(card?.workKey, null, "it is about no piece of work");
});

// ── failures ─────────────────────────────────────────────────────────────────

test("failure: the store keeps a failed action, which the engine itself forgets at once", () => {
  const state = withFailure(stateWith([ready(1, 10)]), { type: "self-review", pullRequestNumber: 10 }, 65_000, 2);

  assert.equal(state.cylinders[1]?.status, "idle", "the engine has moved on");
  const failure = state.failures.get(failureKey("o/a", null, 10)!);
  assert.deepEqual(failure && { ...failure }, {
    key: "o/a#pr-10",
    repo: "o/a",
    actionType: "self-review",
    issueNumber: null,
    prNumber: 10,
    issueTitle: null,
    prTitle: "PR 10",
    error: "Claude exited with status 1",
    atMs: NOW - 65_000,
    engineIndex: 1,
  });
});

test("failure: it is listed until an engine takes the work up again", () => {
  let state = withFailure(stateWith([ready(1, 10)]), { type: "self-review", pullRequestNumber: 10 }, 65_000, 2);
  const [card] = buildInbox(inputFor(state));

  assert.equal(card?.source, "failure");
  assert.equal(card?.eyebrow, "Failed reviewing");
  assert.equal(card?.title, "PR 10");
  assert.deepEqual(card?.facts, ["engine 2", "1m 5s ago"]);
  assert.deepEqual(card?.line, { text: "Claude exited with status 1 — yoke retries it", tone: "problem" });
  assert.equal(card?.action, null, "yoke retries it by itself: there is nothing a person must do");
  assert.equal(card?.dismissible, true);
  assert.equal(card?.workKey, "o/a#1", "tethered to the work it failed on");
  assert.deepEqual(card?.links.map((link) => link.label), ["PR #10", "Issue #1"]);

  // Another action starting on the same PR — any action — is the work taken up again.
  state = dashboardReducer(state, makeEvent("action-start", {
    actionIndex: 1, totalActions: 3, repo: "o/a", type: "address-failing-checks", pullRequestNumber: 10, description: "d",
  }));
  assert.equal(state.failures.size, 0);
  assert.deepEqual(buildInbox(inputFor(state)).filter((c) => c.source === "failure"), []);
});

test("failure: a failed implementation is history once an engine is on the PR that came of it", () => {
  // The implementation failed after it had opened its PR: what yoke does next
  // is an action on that PR, which names the issue it closes.
  const pair: LifecyclePair = { issue: { number: 7, title: "Issue 7", state: "open" }, pr: null, prPhase: "planning" };
  let state = withFailure(stateWith([pair]), { type: "start-implementation", issueNumber: 7 });
  assert.deepEqual([...state.failures.keys()], ["o/a#issue-7"]);

  state = dashboardReducer(state, makeEvent("action-start", {
    actionIndex: 1, totalActions: 3, repo: "o/a", type: "self-review", issueNumber: 7, pullRequestNumber: 12, description: "d",
  }));
  assert.equal(state.failures.size, 0, "the same work, taken up again by another name");
});

test("failure: an action on other work, or in another project, leaves it listed", () => {
  let state = withFailure(stateWith([ready(1, 10), ready(2, 20)]), { type: "self-review", pullRequestNumber: 10 });
  state = dashboardReducer(state, makeEvent("action-start", {
    actionIndex: 1, totalActions: 3, repo: "o/a", type: "self-review", pullRequestNumber: 20, description: "d",
  }));
  state = dashboardReducer(state, makeEvent("action-start", {
    actionIndex: 2, totalActions: 3, repo: "o/b", type: "self-review", pullRequestNumber: 10, description: "d",
  }));
  assert.deepEqual([...state.failures.keys()], ["o/a#pr-10"]);
});

test("failure: a failed implementation is known by its issue, which is all it has", () => {
  const pair: LifecyclePair = { issue: { number: 7, title: "Issue 7", state: "open" }, pr: null, prPhase: "planning" };
  const state = withFailure(stateWith([pair]), { type: "start-implementation", issueNumber: 7 });
  const [card] = buildInbox(inputFor(state));

  assert.equal(failureKey("o/a", 7, null), "o/a#issue-7");
  assert.equal(failureKey("o/a", null, null), null, "an action on nothing has nothing to point at");
  assert.equal(card?.eyebrow, "Failed implementing");
  assert.equal(card?.title, "Issue 7");
  assert.deepEqual(card?.links, [{ label: "Issue #7", href: "https://github.com/o/a/issues/7" }]);
});

test("failure: it leaves once its work leaves the lifecycle, or it is old, or it is put away", () => {
  const failed = withFailure(stateWith([ready(1, 10)]), { type: "self-review", pullRequestNumber: 10 }, 5 * MINUTE);
  const id = failureCardId(failed.failures.get("o/a#pr-10")!);

  // Merged or closed: the lifecycle no longer lists it, and nothing will retry it.
  assert.equal(withPairs(failed, "o/a", []).failures.size, 0);
  assert.equal(withPairs(failed, "o/b", []).failures.size, 1, "another project's update says nothing about it");

  // Too old to matter.
  assert.equal(buildInbox(inputFor(failed, { nowMs: NOW + FAILURE_SHOW_MS })).length, 0);
  assert.ok(FAILURE_SHOW_MS >= 60 * MINUTE, "listed for at least as long as yoke backs a failing action off");

  // Dismissed — and a later failure of the same work is a new card.
  assert.equal(buildInbox(inputFor(failed, { dismissed: new Set([id]) })).length, 0);
  const again = withFailure(failed, { type: "self-review", pullRequestNumber: 10 });
  const [card] = buildInbox(inputFor(again, { dismissed: new Set([id]) }));
  assert.ok(card && card.id !== id, "the next failure is not hidden by the last one's dismissal");
});

test("failure: a usage limit is a hold, not a failure, and lists nothing", () => {
  // The engine reports itself parked rather than erroring (see src/index.ts).
  let state = stateWith([ready(1, 10)]);
  state = dashboardReducer(state, makeEvent("action-start", { actionIndex: 1, totalActions: 3, repo: "o/a", type: "self-review", pullRequestNumber: 10, description: "d" }));
  state = dashboardReducer(state, makeEvent("engine-idle", { engineIndex: 0, reason: "claude-usage-limit", rateLimitedUntilMs: NOW + MINUTE }));
  assert.equal(state.failures.size, 0);
});

// ── the order of the list ────────────────────────────────────────────────────

test("order: by source, most pressing first", () => {
  let state = stateWith([
    ready(5, 50, { disabled: true }),
    ready(4, 40, { awaitingReview: true }),
    ready(3, 30),
    parked(2, 20),
  ]);
  state = withFailure(state, { type: "self-review", pullRequestNumber: 30 });
  const cards = buildInbox(inputFor(state, { keepAwake: "blocked" }));

  assert.deepEqual(cards.map((card) => card.source), ["keep-awake", "approval", "review", "failure", "manual"]);
});

test("order: within a source the longest-waiting is on top, and a new arrival lands below the others", () => {
  const ledger = new InboxLedger();
  const build = (state: DashboardState, nowMs: number) =>
    inboxWithLedger({ ...inputFor(state), nowMs }, ledger).map((card) => card.id);

  assert.deepEqual(build(stateWith([parked(5, 50)]), NOW), ["approval:o/a#50"]);
  // PR #10 sorts before #50 by name, but arrived after it.
  assert.deepEqual(
    build(stateWith([parked(1, 10), parked(5, 50)]), NOW + MINUTE),
    ["approval:o/a#50", "approval:o/a#10"],
    "nothing is pushed out from under a finger",
  );
  assert.deepEqual(build(stateWith([parked(1, 10), parked(5, 50), parked(3, 30)]), NOW + 2 * MINUTE),
    ["approval:o/a#50", "approval:o/a#10", "approval:o/a#30"]);
});

test("order: a card does not move because of how it changes", () => {
  const ledger = new InboxLedger();
  const pairs = (approved: boolean) => [parked(5, 50), approved ? ready(1, 10, { approval: "approved" }) : parked(1, 10), parked(3, 30)];
  const before = inboxWithLedger(inputFor(stateWith(pairs(false))), ledger).map((card) => card.id);
  const after = inboxWithLedger({ ...inputFor(stateWith(pairs(true))), nowMs: NOW + MINUTE }, ledger);

  assert.deepEqual(after.map((card) => card.id), before, "Queued where it was pressed");
  assert.equal(after.find((card) => card.id === "approval:o/a#10")?.eyebrow, "Approval queued");
});

test("the ledger forgets a card that has gone, so one that comes back is a new arrival", () => {
  const ledger = new InboxLedger();
  ledger.observe(["a", "b"], 1);
  ledger.observe(["b"], 2);
  assert.deepEqual([...ledger.arrivals], [["b", 1]]);
  ledger.observe(["a", "b"], 3);
  assert.deepEqual([...ledger.arrivals].sort(), [["a", 3], ["b", 1]]);
});

test("cards that arrive at the same moment are listed in one fixed order", () => {
  const state = stateWith([parked(3, 30), parked(1, 10), parked(2, 20)]);
  const ids = buildInbox(inputFor(state)).map((card) => card.id);
  assert.deepEqual(ids, ["approval:o/a#10", "approval:o/a#20", "approval:o/a#30"]);
});

// ── never under a finger ─────────────────────────────────────────────────────

test("tap shield: a card that has just arrived or moved does not take a press; one that stayed put does", () => {
  const before = new Map([["a", 0], ["b", 240], ["c", 480]]);

  assert.deepEqual(cardsToShield(before, before), [], "nothing moved");
  assert.deepEqual(cardsToShield(before, new Map([["a", 0], ["b", 240.4], ["c", 480]])), [], "a sub-pixel shift is not a move");
  // The top card leaves: the two below slide up under where it was.
  assert.deepEqual(cardsToShield(before, new Map([["b", 0], ["c", 240]])), ["b", "c"]);
  // A new card lands at the bottom: nothing above it moved.
  assert.deepEqual(cardsToShield(before, new Map([...before, ["d", 720]])), ["d"]);
  // A card grows — an approval gains its status line — and pushes the next one down.
  assert.deepEqual(cardsToShield(before, new Map([["a", 0], ["b", 262], ["c", 502]])), ["b", "c"]);
});

test("a press on a button that cannot be pressed asks yoke for nothing, whatever delivered the click", () => {
  const state = stateWith([parked(1, 10, { checksStatus: "failure" })]);
  const rendered = renderInbox(state);
  const heard: unknown[] = [];
  rendered.inbox.addEventListener("inbox-approve", (event) => heard.push((event as CustomEvent).detail));

  click(rendered.approveButton(10));
  assert.deepEqual(heard, []);
});

// ── what the inbox draws ─────────────────────────────────────────────────────

test("the inbox element: open, it lists its cards under a count of them", () => {
  const { html } = renderInbox(stateWith([parked(1, 10), parked(2, 20)]));

  assert.match(html, /class="inbox is-open"\s+aria-label="Inbox: 2 waiting on you"/);
  assert.match(html, /aria-label="2 waiting on you"\s+aria-expanded="true"/);
  assert.match(html, />2<\/button>/, "the count");
  assert.equal(html.match(/data-card="approval:/g)?.length, 2);
});

test("the inbox element: with nothing in it, it says what will turn up there", () => {
  const inbox = new YokeInbox();
  Object.assign(inbox, { cards: [], open: false });
  const html = flatten(inbox.render());

  assert.match(html, /class="inbox is-closed"\s+aria-label="Inbox: Nothing is waiting on you"/);
  assert.match(html, /class="inbox-badge"/, "no cards: the count is not lit");
  assert.match(html, /<p class="inbox-empty">/);
});

test("the inbox element: a project is named on its cards only when several share the dashboard", () => {
  const state = stateWith([parked(1, 10)]);
  assert.ok(!renderInbox(state).html.includes('class="inbox-repo"'));
  assert.match(renderInbox({ ...state, multiProject: true }).html, /<span class="inbox-repo">o\/a<\/span>/);
});

test("the inbox element: a link out is a link, opened in a new tab, and a notice can be put away", () => {
  let state = stateWith([ready(1, 10, { awaitingReview: true }), ready(3, 30)]);
  state = withFailure(state, { type: "self-review", pullRequestNumber: 30 });
  const rendered = renderInbox(state, { keepAwake: "blocked", nowMs: NOW });

  assert.match(rendered.html, /<a\s+class="inbox-action open"\s+href="https:\/\/github\.com\/o\/a\/pull\/10"\s+target="_blank"\s+rel="noopener noreferrer"/);
  assert.match(rendered.html, /<button\s+class="inbox-action wake"\s+type="button"/);
  assert.match(rendered.html, /class="inbox-card source-failure accent-alarm"/);

  const dismissed: string[] = [];
  rendered.inbox.addEventListener("inbox-dismiss", (event) => dismissed.push((event as CustomEvent<string>).detail));
  const failure = rendered.cards.find((card) => card.source === "failure")!;
  click(findTemplate(rendered.card(failure.id), 'class="inbox-dismiss"'), 'class="inbox-dismiss"');
  assert.deepEqual(dismissed, [failure.id]);
  assert.equal(findTemplate(rendered.card("review:o/a#1"), 'class="inbox-dismiss"'), undefined, "a card still waiting on a person has no way to be put away");
});

test("the inbox element: tapping a card picks its work out on the field, and the Log button asks for the log", () => {
  const rendered = renderInbox(stateWith([parked(1, 10)]));
  const heard: string[] = [];
  rendered.inbox.addEventListener("inbox-select", (event) => heard.push(`select ${(event as CustomEvent<string>).detail}`));
  rendered.inbox.addEventListener("inbox-log", () => heard.push("log"));

  click(rendered.card("approval:o/a#10"));
  click(findTemplate(rendered.inbox.render(), 'class="inbox-log'), 'class="inbox-log');
  assert.deepEqual(heard, ["select o/a#1", "log"]);
});

test("the inbox element: the card about the work picked out on the field is marked, and the inspector says the rest", () => {
  const state = stateWith([parked(1, 10), { issue: { number: 4, title: "Issue 4", state: "open" }, pr: null, prPhase: "absent", blockedByIssueNumbers: [1] }]);
  const works = workViews(state, NOW);
  const inbox = new YokeInbox();
  Object.assign(inbox, {
    cards: buildInbox(inputFor(state)),
    open: true,
    selectedCardId: "approval:o/a#10",
    inspection: inspect({ kind: "work", key: "o/a#4" }, { works, engines: [], usageTitle: "", hold: null }),
  });
  const html = flatten(inbox.render());

  assert.match(html, /class="inbox-card source-approval accent-work step-idle is-selected"/);
  assert.match(html, new RegExp(`class="inbox-card inbox-inspector accent-work"\\s+data-card="${INSPECTOR_CARD_ID}"`));
  assert.match(html, /<span class="inbox-eyebrow">Waiting · issue<\/span>/);
  assert.match(html, /<p class="inbox-body">blocked by #1<\/p>/);
});

// ── the inspector ────────────────────────────────────────────────────────────

test("inspect: a piece of work is said in full — where it stands, its PR's own title, its links", () => {
  const pair = ready(1, 10, { prPhase: "active" }, { draft: true, title: "A different title", checksStatus: "pending" });
  const works = workViews(stateWith([pair]), NOW);
  const said = inspect({ kind: "work", key: "o/a#1" }, { works, engines: [], usageTitle: "", hold: null });

  assert.equal(said?.eyebrow, "Queued · draft");
  assert.equal(said?.title, "Issue 1");
  assert.deepEqual(said?.facts, ["draft", "checks running"]);
  assert.deepEqual(said?.body, ["checks running", "PR: A different title"]);
  assert.deepEqual(said?.links.map((link) => link.label), ["PR #10", "Issue #1"]);
  assert.equal(said?.workKey, "o/a#1");
});

test("inspect: an engine, an instrument and a hold each say their piece; something gone says nothing", () => {
  const engines = [{ index: 2, line: "reviewing PR #10 · 1m 4s", model: "Claude Opus 5.5", iteration: 12, repo: "o/a", color: { hex: "#000000", rgb: "0,0,0" }, hasWork: true }];
  const context = { works: [], engines, usageTitle: "Claude usage: 41% of the 5-hour window used", hold: null };

  const engine = inspect({ kind: "engine", index: 2 }, context);
  assert.equal(engine?.eyebrow, "Engine 3");
  assert.equal(engine?.title, "reviewing PR #10 · 1m 4s");
  assert.deepEqual(engine?.facts, ["Claude Opus 5.5", "cycle 12"]);

  assert.deepEqual(inspect({ kind: "usage" }, context)?.body, ["Claude usage: 41% of the 5-hour window used"]);

  const hold = { remaining: "2h 14m", deadline: "Sep 21, 8:50 AM", reason: "Claude usage limit" };
  assert.equal(inspect({ kind: "hold" }, { ...context, hold })?.title, "2h 14m until Sep 21, 8:50 AM");
  assert.equal(inspect({ kind: "hold" }, context), null, "the hold is over");
  assert.equal(inspect({ kind: "work", key: "o/a#99" }, context), null, "merged and gone");
  assert.equal(inspect({ kind: "engine", index: 9 }, context), null);
  assert.equal(inspect(null, context), null);
});

// ── the lines from the field to the inbox ────────────────────────────────────

test("tethers: each card about a piece of work is joined to it, saying where its approval has got to", () => {
  const state = stateWith([
    parked(1, 10),
    ready(2, 20, { approval: "approved" }),
    ready(3, 30, { disabled: true }),
  ]);
  const cards = buildInbox(inputFor(state, { keepAwake: "blocked" }));
  const model = fieldModel(state, NOW, { cards, selection: { kind: "work", key: "o/a#3" } });

  assert.deepEqual(model.tethers, [
    { cardId: "approval:o/a#10", workKey: "o/a#1", state: "waiting" },
    { cardId: "approval:o/a#20", workKey: "o/a#2", state: "sent" },
    { cardId: "manual:o/a#3", workKey: "o/a#3", state: "waiting" },
  ], "the keep-awake card is about no work, and work with a card needs no second line to the inspector");

  const picked = fieldModel(state, NOW, { cards: [], selection: { kind: "work", key: "o/a#1" } });
  assert.deepEqual(picked.tethers, [{ cardId: INSPECTOR_CARD_ID, workKey: "o/a#1", state: "selected" }]);
});

// ── the rail ─────────────────────────────────────────────────────────────────

test("the rail takes room from the field only while it has something in it", () => {
  assert.deepEqual(railLayout(1512, false, false), { reserved: RAIL_STRIP, panel: RAIL_STRIP, open: false, overlay: false });

  const open = railLayout(1512, true, false);
  assert.equal(open.open, true);
  assert.equal(open.reserved, open.panel, "beside the field, not over it");
  assert.equal(open.reserved, 378, "a quarter of the window");
  assert.equal(railLayout(4000, true, false).reserved, 400, "but never wider than a card reads well at");
  assert.equal(railLayout(900, true, false).reserved, 300, "nor narrower than a button needs");
});

test("on a narrow screen the open inbox lies over the field, which keeps its width", () => {
  const closed = railLayout(RAIL_OVERLAY_BELOW - 1, true, false);
  assert.deepEqual(closed, { reserved: RAIL_STRIP, panel: RAIL_STRIP, open: false, overlay: true }, "cards waiting do not open it by themselves");

  const open = railLayout(390, true, true);
  assert.equal(open.reserved, RAIL_STRIP, "the field does not move");
  assert.equal(open.open, true);
  assert.ok(open.panel > RAIL_STRIP && open.panel <= 390 - 44, "and the field still shows at its edge");

  assert.ok(lampReserve(390) < lampReserve(1512), "the lamp gives up its words before the instruments give up theirs");
});

// ── the activity drawer ──────────────────────────────────────────────────────

test("the activity drawer renders nothing of the log until it is opened", () => {
  const drawer = new ActivityDrawer();
  Object.assign(drawer, {
    events: [{ text: "hello", cylinderIdx: -1, level: "info", atMs: NOW, color: null }],
    eventCount: 1,
    sessionCount: 2,
  });
  const closed = flatten(drawer.render());
  assert.match(closed, /class="drawer"\s+aria-label="Activity"\s+aria-hidden="true"/);
  assert.ok(!closed.includes("<event-stream"), "a log nobody is reading is not laid out");
  assert.match(closed, /1 event · 2 sessions/);

  drawer.open = true;
  const open = flatten(drawer.render());
  assert.match(open, /class="drawer is-open"\s+aria-label="Activity"\s+aria-hidden="false"/);
  assert.ok(open.includes("<event-stream"));
  assert.match(open, /<p class="drawer-empty">Nothing yet\.<\/p>/);

  let closes = 0;
  drawer.addEventListener("drawer-close", () => closes++);
  click(findTemplate(drawer.render(), 'class="drawer-close"'), 'class="drawer-close"');
  assert.equal(closes, 1);
});
