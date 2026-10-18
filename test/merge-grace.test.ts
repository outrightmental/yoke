import test from "node:test";
import assert from "node:assert/strict";

import { MergedIssueGrace, MERGED_ISSUE_GRACE_MS } from "../src/merge-grace.js";
import type { Issue, RepositorySnapshot } from "../src/types.js";

function makeIssue(number: number): Issue {
  return {
    number,
    title: `Issue ${number}`,
    body: "",
    state: "open",
    labels: [],
    projectStatus: undefined,
    blockedBy: [],
  } as unknown as Issue;
}

function makeSnapshot(issueNumbers: number[]): RepositorySnapshot {
  return { issues: issueNumbers.map(makeIssue), pullRequests: [], agentSessions: [] };
}

test("MergedIssueGrace: hides a merged issue GitHub still reports open", () => {
  const grace = new MergedIssueGrace();
  grace.add([402], 1_000);
  const { snapshot, dropped } = grace.apply(makeSnapshot([402, 403]), 2_000);
  assert.deepEqual(dropped, [402]);
  assert.deepEqual(snapshot.issues.map((i) => i.number), [403]);
  assert.deepEqual(grace.pending(2_000), [402], "still waiting for GitHub to close it");
});

test("MergedIssueGrace: leaves a snapshot untouched when nothing is in grace", () => {
  const grace = new MergedIssueGrace();
  const input = makeSnapshot([1, 2]);
  const { snapshot, dropped } = grace.apply(input, 5);
  assert.equal(snapshot, input, "the same object comes back when nothing changed");
  assert.deepEqual(dropped, []);
});

test("MergedIssueGrace: forgets an issue once GitHub has closed it", () => {
  const grace = new MergedIssueGrace();
  grace.add([402], 1_000);
  // GitHub caught up: 402 is no longer in the open list.
  const { snapshot, dropped } = grace.apply(makeSnapshot([403]), 3_000);
  assert.deepEqual(dropped, []);
  assert.deepEqual(snapshot.issues.map((i) => i.number), [403]);
  assert.deepEqual(grace.pending(3_000), [], "forgotten");

  // Even if it is reopened later, it is planned like any other issue.
  const reopened = grace.apply(makeSnapshot([402, 403]), 4_000);
  assert.deepEqual(reopened.dropped, []);
  assert.deepEqual(reopened.snapshot.issues.map((i) => i.number), [402, 403]);
});

test("MergedIssueGrace: lets a merge that never closed its issue lapse after the window", () => {
  const grace = new MergedIssueGrace();
  grace.add([402], 1_000);
  const during = grace.apply(makeSnapshot([402]), 1_000 + MERGED_ISSUE_GRACE_MS - 1);
  assert.deepEqual(during.dropped, [402]);
  const after = grace.apply(makeSnapshot([402]), 1_000 + MERGED_ISSUE_GRACE_MS);
  assert.deepEqual(after.dropped, []);
  assert.deepEqual(after.snapshot.issues.map((i) => i.number), [402]);
  assert.deepEqual(grace.pending(1_000 + MERGED_ISSUE_GRACE_MS), []);
});

test("MergedIssueGrace: a custom window and several issues per merge", () => {
  const grace = new MergedIssueGrace(100);
  grace.add([7, 9], 0);
  assert.deepEqual(grace.pending(50), [7, 9]);
  const { snapshot, dropped } = grace.apply(makeSnapshot([7, 8, 9]), 50);
  assert.deepEqual(dropped, [7, 9]);
  assert.deepEqual(snapshot.issues.map((i) => i.number), [8]);
  assert.deepEqual(grace.pending(100), []);
});
