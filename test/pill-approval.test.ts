import test from "node:test";
import assert from "node:assert/strict";

import { approveControl, approveRequestMessage } from "../src/dashboard/shared/pill-approval.js";
import { pillActivity } from "../src/dashboard/shared/pill-activity.js";
import { LifecyclePill } from "../src/dashboard/components/lifecycle-pill.js";
import type { LifecyclePair } from "../src/dashboard/store/types.js";

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

test("lifecycle pill: a confirmed click that could not be sent goes back to Approve", () => {
  const { pill, button } = renderPill(parkedPair());
  // What yoke-app does when there is no live connection to send it on.
  pill.addEventListener("pill-approve", (event) => event.preventDefault());

  try {
    click(button);
    click(renderPill(parkedPair(), {}, pill).button);
    const after = renderPill(parkedPair(), {}, pill).button;
    assert.match(flatten(after), />Approve<\/button>/, "not left reading Sending");
    assert.match(flatten(after), /\?disabled=false/, "and can be pressed again");
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
