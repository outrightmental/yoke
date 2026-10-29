import test from "node:test";
import assert from "node:assert/strict";

import {
  APPROVAL_OUTCOME_SHOW_MS,
  APPROVE_ACK_MS,
  APPROVE_BUTTON_LABELS,
  APPROVE_CONFIRM_MS,
  approvalStatusFor,
  approvalView,
  approveControl,
  approveRequestMessage,
  type ApproveClick,
} from "../src/dashboard/shared/pill-approval.js";
import { pillActivity } from "../src/dashboard/shared/pill-activity.js";
import { LifecyclePill } from "../src/dashboard/components/lifecycle-pill.js";
import type { LifecyclePair, PullRequestApprovalStatus } from "../src/dashboard/store/types.js";

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

interface Template {
  strings: readonly string[];
  values: readonly unknown[];
}

function isTemplate(value: unknown): value is Template {
  return typeof value === "object" && value !== null && "strings" in value && "values" in value;
}

function flatten(value: unknown): string {
  if (value === null || value === undefined || typeof value === "symbol") return "";
  if (Array.isArray(value)) return value.map(flatten).join("");
  if (isTemplate(value)) {
    return value.strings.reduce((out, s, i) => out + s + (i < value.values.length ? flatten(value.values[i]) : ""), "");
  }
  return String(value);
}

/** The Approve button's template in a rendered pill, if it has one. */
function findApproveButton(value: unknown): Template | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findApproveButton(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!isTemplate(value)) return undefined;
  if (value.strings.join("").includes('class="pill-approve')) return value;
  return findApproveButton([...value.values]);
}

function renderPill(pair: LifecyclePair, props: Record<string, unknown> = {}, pill = new LifecyclePill()) {
  Object.assign(pill, { pair, activity: pillActivity(pair, []), ...props });
  return { pill, html: flatten(pill.render()), button: findApproveButton(pill.render()) };
}

/** Click the rendered Approve button, as the browser would. */
function click(button: Template | undefined): void {
  assert.ok(button, "the pill shows an Approve button");
  const handler = button.values.find((value) => typeof value === "function") as ((event: Event) => void) | undefined;
  assert.ok(handler, "the button has a click handler");
  handler(new Event("click"));
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

// ── the pill ─────────────────────────────────────────────────────────────────

test("lifecycle pill: a parked PR's pill shows an Approve button over its PR half", () => {
  const { html, button } = renderPill(parkedPair());

  assert.ok(button, "an Approve button");
  assert.match(html, /class="lifecycle-pill has-status has-approve"/);
  assert.match(flatten(button), />Approve<\/button>/);
  assert.match(flatten(button), /title="Approve PR #10: yoke squash-merges it"/);
  assert.match(flatten(button), /\?disabled=false/);
  assert.match(html, /READY/);
});

test("lifecycle pill: failing checks render the button disabled", () => {
  const { button } = renderPill(parkedPair({}, { checksStatus: "failure" }));

  assert.match(flatten(button), /\?disabled=true/);
});

test("lifecycle pill: an approved PR's pill drops the button and reads APPROVED", () => {
  const { html, button } = renderPill(parkedPair({ approval: "approved" }));

  assert.equal(button, undefined);
  assert.ok(!html.includes("has-approve"));
  assert.match(html, /APPROVED/);
  assert.ok(!html.includes(">READY<"));
});

test("lifecycle pill: approving takes a confirming second click, then asks yoke once", () => {
  const sent: unknown[] = [];
  const { pill, button } = renderPill(parkedPair());
  pill.addEventListener("pill-approve", (event) => sent.push((event as CustomEvent).detail));

  try {
    click(button);
    assert.deepEqual(sent, [], "one click only arms it");
    const armed = renderPill(parkedPair(), {}, pill).button;
    assert.match(flatten(armed), /class="pill-approve confirm"/);
    assert.match(flatten(armed), />Confirm<\/button>/);

    click(armed);
    assert.deepEqual(sent, [{ repo: "o/a", pullRequestNumber: 10 }], "the second click approves");
    const pending = renderPill(parkedPair(), {}, pill).button;
    assert.match(flatten(pending), />Sending<\/button>/);
    assert.match(flatten(pending), /\?disabled=true/, "and cannot be sent twice");

    click(pending);
    assert.equal(sent.length, 1);
  } finally {
    pill.disconnectedCallback();
  }
});

test("lifecycle pill: a confirmed click that could not be sent goes back to Approve, saying why", () => {
  const { pill, button } = renderPill(parkedPair());
  // What yoke-app does when there is no live connection to send it on.
  pill.addEventListener("pill-approve", (event) => event.preventDefault());

  try {
    click(button);
    click(renderPill(parkedPair(), {}, pill).button);
    const { html, button: after } = renderPill(parkedPair(), {}, pill);
    assert.match(flatten(after), />Approve<\/button>/, "not left reading Sending");
    assert.match(flatten(after), /\?disabled=false/, "and can be pressed again");
    assert.match(html, statusLine("not sent — the dashboard is not connected to yoke"));
  } finally {
    pill.disconnectedCallback();
  }
});

test("lifecycle pill: an armed click never carries over to another PR the element is reused for", () => {
  const sent: unknown[] = [];
  const { pill, button } = renderPill(parkedPair());
  pill.addEventListener("pill-approve", (event) => sent.push((event as CustomEvent).detail));

  try {
    click(button);
    const other = parkedPair({ issue: { number: 2, title: "Other", state: "open" } }, { number: 11 });
    const reused = renderPill(other, {}, pill).button;
    assert.match(flatten(reused), />Approve<\/button>/, "PR #11's button starts idle");

    click(reused);
    assert.deepEqual(sent, [], "so one click on it only arms it");
  } finally {
    pill.disconnectedCallback();
  }
});

test("lifecycle pill: the button keeps both halves the same width, so the seams line up", () => {
  const css = LifecyclePill.styles.toString().replace(/\s+/g, " ");

  const button = /\.pill-approve \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(button, /position: absolute;/, "laid over the PR half, out of the flow");
  assert.match(button, /width: 60px;/, "one width for Approve, Confirm and Sending");
  assert.match(css, /\.lifecycle-pill\.has-approve \.pill-pr-half \.pill-row \{ padding-right: 64px; \}/);
  assert.match(css, /\.lifecycle-pill\.has-approve\.has-status \.pill-pr-half \.pill-row \{ padding-right: 88px; \}/);
  assert.ok(!/has-approve \.pill-pr-half \{/.test(css), "the PR half itself is never resized");
});

// ── what became of the approval (#276) ───────────────────────────────────────

const NOW = Date.parse("2026-10-28T23:21:15.000Z");
const TARGET = { repo: "o/a", pullRequestNumber: 10 };

function approvalStatus(
  state: PullRequestApprovalStatus["state"],
  receivedAtMs: number,
  extra: Partial<PullRequestApprovalStatus> = {},
): PullRequestApprovalStatus {
  return { repo: "o/a", pullRequestNumber: 10, requestedAt: "2026-10-28T23:21:15.000Z", state,
    emittedAt: new Date(receivedAtMs).toISOString(), receivedAtMs, ...extra };
}

function sentAt(atMs: number, step: ApproveClick["step"] = "sent"): ApproveClick {
  return { key: "o/a#10", step, atMs };
}

/** The view of PR #10's approval, parked awaiting it unless `control` says otherwise. */
function view(
  status: PullRequestApprovalStatus | null,
  click: ApproveClick | null,
  nowMs: number,
  control = approveControl(parkedPair(), "review", false),
) {
  return approvalView({ target: TARGET, control, status, click, nowMs });
}

/** Matches the pill's approval line: visible text in its live region. */
function statusLine(text: string): RegExp {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`role="status"\\s+aria-live="polite"\\s*> · ${escaped}</span>`);
}

test("approvalView: a sent click reads Sending until yoke's first answer after it", () => {
  const v = view(null, sentAt(NOW), NOW + 3_000);

  assert.deepEqual(v.button, { step: "sending", label: "Sending", disabled: true, title: "Approval of PR #10 sent to yoke" });
  assert.deepEqual(v.line, { text: "approval sent to yoke…", tone: "progress" });
  assert.equal(v.refreshAtMs, NOW + APPROVE_ACK_MS, "and looks again when the answer is due");
});

test("approvalView: an answer from before the click is not an answer to it", () => {
  const earlier = approvalStatus("refused", NOW - 1, { reason: "its checks are failing" });

  assert.equal(view(earlier, sentAt(NOW), NOW + 1_000).button?.label, "Sending");
});

test("approvalView: while yoke works on the approval it reads Approving, with no time limit", () => {
  const loading = view(approvalStatus("loading", NOW + 50), sentAt(NOW), NOW + 1_000);
  assert.deepEqual(loading.button, { step: "approving", label: "Approving", disabled: true, title: "Yoke is approving PR #10" });
  assert.deepEqual(loading.line, { text: "approving — reading PR #10 from GitHub…", tone: "progress" });
  assert.equal(loading.refreshAtMs, null, "no fallback timer");

  const waiting = view(approvalStatus("waiting", NOW + 50), sentAt(NOW), NOW + 10 * 60_000);
  assert.equal(waiting.button?.label, "Approving", "ten minutes on, still Approving");
  assert.equal(waiting.line?.text, "approving — waiting for a free planner…");
});

test("approvalView: an approval this pill did not send shows too", () => {
  // Another dashboard's, or one in flight when this page loaded.
  const v = view(approvalStatus("waiting", NOW), null, NOW + 5_000);

  assert.equal(v.button?.label, "Approving");
  assert.equal(v.button?.disabled, true);
  assert.equal(v.line?.text, "approving — waiting for a free planner…");
});

test("approvalView: approved drops the button and reads APPROVED until the lifecycle shows it", () => {
  const approved = approvalStatus("approved", NOW + 2_000, { checksPending: false });

  const v = view(approved, sentAt(NOW), NOW + 3_000);
  assert.equal(v.button, null);
  assert.equal(v.approved, true);
  assert.deepEqual(v.line, { text: "approved — an engine will squash-merge it", tone: "approved" });

  const pending = view(approvalStatus("approved", NOW + 2_000, { checksPending: true }), sentAt(NOW), NOW + 3_000);
  assert.equal(pending.line?.text, "approved — an engine will squash-merge it once its checks pass");

  const shown = view(approved, sentAt(NOW), NOW + 3_000, approveControl(parkedPair({ approval: "approved" }), null, false));
  assert.equal(shown.line, null, "once the lifecycle shows the approval, APPROVED says it all");
  assert.equal(shown.approved, true);
});

test("approvalView: a refusal shows its reason, and Approve can be pressed again", () => {
  const refused = approvalStatus("refused", NOW + 2_000, { reason: "its checks are failing" });
  const v = view(refused, sentAt(NOW), NOW + 3_000);

  assert.deepEqual(v.button, { step: "idle", label: "Approve", disabled: false, title: "Approve PR #10: yoke squash-merges it" });
  assert.deepEqual(v.line, { text: "not approved: its checks are failing", tone: "problem" });
  assert.equal(v.refreshAtMs, NOW + 2_000 + APPROVAL_OUTCOME_SHOW_MS);

  assert.equal(view(refused, sentAt(NOW), NOW + 2_000 + APPROVAL_OUTCOME_SHOW_MS).line, null, "for a minute");
  assert.equal(view(refused, sentAt(NOW + 4_000, "confirm"), NOW + 5_000).line, null, "or until the next press");
  assert.equal(view(refused, sentAt(NOW + 4_000, "confirm"), NOW + 5_000).button?.label, "Confirm");
});

test("approvalView: a failure shows its first line, and Approve can be pressed again", () => {
  const v = view(approvalStatus("failed", NOW + 2_000, { reason: "GitHub said 502" }), sentAt(NOW), NOW + 3_000);

  assert.equal(v.button?.label, "Approve");
  assert.equal(v.button?.disabled, false);
  assert.deepEqual(v.line, { text: "approval failed: GitHub said 502", tone: "problem" });
});

test("approvalView: no answer within APPROVE_ACK_MS says so, and a late answer still counts", () => {
  const v = view(null, sentAt(NOW), NOW + APPROVE_ACK_MS);
  assert.equal(v.button?.label, "Approve");
  assert.equal(v.button?.disabled, false);
  assert.deepEqual(v.line, { text: "no answer from yoke — check the connection and the event log", tone: "problem" });

  const late = view(approvalStatus("waiting", NOW + APPROVE_ACK_MS + 2_000), sentAt(NOW), NOW + APPROVE_ACK_MS + 3_000);
  assert.equal(late.button?.label, "Approving");
});

test("approvalView: a click that could not be sent says the dashboard is not connected", () => {
  const v = view(null, sentAt(NOW, "unsent"), NOW + 1_000);

  assert.equal(v.button?.label, "Approve");
  assert.equal(v.line?.text, "not sent — the dashboard is not connected to yoke");
  assert.equal(view(null, sentAt(NOW, "unsent"), NOW + APPROVAL_OUTCOME_SHOW_MS).line, null);
});

test("approvalView: the first click arms the button for APPROVE_CONFIRM_MS", () => {
  const armed = view(null, sentAt(NOW, "confirm"), NOW + 1_000);
  assert.equal(armed.button?.label, "Confirm");
  assert.equal(armed.line, null);
  assert.equal(armed.refreshAtMs, NOW + APPROVE_CONFIRM_MS);
  assert.equal(view(null, sentAt(NOW, "confirm"), NOW + APPROVE_CONFIRM_MS).button?.label, "Approve");
});

test("approvalView: another PR's status or click never shows on this one", () => {
  const other = { ...approvalStatus("refused", NOW, { reason: "it is not open" }), pullRequestNumber: 11 };
  const otherProject = { ...approvalStatus("waiting", NOW), repo: "o/b" };

  assert.equal(view(other, null, NOW + 1_000).line, null);
  assert.equal(view(otherProject, null, NOW + 1_000).line, null);
  assert.equal(view(null, { key: "o/a#11", step: "sent", atMs: NOW }, NOW + 1_000).button?.label, "Approve");
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

// ── the pill following yoke's answer ─────────────────────────────────────────

/** Arm and confirm the pill's Approve button, as a person would. */
function confirmApprove(pill: LifecyclePill, pair = parkedPair()): void {
  click(renderPill(pair, {}, pill).button);
  click(renderPill(pair, {}, pill).button);
}

test("lifecycle pill: after the confirming click it follows yoke's answer, not a timer", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const pill = new LifecyclePill();
  try {
    confirmApprove(pill);
    let rendered = renderPill(parkedPair(), {}, pill);
    assert.match(flatten(rendered.button), />Sending<\/button>/);
    assert.match(rendered.html, statusLine("approval sent to yoke…"));

    t.mock.timers.tick(2_000);
    rendered = renderPill(parkedPair(), { approvalStatus: approvalStatus("loading", Date.now()) }, pill);
    assert.match(flatten(rendered.button), />Approving<\/button>/);
    assert.match(flatten(rendered.button), /\?disabled=true/);
    assert.match(rendered.html, statusLine("approving — reading PR #10 from GitHub…"));

    t.mock.timers.tick(40_000);
    rendered = renderPill(parkedPair(), { approvalStatus: approvalStatus("waiting", Date.now() - 39_000) }, pill);
    assert.match(flatten(rendered.button), />Approving<\/button>/, "no 20 s fallback");
    assert.match(rendered.html, statusLine("approving — waiting for a free planner…"));

    rendered = renderPill(parkedPair(), {
      approvalStatus: approvalStatus("refused", Date.now(), { reason: "its checks are failing" }),
    }, pill);
    assert.match(flatten(rendered.button), />Approve<\/button>/);
    assert.match(flatten(rendered.button), /\?disabled=false/);
    assert.match(rendered.html, statusLine("not approved: its checks are failing"), "visible without hovering");
    assert.match(rendered.html, /title="PR · not approved: its checks are failing"/, "and in full in the tooltip");
  } finally {
    pill.disconnectedCallback();
  }
});

test("lifecycle pill: no answer within APPROVE_ACK_MS shows the no-answer line", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const pill = new LifecyclePill();
  pill.addEventListener("pill-approve", () => {});
  try {
    confirmApprove(pill);
    t.mock.timers.tick(APPROVE_ACK_MS);
    const { html, button } = renderPill(parkedPair(), {}, pill);
    assert.match(flatten(button), />Approve<\/button>/);
    assert.match(flatten(button), /\?disabled=false/);
    assert.match(html, statusLine("no answer from yoke — check the connection and the event log"));
  } finally {
    pill.disconnectedCallback();
  }
});

test("lifecycle pill: a recorded approval drops the button and reads APPROVED", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const pill = new LifecyclePill();
  try {
    confirmApprove(pill);
    t.mock.timers.tick(1_000);
    const { html, button } = renderPill(parkedPair(), {
      approvalStatus: approvalStatus("approved", Date.now(), { checksPending: false }),
    }, pill);
    assert.equal(button, undefined);
    assert.ok(!html.includes("has-approve"), "the row takes back the button's room");
    assert.match(html, /APPROVED/);
    assert.ok(!html.includes(">READY<"));
    assert.match(html, statusLine("approved — an engine will squash-merge it"));
  } finally {
    pill.disconnectedCallback();
  }
});

test("lifecycle pill: another dashboard's approval shows as Approving here", () => {
  const { html, button } = renderPill(parkedPair(), { approvalStatus: approvalStatus("waiting", Date.now()) });

  assert.match(flatten(button), />Approving<\/button>/);
  assert.match(html, statusLine("approving — waiting for a free planner…"));
});

test("lifecycle pill: a reused element never shows another PR's status", () => {
  const pill = new LifecyclePill();
  renderPill(parkedPair(), { approvalStatus: approvalStatus("waiting", Date.now()) }, pill);
  const other = parkedPair({ issue: { number: 2, title: "Other", state: "open" } }, { number: 11 });
  // Even should PR #10's status still be set on it.
  const { html, button } = renderPill(other, {}, pill);

  assert.match(flatten(button), />Approve<\/button>/);
  assert.ok(!html.includes("approving —"));
  pill.disconnectedCallback();
});

test("lifecycle pill: the approval line is a live region on the PR half's label, even when empty", () => {
  const { html } = renderPill(parkedPair());

  assert.match(html, /<div class="pill-label" title="">PR<span\s+class="pill-approval-line"\s+role="status"\s+aria-live="polite"\s*><\/span><\/div>/);
});

test("lifecycle pill: the approval line changes neither the pill's nor the PR half's width", () => {
  const css = LifecyclePill.styles.toString().replace(/\s+/g, " ");

  const label = /\.pill-pr-half \.pill-label \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(label, /overflow: hidden;/, "a long line is cut short…");
  assert.match(label, /text-overflow: ellipsis;/, "…with an ellipsis");
  assert.match(/\.pill-label \{([^}]*)\}/.exec(css)?.[1] ?? "", /white-space: nowrap;/, "on one line");
  const half = /\.pill-pr-half \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(half, /flex: 1;/);
  assert.match(half, /min-width: 0;/, "the half never grows to fit its text");
  assert.match(half, /overflow: hidden;/);
  assert.match(css, /\.lifecycle-pill\.has-status \.pill-pr-half \.pill-label \{ padding-right: 24px; \}/);
  assert.match(css, /\.lifecycle-pill\.has-approve \.pill-pr-half \.pill-label \{ padding-right: 64px; \}/);
  assert.match(css, /\.lifecycle-pill\.has-approve\.has-status \.pill-pr-half \.pill-label \{ padding-right: 88px; \}/);
  assert.ok(!/\.pill-approval-line \{[^}]*(width|padding|margin)/.test(css), "the line itself takes no room of its own");
});

test("lifecycle pill: every Approve button label fits the fixed 60 px button", () => {
  const css = LifecyclePill.styles.toString().replace(/\s+/g, " ");
  const rule = /\.pill-approve \{([^}]*)\}/.exec(css)?.[1] ?? "";
  const px = (property: string) => Number(new RegExp(`${property}: ([\\d.]+)px;`).exec(rule)?.[1]);

  assert.match(rule, /font-family: 'IBM Plex Mono', monospace;/, "a monospace face: every glyph is 0.6em wide");
  assert.match(rule, /padding: 0;/);
  const room = px("width") - 2 * Number(/border: ([\d.]+)px/.exec(rule)?.[1]);
  const perGlyph = 0.6 * px("font-size") + px("letter-spacing");
  for (const label of Object.values(APPROVE_BUTTON_LABELS)) {
    assert.ok(label.length * perGlyph <= room, `${label} (${(label.length * perGlyph).toFixed(1)} px) fits in ${room} px`);
  }
});
