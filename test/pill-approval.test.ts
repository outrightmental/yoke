import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  APPROVAL_OUTCOME_SHOW_MS,
  APPROVE_ACK_MS,
  APPROVE_BUTTON_LABELS,
  approvalPressFor,
  approvalStatusFor,
  approvalView,
  approveControl,
  approveRequestMessage,
  type ApprovalView,
} from "../src/dashboard/shared/pill-approval.js";
import { pillActivity, type PillActivity } from "../src/dashboard/shared/pill-activity.js";
import { YokeInbox } from "../src/dashboard/components/yoke-inbox.js";
import { DashboardStore, recordApprovalPress, initialState } from "../src/dashboard/store/dashboard-store.js";
import type { ApprovalPress, DashboardState, LifecyclePair, PullRequestApprovalStatus } from "../src/dashboard/store/types.js";
import { click, cylinder, flatten, renderInbox, stateWith } from "./dashboard-helpers.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** A ready PR #10 on issue #1 in o/a, parked by the review label. */
function parkedPair(overrides: Partial<LifecyclePair> = {}, pr: Record<string, unknown> = {}): LifecyclePair {
  return {
    issue: { number: 1, title: "Add the thing", state: "open" },
    pr: { number: 10, title: "Add the thing", state: "open", draft: false, checksStatus: "success", ...pr },
    prPhase: "review",
    approval: "awaiting-approval",
    repo: "o/a",
    ...overrides,
  };
}

const INBOX_CSS = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "dashboard", "styles", "inbox.css"),
  "utf-8",
).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");

/** What the inbox is drawn from besides the PR's own lifecycle. */
interface CardProps {
  /** An engine is running this action on the PR. */
  workingAction?: string;
  approvalStatus?: PullRequestApprovalStatus;
  approvalPress?: ApprovalPress | null;
  connected?: boolean;
  /** Yoke is shutting down. */
  dark?: boolean;
}

/** The dashboard's state with `pair` as its one piece of work, and `props` applied. */
function stateFor(pair: LifecyclePair, props: CardProps = {}): DashboardState {
  const key = `${pair.repo ?? ""}#${pair.pr?.number ?? 0}`;
  let state = stateWith([pair], pair.repo ?? "");
  if (props.workingAction !== undefined) {
    state = { ...state, cylinders: [cylinder({ actionType: props.workingAction, repo: pair.repo ?? null, issueNumber: pair.issue?.number ?? null, prNumber: pair.pr?.number ?? null })] };
  }
  if (props.approvalStatus) state = { ...state, approvals: new Map([[key, props.approvalStatus]]) };
  if (props.approvalPress) state = { ...state, approvalPresses: new Map([[key, props.approvalPress]]) };
  if (props.connected === false) state = { ...state, connection: "disconnected" };
  if (props.dark) state = { ...state, shutdownRequested: true };
  return state;
}

/**
 * The inbox card for `pair`'s PR, built and drawn the way the app does it:
 * its markup, and its Approve button if it has one.
 */
function renderCard(pair: LifecyclePair, props: CardProps = {}, inbox = new YokeInbox()) {
  const rendered = renderInbox(stateFor(pair, props), { inbox });
  const card = rendered.card();
  return { inbox, cards: rendered.cards, html: flatten(card), button: rendered.approveButton() };
}

/** The status line of a card, saying `text`. */
function statusLine(text: string, tone: string = ""): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`class="inbox-line${tone ? ` ${tone}` : "[^\"]*"}" role="status" aria-live="polite">${escaped}</p>`);
}

// ── when a pill offers Approve ───────────────────────────────────────────────

test("approveControl: a ready PR parked by the review label offers Approve", () => {
  const control = approveControl(parkedPair(), "review", false);

  assert.deepEqual(control, {
    target: { repo: "o/a", pullRequestNumber: 10 },
    disabled: false,
    title: "Approve PR #10: yoke squash-merges it",
  });
});

test("approveControl: while checks run it approves a merge that waits for them", () => {
  const control = approveControl(parkedPair({}, { checksStatus: "pending" }), "waiting-ci", false);

  assert.equal(control?.disabled, false);
  assert.equal(control?.title, "Approve PR #10: yoke squash-merges it once its checks pass");
});

test("approveControl: failing checks disable the button, saying why", () => {
  const control = approveControl(parkedPair({}, { checksStatus: "failure" }), "review", false);

  assert.equal(control?.disabled, true);
  assert.match(control?.title ?? "", /Checks are failing on PR #10/);
});

test("approveControl: no button unless the PR is parked awaiting approval and nothing else is going on", () => {
  const cases: Array<[string, LifecyclePair, ReturnType<typeof pillActivity>, boolean]> = [
    ["not review-gated", (({ approval: _, ...pair }) => pair)(parkedPair()), "review", false],
    ["already approved", parkedPair({ approval: "approved" }), null, false],
    ["a draft", parkedPair({ prPhase: "active" }, { draft: true }), null, false],
    ["merged", parkedPair({ prPhase: "completed" }), null, false],
    ["labelled manual", parkedPair({ disabled: true }), "manual", false],
    ["an engine on it", parkedPair(), "working", false],
    ["yoke shutting down", parkedPair(), "review", true],
    ["no PR", parkedPair({ pr: null, prPhase: "absent" }), null, false],
  ];
  for (const [description, pair, activity, dark] of cases) {
    assert.equal(approveControl(pair, activity, dark), null, description);
  }
});

test("approveRequestMessage names the PR by repo and number", () => {
  assert.deepEqual(approveRequestMessage({ repo: "o/b", pullRequestNumber: 7 }), {
    type: "pull-request-approve-request",
    repo: "o/b",
    pullRequestNumber: 7,
  });
});

test("pillActivity: an approved PR no longer reads as waiting on a reviewer", () => {
  assert.equal(pillActivity(parkedPair(), []), "review", "parked: the eye");
  assert.equal(pillActivity(parkedPair({ approval: "approved" }), []), null, "approved: no eye");
  assert.equal(
    pillActivity(parkedPair({ approval: "approved" }, { checksStatus: "pending" }), []),
    "waiting-ci",
    "approved, its merge waiting on checks: the hourglass",
  );
});

// ── the inbox card ───────────────────────────────────────────────────────────

/**
 * Do with the inbox's presses what yoke-app and the store do: record each one,
 * sent unless `sent` is false. `pressed` is the PRs pressed, in order, and
 * `press()` the press now on record for PR #10, to draw the inbox from again.
 */
function actLikeTheApp(inbox: YokeInbox, sent = true) {
  let state = initialState();
  const pressed: unknown[] = [];
  inbox.addEventListener("inbox-approve", (event) => {
    const target = (event as CustomEvent<{ repo: string; pullRequestNumber: number }>).detail;
    pressed.push(target);
    state = recordApprovalPress(state, target, sent, Date.now());
  });
  return { pressed, press: () => approvalPressFor(state.approvalPresses, parkedPair()) };
}

test("inbox card: a parked PR has a card in the inbox with an Approve button", () => {
  const { html, button, cards } = renderCard(parkedPair());

  assert.equal(cards.length, 1, "one card for the one parked PR");
  assert.ok(button, "an Approve button");
  assert.match(html, /class="inbox-card source-approval accent-work step-idle"/);
  assert.match(html, /data-card="approval:o\/a#10"/);
  assert.match(html, /<span class="inbox-eyebrow">Approve to merge<\/span>/);
  assert.match(html, /<h3 class="inbox-title">Add the thing<\/h3>/);
  assert.match(flatten(button), /class="inbox-action approve idle"/);
  assert.match(flatten(button), />Approve<\/button>/);
  assert.match(flatten(button), /title="Approve PR #10: yoke squash-merges it"/);
  assert.match(flatten(button), /\?disabled=false/);
});

test("inbox card: it links to the PR and to the issue it closes, each a target of its own", () => {
  const { html } = renderCard(parkedPair());

  assert.match(html, /class="inbox-link"\s+href="https:\/\/github\.com\/o\/a\/pull\/10"\s+target="_blank"\s+rel="noopener noreferrer"/);
  assert.match(html, /class="inbox-link"\s+href="https:\/\/github\.com\/o\/a\/issues\/1"/);
  assert.match(html, /<span class="inbox-facts">checks passing<\/span>/);
});

test("inbox card: failing checks render the button disabled", () => {
  const { button, html } = renderCard(parkedPair({}, { checksStatus: "failure" }));

  assert.match(flatten(button), /\?disabled=true/);
  assert.match(flatten(button), /title="Checks are failing on PR #10/);
  assert.match(html, /<span class="inbox-facts">checks failing<\/span>/);
});

test("inbox card: an approved PR's card says so, its button Queued until an engine picks it up", () => {
  const { html, button } = renderCard(parkedPair({ approval: "approved" }));

  assert.match(flatten(button), />Queued<\/button>/);
  assert.match(flatten(button), /\?disabled=true/);
  assert.match(html, /<span class="inbox-eyebrow">Approval queued<\/span>/);
  assert.match(html, statusLine("approved — waiting for a free engine to squash-merge it", "approved"));
});

test("inbox card: one press approves — it asks yoke once and reads Queued at once (#278)", () => {
  const inbox = new YokeInbox();
  const app = actLikeTheApp(inbox);

  click(renderCard(parkedPair(), {}, inbox).button);
  assert.deepEqual(app.pressed, [{ repo: "o/a", pullRequestNumber: 10 }], "no confirming second click");

  const { html, button } = renderCard(parkedPair(), { approvalPress: app.press() }, inbox);
  assert.match(flatten(button), /class="inbox-action approve queued"/);
  assert.match(flatten(button), />Queued<\/button>/);
  assert.match(flatten(button), /\?disabled=true/, "and cannot be sent twice");
  assert.match(html, statusLine("queued — sent to yoke…", "progress"));

  click(button);
  assert.equal(app.pressed.length, 1);
});

test("inbox card: there is no confirm step left anywhere", () => {
  assert.ok(!Object.values(APPROVE_BUTTON_LABELS).some((label) => /confirm/i.test(label)));
  assert.ok(!/\.confirm\b/.test(INBOX_CSS), "nor its styling");
});

test("inbox card: a press made while not connected reads Queued, waiting to be sent, and is not pressed twice (#278)", () => {
  const inbox = new YokeInbox();
  const app = actLikeTheApp(inbox, false);

  click(renderCard(parkedPair(), {}, inbox).button);
  const { html, button } = renderCard(parkedPair(), { approvalPress: app.press(), connected: false }, inbox);
  assert.match(flatten(button), />Queued<\/button>/, "never back to Approve, and never an error to give up on");
  assert.match(flatten(button), /\?disabled=true/);
  assert.match(html, statusLine("queued — reconnecting to yoke…", "progress"));

  click(button);
  assert.equal(app.pressed.length, 1, "the store sends it when the connection is back");
});

test("inbox card: a press shows on its own PR's card, and on no other", () => {
  const press: ApprovalPress = { repo: "o/a", pullRequestNumber: 10, atMs: Date.now(), sent: true };
  const other = parkedPair({ issue: { number: 2, title: "Other", state: "open" } }, { number: 11 });
  const state = { ...stateWith([parkedPair(), other]), approvalPresses: new Map([["o/a#10", press]]) };
  const rendered = renderInbox(state);

  assert.deepEqual(rendered.cards.map((card) => card.id), ["approval:o/a#10", "approval:o/a#11"], "a card is known by its PR");
  assert.match(flatten(rendered.approveButton(10)), />Queued<\/button>/);
  assert.match(flatten(rendered.approveButton(11)), />Approve<\/button>/, "PR #11 was not pressed");
});

test("inbox card: the button is one size in every step, so pressing it and following the approval never move anything", () => {
  const rule = /\.inbox-action \{([^}]*)\}/.exec(INBOX_CSS)?.[1] ?? "";
  assert.match(rule, /width: 100%;/, "as wide as its card");
  assert.match(rule, /min-height: 56px;/, "and as tall in every step");
  assert.match(rule, /white-space: nowrap;/);

  for (const step of Object.keys(APPROVE_BUTTON_LABELS)) {
    const rules = [...INBOX_CSS.matchAll(new RegExp(`\\.inbox-action\\.approve[^{]*\\.${step}[^{]*\\{([^}]*)\\}`, "g"))];
    assert.ok(rules.length > 0, `${step} is styled`);
    for (const [, body] of rules) {
      assert.doesNotMatch(body!, /(?:^|[\s;])(?:width|height|min-height|padding|margin|font-size|letter-spacing|border-width)\s*:/, `${step} changes no size`);
    }
  }
});

test("inbox card: a pressed button stays lit; only Approve and Retry grey out when they cannot be pressed", () => {
  assert.match(INBOX_CSS, /\.inbox-action\.approve:is\(\.idle, \.retry\):disabled \{[^}]*color: rgba\(255, 255, 255, 0\.36\);/);
  assert.ok(!/\.inbox-action:disabled \{[^}]*(?:color|background)\s*:/.test(INBOX_CSS), "no grey for every disabled step");
  assert.match(/\.inbox-action\.approve\.queued \{([^}]*)\}/.exec(INBOX_CSS)?.[1] ?? "", /border-color: var\(--color-green\);/, "Queued is lit");
  assert.match(/\.inbox-action\.approve\.queued \{([^}]*)\}/.exec(INBOX_CSS)?.[1] ?? "", /animation: approvalQueued/, "and breathing");
  assert.match(/\.inbox-action\.approve\.approving \{([^}]*)\}/.exec(INBOX_CSS)?.[1] ?? "", /animation: approvalCarriedOut/);
});

test("inbox card: Approve is trim until it is pressed, and green only while the approval goes through (#280)", () => {
  const idle = /\.inbox-action\.approve\.idle, \.inbox-action\.wake \{([^}]*)\}/.exec(INBOX_CSS)?.[1] ?? "";
  assert.match(idle, /background: var\(--trim-bright\);/);
  assert.doesNotMatch(idle, /--color-/, "no status color on a button nobody has pressed");
});

test("inbox: every target is big enough for a finger", () => {
  const px = (selector: string, property: string): number => {
    const rule = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(INBOX_CSS)?.[1] ?? "";
    return Number(new RegExp(`(?:^|[\\s;])${property}: ([\\d.]+)px;`).exec(rule)?.[1]);
  };
  assert.ok(px(".inbox-action", "min-height") >= 56, "the one thing a card does");
  assert.ok(px(".inbox-link", "min-height") >= 44);
  assert.ok(px(".inbox-dismiss", "width") >= 44 && px(".inbox-dismiss", "height") >= 44);
  assert.ok(px(".inbox-badge", "height") >= 44);
  assert.ok(px(".inbox-log", "min-height") >= 44);
  assert.ok(!/:hover[^{]*\{[^}]*(?:display|visibility)\s*:/.test(INBOX_CSS), "and nothing is revealed only by hovering");
});

// ── what the pill shows of an approval (#276, #278) ──────────────────────────

const NOW = Date.parse("2026-10-28T23:21:15.000Z");

function approvalStatus(
  state: PullRequestApprovalStatus["state"],
  receivedAtMs: number,
  extra: Partial<PullRequestApprovalStatus> = {},
): PullRequestApprovalStatus {
  return { repo: "o/a", pullRequestNumber: 10, requestedAt: "2026-10-28T23:21:15.000Z", state,
    emittedAt: new Date(receivedAtMs).toISOString(), receivedAtMs, ...extra };
}

function pressAt(atMs: number, extra: Partial<ApprovalPress> = {}): ApprovalPress {
  return { repo: "o/a", pullRequestNumber: 10, atMs, sent: true, ...extra };
}

/** The view of PR #10's approval, parked awaiting it unless `pair` says otherwise. */
function view(opts: {
  nowMs: number;
  status?: PullRequestApprovalStatus | null;
  press?: ApprovalPress | null;
  pair?: LifecyclePair;
  activity?: PillActivity | null;
  workingAction?: string | null;
  dark?: boolean;
  connected?: boolean;
}): ApprovalView {
  const pair = opts.pair ?? parkedPair();
  return approvalView({
    pair,
    activity: opts.activity !== undefined ? opts.activity : pillActivity(pair, []),
    workingAction: opts.workingAction ?? null,
    dark: opts.dark ?? false,
    status: opts.status ?? null,
    press: opts.press ?? null,
    connected: opts.connected ?? true,
    nowMs: opts.nowMs,
  });
}

test("approvalView: one press reads Queued at once, before yoke has said a word", () => {
  const v = view({ press: pressAt(NOW), nowMs: NOW });

  assert.deepEqual(v.button, { step: "queued", label: "Queued", disabled: true, title: "PR #10 · queued — sent to yoke…" });
  assert.deepEqual(v.line, { text: "queued — sent to yoke…", tone: "progress" });
  assert.equal(v.approved, false);
  assert.equal(v.refreshAtMs, NOW + APPROVE_ACK_MS, "and looks again when the answer is due");
});

test("approvalView: an answer from before the press is not an answer to it", () => {
  const earlier = approvalStatus("refused", NOW - 1, { reason: "its checks are failing" });

  assert.equal(view({ status: earlier, press: pressAt(NOW), nowMs: NOW + 1_000 }).button?.label, "Queued");
});

test("approvalView: while yoke reads the PR and waits for an engine to finish planning, it stays Queued, with no time limit", () => {
  const loading = view({ status: approvalStatus("loading", NOW + 50), press: pressAt(NOW), nowMs: NOW + 1_000 });
  assert.deepEqual(loading.button, {
    step: "queued", label: "Queued", disabled: true, title: "PR #10 · queued — yoke is reading PR #10 from GitHub…",
  });
  assert.deepEqual(loading.line, { text: "queued — yoke is reading PR #10 from GitHub…", tone: "progress" });
  assert.equal(loading.refreshAtMs, null, "no fallback timer");

  const waiting = view({ status: approvalStatus("waiting", NOW + 50), press: pressAt(NOW), nowMs: NOW + 10 * 60_000 });
  assert.equal(waiting.button?.label, "Queued", "ten minutes on, still Queued");
  assert.equal(waiting.line?.text, "queued — waiting for an engine to finish planning…");
});

test("approvalView: an approval this dashboard did not send shows Queued too", () => {
  // Another dashboard's, or one in flight when this page loaded.
  const v = view({ status: approvalStatus("waiting", NOW), nowMs: NOW + 5_000 });

  assert.equal(v.button?.label, "Queued");
  assert.equal(v.button?.disabled, true);
  assert.equal(v.line?.text, "queued — waiting for an engine to finish planning…");
});

test("approvalView: approved, it reads APPROVED and stays Queued until an engine picks it up", () => {
  const approved = approvalStatus("approved", NOW + 2_000, { checksPending: false });

  const v = view({ status: approved, press: pressAt(NOW), nowMs: NOW + 3_000 });
  assert.equal(v.button?.label, "Queued");
  assert.equal(v.button?.disabled, true);
  assert.equal(v.approved, true);
  assert.deepEqual(v.line, { text: "approved — waiting for a free engine to squash-merge it", tone: "approved" });

  const pending = view({
    status: approvalStatus("approved", NOW + 2_000, { checksPending: true }), press: pressAt(NOW), nowMs: NOW + 3_000,
  });
  assert.equal(pending.line?.text, "approved — an engine squash-merges it once its checks pass");

  // The lifecycle shows the approval: there is no Approve control any more,
  // and still the pill says where the approval stands, however long it waits.
  const shown = parkedPair({ approval: "approved" });
  assert.equal(approveControl(shown, null, false), null);
  const later = view({ pair: shown, status: approved, press: pressAt(NOW), nowMs: NOW + 60 * 60_000 });
  assert.equal(later.button?.label, "Queued", "an hour on, still Queued");
  assert.equal(later.line?.text, "approved — waiting for a free engine to squash-merge it");
  assert.equal(later.approved, true);
});

test("approvalView: the moment an engine picks it up it reads Approving, and never loses its button", () => {
  const approved = approvalStatus("approved", NOW + 2_000);

  const merging = view({
    pair: parkedPair({ approval: "approved" }), activity: "working", workingAction: "squash-merge", nowMs: NOW + 3_000,
  });
  assert.deepEqual(merging.button, {
    step: "approving", label: "Approving", disabled: true, title: "PR #10 · approving — an engine is squash-merging it",
  });
  assert.deepEqual(merging.line, { text: "approving — an engine is squash-merging it", tone: "approved" });
  assert.equal(merging.approved, true);

  // Should the lifecycle carry no approval while an engine runs on it, and
  // `approveControl` offer nothing, the press's answer carries it through.
  const unmarked = (({ approval: _, ...pair }) => pair)(parkedPair());
  assert.equal(approveControl(unmarked, "working", false), null);
  const carried = view({
    pair: unmarked, activity: "working", workingAction: "squash-merge", status: approved, press: pressAt(NOW),
    nowMs: NOW + 10 * 60_000,
  });
  assert.equal(carried.button?.label, "Approving");
  assert.equal(carried.approved, true, "APPROVED, not READY");
});

test("approvalView: an engine fixing the PR first reads Approving too: the approval stands until it merges (#278)", () => {
  const cases: Array<[string | null, string]> = [
    ["address-failing-checks", "approving — an engine is fixing its failing checks, then it squash-merges"],
    ["resolve-conflicts", "approving — an engine is resolving its merge conflicts, then it squash-merges"],
    ["self-review", "approving — an engine is reviewing it again, then it squash-merges"],
    ["address-review-comments", "approving — an engine is working on it, then it squash-merges"],
  ];
  for (const [workingAction, text] of cases) {
    const v = view({ pair: parkedPair({ approval: "approved" }), activity: "working", workingAction, nowMs: NOW });

    assert.equal(v.button?.label, "Approving", String(workingAction));
    assert.deepEqual(v.line, { text, tone: "approved" }, String(workingAction));
    assert.ok(!/back for approval/.test(v.line?.text ?? ""), "it never comes back for approval");
  }

  const failed = view({ pair: parkedPair({ approval: "approved" }, { checksStatus: "failure" }), nowMs: NOW });
  assert.equal(failed.button?.label, "Queued");
  assert.equal(failed.line?.text, "approved — its checks failed: an engine fixes them, then squash-merges it");
});

test("approvalView: once an engine has squash-merged it, it reads Merged", () => {
  const v = view({ press: pressAt(NOW, { merged: true }), status: approvalStatus("approved", NOW + 1), nowMs: NOW + 60_000 });

  assert.equal(v.button?.label, "Merged");
  assert.equal(v.button?.disabled, true);
  assert.deepEqual(v.line, { text: "merged — an engine squash-merged it", tone: "approved" });
});

test("approvalView: a merged, draft or manual PR's pill shows no approval: its badges say it", () => {
  const press = pressAt(NOW, { merged: true });
  for (const pair of [
    parkedPair({ prPhase: "completed" }),
    parkedPair({ disabled: true }),
    parkedPair({ pr: null, prPhase: "absent" }),
  ]) {
    assert.deepEqual(view({ pair, press, nowMs: NOW }), { button: null, approved: false, line: null, refreshAtMs: null });
  }
  const draft = parkedPair({ prPhase: "active" }, { draft: true });
  assert.deepEqual(view({ pair: draft, nowMs: NOW }), { button: null, approved: false, line: null, refreshAtMs: null });
});

test("approvalView: a press on a PR that goes back to draft keeps saying how it fared (#278)", () => {
  const { approval: _awaiting, ...draft } = parkedPair({ prPhase: "active" }, { draft: true });
  const pair: LifecyclePair = draft;

  const unanswered = view({ pair, press: pressAt(NOW), nowMs: NOW + 1_000 });
  assert.equal(unanswered.button?.label, "Queued");
  assert.deepEqual(unanswered.line, { text: "queued — sent to yoke…", tone: "progress" });

  const refused = view({
    pair,
    press: pressAt(NOW),
    status: approvalStatus("refused", NOW + 2_000, { reason: "PR #10 is not waiting on approval" }),
    nowMs: NOW + 3_000,
  });
  assert.equal(refused.button?.label, "Retry");
  assert.equal(refused.button?.disabled, true);
  assert.deepEqual(refused.line, { text: "not approved: PR #10 is not waiting on approval", tone: "problem" });
});

test("approvalView: an approved PR back in draft keeps its approval: it is re-reviewed, then merged (#278)", () => {
  const pair = parkedPair({ prPhase: "active", approval: "approved" }, { draft: true });
  const answer = approvalStatus("approved", NOW + 1_000);

  const waiting = view({ pair, press: pressAt(NOW), status: answer, nowMs: NOW + 5 * 60_000 });
  assert.equal(waiting.button?.label, "Queued");
  assert.equal(waiting.approved, true);
  assert.deepEqual(waiting.line, {
    text: "approved — back in draft: an engine reviews it again, then squash-merges it", tone: "approved",
  });

  const reviewing = view({ pair, status: answer, activity: "working", workingAction: "self-review", nowMs: NOW + 6 * 60_000 });
  assert.equal(reviewing.button?.label, "Approving", "another dashboard's approval shows the same way");
  assert.deepEqual(reviewing.line, {
    text: "approving — an engine is reviewing it again, then it squash-merges", tone: "approved",
  });
});

test("approvalView: a refusal shows its reason and offers Retry, for as long as the pill is there", () => {
  const refused = approvalStatus("refused", NOW + 2_000, { reason: "its checks are failing" });
  const v = view({ status: refused, press: pressAt(NOW), nowMs: NOW + 3_000 });

  assert.deepEqual(v.button, {
    step: "retry", label: "Retry", disabled: false, title: "Retry — Approve PR #10: yoke squash-merges it",
  });
  assert.deepEqual(v.line, { text: "not approved: its checks are failing", tone: "problem" });

  const later = view({ status: refused, press: pressAt(NOW), nowMs: NOW + 60 * 60_000 });
  assert.equal(later.button?.label, "Retry", "an hour on, it has not gone stale");
  assert.equal(later.line?.text, "not approved: its checks are failing");
  assert.equal(later.refreshAtMs, null);
});

test("approvalView: a failure shows its first line and offers Retry", () => {
  const v = view({ status: approvalStatus("failed", NOW + 2_000, { reason: "GitHub said 502" }), press: pressAt(NOW), nowMs: NOW + 3_000 });

  assert.equal(v.button?.label, "Retry");
  assert.equal(v.button?.disabled, false);
  assert.deepEqual(v.line, { text: "approval failed: GitHub said 502", tone: "problem" });
});

test("approvalView: Retry is disabled, saying why, while the PR cannot be approved", () => {
  const busy = view({
    status: approvalStatus("refused", NOW + 1_000, { reason: "an engine is working on it" }),
    press: pressAt(NOW), activity: "working", workingAction: "self-review", nowMs: NOW + 2_000,
  });
  assert.deepEqual(busy.button, { step: "retry", label: "Retry", disabled: true, title: "Cannot retry: an engine is working on PR #10" });
  assert.equal(busy.line?.text, "not approved: an engine is working on it");

  const failing = view({
    pair: parkedPair({}, { checksStatus: "failure" }),
    status: approvalStatus("refused", NOW + 1_000, { reason: "its checks are failing" }),
    press: pressAt(NOW), nowMs: NOW + 2_000,
  });
  assert.equal(failing.button?.label, "Retry");
  assert.equal(failing.button?.disabled, true);
  assert.match(failing.button?.title ?? "", /Checks are failing on PR #10/);
});

test("approvalView: no answer within APPROVE_ACK_MS stays Queued and says so, for good: there is no error state (#278)", () => {
  const v = view({ press: pressAt(NOW), nowMs: NOW + APPROVE_ACK_MS });
  assert.equal(v.button?.label, "Queued");
  assert.equal(v.button?.disabled, true);
  assert.deepEqual(v.line, { text: "queued — sent to yoke, no answer yet…", tone: "progress" });
  assert.equal(v.refreshAtMs, null, "nothing more to wait for but an answer");
  assert.equal(view({ press: pressAt(NOW), nowMs: NOW + 60 * 60_000 }).button?.label, "Queued", "an hour on, still");

  const late = view({ status: approvalStatus("waiting", NOW + APPROVE_ACK_MS + 2_000), press: pressAt(NOW), nowMs: NOW + APPROVE_ACK_MS + 3_000 });
  assert.equal(late.line?.text, "queued — waiting for an engine to finish planning…", "a late answer still counts");

  // Sent again on reconnecting: it waits for an answer from then.
  const resent = pressAt(NOW, { sentAtMs: NOW + 60_000 });
  assert.equal(view({ press: resent, nowMs: NOW + 61_000 }).line?.text, "queued — sent to yoke…");
  assert.equal(view({ press: resent, nowMs: NOW + 61_000 }).refreshAtMs, NOW + 60_000 + APPROVE_ACK_MS);
});

test("approvalView: a dashboard that lost its connection stays Queued, reconnecting, and takes a late answer", () => {
  for (const nowMs of [NOW + 1_000, NOW + APPROVE_ACK_MS, NOW + 60 * 60_000]) {
    const away = view({ press: pressAt(NOW), connected: false, nowMs });
    assert.equal(away.button?.label, "Queued");
    assert.deepEqual(away.line, { text: "queued — reconnecting to yoke…", tone: "progress" });
  }

  const replayed = approvalStatus("approved", NOW + 60_000);
  assert.equal(view({ status: replayed, press: pressAt(NOW), nowMs: NOW + 60_001 }).line?.text,
    "approved — waiting for a free engine to squash-merge it", "the replay brings it");
});

test("approvalView: a press made while not connected stays Queued until the store can send it", () => {
  const press = pressAt(NOW, { sent: false });

  for (const connected of [false, true]) {
    const v = view({ press, connected, nowMs: NOW + 60 * 60_000 });
    assert.equal(v.button?.label, "Queued");
    assert.equal(v.button?.disabled, true);
    assert.deepEqual(v.line, { text: "queued — reconnecting to yoke…", tone: "progress" });
  }
});

test("approvalView: another dashboard's refusal shows on Approve, for a minute", () => {
  const refused = approvalStatus("refused", NOW, { reason: "its checks are failing" });

  const v = view({ status: refused, nowMs: NOW + 1_000 });
  assert.equal(v.button?.label, "Approve", "this dashboard pressed nothing");
  assert.deepEqual(v.line, { text: "not approved: its checks are failing", tone: "problem" });
  assert.equal(v.refreshAtMs, NOW + APPROVAL_OUTCOME_SHOW_MS);
  assert.equal(view({ status: refused, nowMs: NOW + APPROVAL_OUTCOME_SHOW_MS }).line, null);
});

test("approvalView: should yoke ask for approval again after recording one, Approve comes back, saying so", () => {
  const approved = approvalStatus("approved", NOW + 2_000);

  // A beat after the answer the lifecycle may not have caught up yet.
  const lagging = view({ status: approved, press: pressAt(NOW), nowMs: NOW + 3_000 });
  assert.equal(lagging.button?.label, "Queued");
  assert.equal(lagging.refreshAtMs, NOW + 2_000 + APPROVAL_OUTCOME_SHOW_MS);

  // Long after, a lifecycle asking for approval means yoke wants a new one.
  const again = view({ status: approved, press: pressAt(NOW), nowMs: NOW + 2_000 + APPROVAL_OUTCOME_SHOW_MS });
  assert.deepEqual(again.button, { step: "idle", label: "Approve", disabled: false, title: "Approve PR #10: yoke squash-merges it" });
  assert.deepEqual(again.line, { text: "approved earlier — yoke is asking for approval again", tone: "progress" });
  assert.equal(again.approved, false);
});

test("approvalView: shutting down, an approval waits for yoke to run again, and a refused press says why it cannot retry", () => {
  const waiting = view({ pair: parkedPair({ approval: "approved" }), dark: true, nowMs: NOW });
  assert.equal(waiting.button?.label, "Queued");
  assert.equal(waiting.line?.text, "approved — an engine squash-merges it once yoke runs again");

  const refused = view({
    status: approvalStatus("refused", NOW + 1_000, { reason: "yoke is shutting down and will start no new work" }),
    press: pressAt(NOW), dark: true, nowMs: NOW + 2_000,
  });
  assert.deepEqual(refused.button, { step: "retry", label: "Retry", disabled: true, title: "Cannot retry: yoke is shutting down" });
});

test("approvalView: another PR's status or press never shows on this one", () => {
  const other = { ...approvalStatus("refused", NOW, { reason: "it is not open" }), pullRequestNumber: 11 };
  const otherProject = { ...approvalStatus("waiting", NOW), repo: "o/b" };

  assert.equal(view({ status: other, nowMs: NOW + 1_000 }).line, null);
  assert.equal(view({ status: otherProject, nowMs: NOW + 1_000 }).line, null);
  assert.equal(view({ press: { ...pressAt(NOW), pullRequestNumber: 11 }, nowMs: NOW + 1_000 }).button?.label, "Approve");
  assert.equal(view({ press: { ...pressAt(NOW), repo: "o/b" }, nowMs: NOW + 1_000 }).button?.label, "Approve");
});

test("approvalView: after a press the pill never reads Approve as if it had not been pressed, nor loses its button (#278)", () => {
  const states: Array<PullRequestApprovalStatus["state"] | null> = [null, "loading", "waiting", "approved", "refused", "failed"];
  const arrivals = [-1_000, 1, 5_000];
  const offsets = [0, 1_000, APPROVE_ACK_MS - 1, APPROVE_ACK_MS, APPROVAL_OUTCOME_SHOW_MS, APPROVAL_OUTCOME_SHOW_MS + 6_000, 60 * 60_000];
  const lifecycles: Array<LifecyclePair["approval"]> = ["awaiting-approval", "approved", undefined];
  const activities: Array<PillActivity | null | "derived"> = ["derived", "working"];
  const connections = [true, false];
  let checked = 0;

  for (const state of states) for (const arrival of arrivals) for (const offset of offsets)
  for (const approval of lifecycles) for (const activity of activities) for (const connected of connections)
  for (const sent of [true, false]) {
    const base = parkedPair();
    const pair: LifecyclePair = approval === undefined ? (({ approval: _, ...rest }) => rest)(base) : { ...base, approval };
    const status = state === null ? null : approvalStatus(state, NOW + arrival, { reason: "a reason" });
    const v = view({
      pair, status, press: pressAt(NOW, { sent }), nowMs: NOW + Math.max(offset, arrival),
      activity: activity === "derived" ? pillActivity(pair, []) : activity,
      workingAction: activity === "working" ? "squash-merge" : null,
      connected,
    });
    const description = JSON.stringify({ state, arrival, offset, approval, activity, connected, sent });
    assert.ok(v.button !== null, `a button: ${description}`);
    if (v.button?.step === "idle") {
      // The one way back to Approve: the approval went through, and long
      // after, with no engine on it, yoke asks for a new one — and says so.
      assert.equal(state, "approved", description);
      assert.ok(arrival > 0 && approval === "awaiting-approval" && activity !== "working", description);
      assert.match(v.line?.text ?? "", /^approved earlier/, description);
    }
    if (v.button?.step === "retry") {
      assert.equal(v.line?.tone, "problem", `Retry says why: ${description}`);
      assert.ok(state === "refused" || state === "failed", `Retry only on yoke's own refusal or failure: ${description}`);
    }
    if (state === null) assert.notEqual(v.button?.step, "retry", `no answer is no error: ${description}`);
    checked++;
  }
  assert.ok(checked > 1_000);
});

test("approvalStatusFor finds a pill's PR by project and number", () => {
  const approvals = new Map<string, PullRequestApprovalStatus>([
    ["o/a#10", approvalStatus("waiting", NOW)],
    ["o/b#10", { ...approvalStatus("refused", NOW), repo: "o/b" }],
  ]);

  assert.equal(approvalStatusFor(approvals, parkedPair())?.state, "waiting");
  assert.equal(approvalStatusFor(approvals, parkedPair({ repo: "o/b" }))?.state, "refused");
  assert.equal(approvalStatusFor(approvals, parkedPair({}, { number: 11 })), null);
  assert.equal(approvalStatusFor(approvals, parkedPair({ pr: null, prPhase: "absent" })), null);
});

test("approvalPressFor finds this dashboard's press of a pill's PR by project and number", () => {
  const presses = recordApprovalPress(
    recordApprovalPress(initialState(), { repo: "o/a", pullRequestNumber: 10 }, true, NOW),
    { repo: "o/b", pullRequestNumber: 10 }, false, NOW + 1,
  ).approvalPresses;

  assert.deepEqual(approvalPressFor(presses, parkedPair()), pressAt(NOW));
  assert.equal(approvalPressFor(presses, parkedPair({ repo: "o/b" }))?.sent, false);
  assert.equal(approvalPressFor(presses, parkedPair({}, { number: 11 })), null);
  assert.equal(approvalPressFor(presses, parkedPair({ pr: null, prPhase: "absent" })), null);
});

// ── the card following yoke and the engines ──────────────────────────────────

test("inbox card: after one press it follows yoke and the engines, not a timer, from Queued to Merged", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const inbox = new YokeInbox();
  const app = actLikeTheApp(inbox);

  click(renderCard(parkedPair(), {}, inbox).button);
  const press = app.press();
  let rendered = renderCard(parkedPair(), { approvalPress: press }, inbox);
  assert.match(flatten(rendered.button), />Queued<\/button>/, "Queued the instant it is pressed");
  assert.match(rendered.html, statusLine("queued — sent to yoke…"));

  t.mock.timers.tick(50);
  rendered = renderCard(parkedPair(), { approvalPress: press, approvalStatus: approvalStatus("loading", Date.now()) }, inbox);
  assert.match(flatten(rendered.button), />Queued<\/button>/);
  assert.match(rendered.html, statusLine("queued — yoke is reading PR #10 from GitHub…"));

  t.mock.timers.tick(40_000);
  rendered = renderCard(parkedPair(), { approvalPress: press, approvalStatus: approvalStatus("waiting", Date.now() - 39_000) }, inbox);
  assert.match(flatten(rendered.button), />Queued<\/button>/, "no fallback timer");
  assert.match(rendered.html, statusLine("queued — waiting for an engine to finish planning…"));

  const approved = approvalStatus("approved", Date.now(), { checksPending: false });
  rendered = renderCard(parkedPair({ approval: "approved" }), { approvalPress: press, approvalStatus: approved }, inbox);
  assert.match(flatten(rendered.button), />Queued<\/button>/, "approved, waiting for an engine");
  assert.match(rendered.html, /<span class="inbox-eyebrow">Approval queued<\/span>/);
  assert.match(rendered.html, statusLine("approved — waiting for a free engine to squash-merge it"));

  t.mock.timers.tick(5_000);
  rendered = renderCard(parkedPair(), { approvalPress: press, approvalStatus: approved, workingAction: "squash-merge" }, inbox);
  assert.match(flatten(rendered.button), />Approving<\/button>/, "an engine picked it up");
  assert.match(rendered.html, /<span class="inbox-eyebrow">Approving<\/span>/);
  assert.match(rendered.html, statusLine("approving — an engine is squash-merging it"));

  t.mock.timers.tick(90_000);
  const merged = { ...press!, merged: true };
  rendered = renderCard(parkedPair(), { approvalPress: merged, approvalStatus: approved }, inbox);
  assert.match(flatten(rendered.button), />Merged<\/button>/);
  assert.match(rendered.html, /<span class="inbox-eyebrow">Merged<\/span>/);

  rendered = renderCard(parkedPair({ prPhase: "completed" }), { approvalPress: merged }, inbox);
  assert.equal(rendered.cards.length, 0, "merged and done: nothing is left waiting on anyone");
});

test("inbox card: no answer within APPROVE_ACK_MS stays Queued, saying so", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const inbox = new YokeInbox();
  const app = actLikeTheApp(inbox);

  click(renderCard(parkedPair(), {}, inbox).button);
  t.mock.timers.tick(APPROVE_ACK_MS);
  const { html, button } = renderCard(parkedPair(), { approvalPress: app.press() }, inbox);
  assert.match(flatten(button), />Queued<\/button>/);
  assert.match(flatten(button), /\?disabled=true/);
  assert.match(html, statusLine("queued — sent to yoke, no answer yet…"));
});

test("inbox card: another dashboard's approval shows as Queued here", () => {
  const { html, button } = renderCard(parkedPair(), { approvalStatus: approvalStatus("waiting", Date.now()) });

  assert.match(flatten(button), />Queued<\/button>/);
  assert.match(html, statusLine("queued — waiting for an engine to finish planning…"));
});

test("inbox card: a card never shows another PR's status", () => {
  const other = parkedPair({ issue: { number: 2, title: "Other", state: "open" } }, { number: 11 });
  // PR #10's status is on record, but PR #10 is not in the inbox.
  const state = { ...stateWith([other]), approvals: new Map([["o/a#10", approvalStatus("waiting", Date.now())]]) };
  const rendered = renderInbox(state);

  assert.match(flatten(rendered.approveButton(11)), />Approve<\/button>/);
  assert.ok(!rendered.html.includes("queued —"));
});

test("DashboardStore.approvePullRequest records the press, sent or not, so the card follows it", () => {
  const store = new DashboardStore();
  try {
    // No live connection: nothing can be sent.
    assert.equal(store.approvePullRequest({ repo: "o/a", pullRequestNumber: 10 }), false);
    const press = approvalPressFor(store.getState().approvalPresses, parkedPair());
    assert.equal(press?.sent, false);

    const { html, button } = renderCard(parkedPair(), { approvalPress: press, connected: false });
    assert.match(flatten(button), />Queued<\/button>/);
    assert.match(html, statusLine("queued — reconnecting to yoke…"));
  } finally {
    store.disconnect();
  }
});

test("inbox card: the approval line is a live region, there even when it is empty", () => {
  const { html } = renderCard(parkedPair());

  assert.match(html, /<p class="inbox-line" role="status" aria-live="polite"><\/p>/);
});

test("inbox card: a long approval line wraps inside its card, and an empty one takes no room", () => {
  const line = /\.inbox-line \{([^}]*)\}/.exec(INBOX_CSS)?.[1] ?? "";
  assert.match(line, /overflow-wrap: anywhere;/, "a long reason breaks rather than widen the card");
  assert.match(INBOX_CSS, /\.inbox-line:empty \{ display: none; \}/);
  assert.match(/\.inbox-title \{([^}]*)\}/.exec(INBOX_CSS)?.[1] ?? "", /overflow-wrap: anywhere;/);
});

test("inbox card: every Approve button label fits the narrowest the button is ever drawn", () => {
  const rule = /\.inbox-action \{([^}]*)\}/.exec(INBOX_CSS)?.[1] ?? "";
  const px = (property: string) => Number(new RegExp(`${property}: ([\\d.]+)px;`).exec(rule)?.[1]);

  assert.match(rule, /font-family: var\(--font-mono\);/, "a monospace face: every glyph is 0.6em wide");
  // The inbox is never narrower than 300 px, and its card's button never narrower than this.
  const room = 200;
  const perGlyph = 0.6 * px("font-size") + px("letter-spacing");
  for (const label of Object.values(APPROVE_BUTTON_LABELS)) {
    assert.ok(label.length * perGlyph <= room, `${label} (${(label.length * perGlyph).toFixed(1)} px) fits in ${room} px`);
  }
});
