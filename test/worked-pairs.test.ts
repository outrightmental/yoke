import test from "node:test";
import assert from "node:assert/strict";

import { withWorkedPairs, UNLISTED_STATE } from "../src/dashboard/shared/worked-pairs.js";
import { pillActivity } from "../src/dashboard/shared/pill-activity.js";
import type { CylinderState, LifecyclePair } from "../src/dashboard/store/types.js";

function makeCylinder(overrides: Partial<CylinderState> = {}): CylinderState {
  return {
    index: 1,
    color: null,
    colorRgb: null,
    status: "active",
    idleStatusText: "",
    actionType: "start-implementation",
    repo: "outrightmental/butterfly",
    issueNumber: 402,
    prNumber: null,
    issueTitle: "Never lapse an approval",
    prTitle: null,
    model: null,
    iterationNumber: 1,
    thinkingLines: [],
    actionStartedAt: 0,
    nextCycleAtMs: null,
    rateLimitedUntilMs: null,
    ...overrides,
  };
}

const issuePair = (number: number, repo = "outrightmental/butterfly"): LifecyclePair => ({
  issue: { number, title: `Issue ${number}`, state: "open" },
  pr: null,
  prPhase: "absent",
  repo,
});

test("withWorkedPairs: synthesizes a planning pill for an issue a cylinder works but the feed lacks", () => {
  const pairs = [issuePair(403)];
  const out = withWorkedPairs(pairs, [makeCylinder()]);
  assert.equal(out.length, 2);
  const added = out[1]!;
  assert.deepEqual(added.issue, { number: 402, title: "Never lapse an approval", state: UNLISTED_STATE });
  assert.equal(added.pr, null);
  assert.equal(added.prPhase, "planning");
  assert.equal(added.repo, "outrightmental/butterfly");
  assert.equal(pillActivity(added, [makeCylinder()]), "working", "it lights up like any worked pill");
  assert.deepEqual(pairs, [issuePair(403)], "input untouched");
});

test("withWorkedPairs: adds nothing when every worked issue/PR already has a pill", () => {
  const pairs = [issuePair(402), issuePair(403)];
  const out = withWorkedPairs(pairs, [makeCylinder()]);
  assert.deepEqual(out, pairs);
});

test("withWorkedPairs: a cylinder working a PR through its number is covered by the PR's pill", () => {
  const pairs: LifecyclePair[] = [{
    issue: { number: 406, title: "x", state: "open" },
    pr: { number: 409, title: "x", state: "open", draft: true },
    prPhase: "active",
    repo: "outrightmental/butterfly",
  }];
  const reviewing = makeCylinder({ actionType: "self-review", issueNumber: null, prNumber: 409, issueTitle: null, prTitle: "x" });
  assert.deepEqual(withWorkedPairs(pairs, [reviewing]), pairs);
});

test("withWorkedPairs: synthesizes an orphan PR pill when a worked PR has no pill", () => {
  const reviewing = makeCylinder({ actionType: "self-review", issueNumber: null, prNumber: 410, issueTitle: null, prTitle: "Closed by hand" });
  const out = withWorkedPairs([], [reviewing]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.issue, null);
  assert.deepEqual(out[0]!.pr, { number: 410, title: "Closed by hand", state: UNLISTED_STATE });
  assert.equal(out[0]!.prPhase, "active");
});

test("withWorkedPairs: a worked issue+PR with no pill gets both halves", () => {
  const fixing = makeCylinder({ actionType: "address-failing-checks", issueNumber: 402, prNumber: 404, prTitle: "PR title" });
  const out = withWorkedPairs([], [fixing]);
  assert.equal(out[0]!.issue?.number, 402);
  assert.equal(out[0]!.pr?.number, 404);
  assert.equal(out[0]!.prPhase, "active");
});

test("withWorkedPairs: ignores idle, done and errored cylinders and ones with no target", () => {
  const cylinders = [
    makeCylinder({ status: "idle" }),
    makeCylinder({ status: "done" }),
    makeCylinder({ status: "error" }),
    makeCylinder({ status: "shutdown" }),
    makeCylinder({ issueNumber: null, prNumber: null }),
  ];
  assert.deepEqual(withWorkedPairs([], cylinders), []);
});

test("withWorkedPairs: the same issue number in another project is not a match", () => {
  const pairs = [issuePair(402, "outrightmental/yoke")];
  const out = withWorkedPairs(pairs, [makeCylinder({ repo: "outrightmental/butterfly" })]);
  assert.equal(out.length, 2);
  assert.equal(out[1]!.repo, "outrightmental/butterfly");
});

test("withWorkedPairs: two cylinders on the same unlisted issue produce one pill", () => {
  const out = withWorkedPairs([], [makeCylinder({ index: 1 }), makeCylinder({ index: 2 })]);
  assert.equal(out.length, 1);
});

test("withWorkedPairs: a missing title renders as an empty string, never undefined", () => {
  const out = withWorkedPairs([], [makeCylinder({ issueTitle: null })]);
  assert.equal(out[0]!.issue?.title, "");
});
