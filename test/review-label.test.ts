import test from "node:test";
import assert from "node:assert/strict";

import { buildPlan, REVIEW_LABEL, reviewApprovalState } from "../src/orchestrator.js";
import { approvePullRequest, commentOnApproval, executeAction } from "../src/actions.js";
import type {
  ActionClaudeAgentClient,
  ActionGitHubClient,
  ActionSessionStore,
  ExecuteActionContext,
} from "../src/actions.js";
import type { AgentSession, Issue, OrchestratorAction, PullRequest, RepositorySnapshot } from "../src/types.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function createIssue(overrides: Partial<Issue> & Pick<Issue, "number">): Issue {
  return {
    number: overrides.number,
    title: overrides.title ?? `Issue ${overrides.number}`,
    body: overrides.body ?? "",
    state: overrides.state ?? "open",
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
    type: overrides.type ?? null,
    labels: overrides.labels ?? [],
  };
}

function createPullRequest(
  overrides: Partial<PullRequest> & Pick<PullRequest, "number" | "linkedIssueNumbers">,
): PullRequest {
  return {
    number: overrides.number,
    title: overrides.title ?? `PR ${overrides.number}`,
    body: overrides.body ?? "",
    headSha: overrides.headSha ?? `sha-${overrides.number}`,
    headRefName: overrides.headRefName ?? `branch-${overrides.number}`,
    baseRefName: overrides.baseRefName ?? "main",
    state: overrides.state ?? "open",
    draft: overrides.draft ?? false,
    hasMergeConflicts: overrides.hasMergeConflicts ?? false,
    hasCleanReviewOnHead: overrides.hasCleanReviewOnHead ?? false,
    unresolvedReviewCommentCount: overrides.unresolvedReviewCommentCount ?? 0,
    checksStatus: overrides.checksStatus ?? "success",
    pendingChecksStartedAt: overrides.pendingChecksStartedAt,
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
    labels: overrides.labels ?? [],
    linkedIssueNumbers: overrides.linkedIssueNumbers,
    closingIssueNumbers: overrides.closingIssueNumbers ?? overrides.linkedIssueNumbers,
    ...(overrides.hasNewCommentsSinceLastRead !== undefined
      ? { hasNewCommentsSinceLastRead: overrides.hasNewCommentsSinceLastRead }
      : {}),
  };
}

function createSession(
  overrides: Partial<AgentSession> & Pick<AgentSession, "id" | "issueNumber" | "phase">,
): AgentSession {
  const session: AgentSession = {
    id: overrides.id,
    issueNumber: overrides.issueNumber,
    phase: overrides.phase,
    status: overrides.status ?? "completed",
    createdAt: overrides.createdAt ?? "2024-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2024-01-01T00:00:00.000Z",
  };
  if (overrides.pullRequestNumber !== undefined) {
    session.pullRequestNumber = overrides.pullRequestNumber;
  }
  if (overrides.result !== undefined) {
    session.result = overrides.result;
  }
  return session;
}

/** A PR on issue 1 whose latest completed session is a clean self-review. */
function cleanSelfReviewSnapshot(overrides: {
  issueLabels?: string[];
  pullRequestLabels?: string[];
  issues?: Issue[];
}): RepositorySnapshot {
  return {
    issues: overrides.issues ?? [createIssue({ number: 1, labels: overrides.issueLabels ?? [] })],
    pullRequests: [
      createPullRequest({ number: 10, linkedIssueNumbers: [1], labels: overrides.pullRequestLabels ?? [] }),
    ],
    agentSessions: [
      createSession({
        id: "s1",
        issueNumber: 1,
        pullRequestNumber: 10,
        phase: "self-review",
        result: { madeChanges: false, pullRequestHeadSha: "sha-10" },
      }),
    ],
  };
}

// ─── planning: never merge, request review instead ───────────────────────────

test("buildPlan still picks up review-labelled issues for implementation", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 1, labels: [REVIEW_LABEL] })],
    pullRequests: [],
    agentSessions: [],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [{ type: "start-implementation", issueNumber: 1 }]);
});

test("buildPlan emits request-review (no reviewers) after one clean self-review on a review-labelled issue", () => {
  const plan = buildPlan(cleanSelfReviewSnapshot({ issueLabels: [REVIEW_LABEL] }), 3);

  assert.deepEqual(plan.actions, [
    { type: "request-review", issueNumber: 1, pullRequestNumber: 10, reviewers: [] },
  ]);
});

test("buildPlan without the review label runs a second self-review after one clean pass (unchanged)", () => {
  const plan = buildPlan(cleanSelfReviewSnapshot({}), 3);

  assert.deepEqual(plan.actions, [
    { type: "self-review", issueNumber: 1, pullRequestNumber: 10, pullRequestHeadSha: "sha-10" },
  ]);
});

test("buildPlan never squash-merges a review-gated PR, even after two clean self-reviews", () => {
  const snapshot = cleanSelfReviewSnapshot({ issueLabels: [REVIEW_LABEL] });
  snapshot.agentSessions.push(
    createSession({
      id: "s2",
      issueNumber: 1,
      pullRequestNumber: 10,
      phase: "self-review",
      updatedAt: "2024-01-02T00:00:00.000Z",
      result: { madeChanges: false, pullRequestHeadSha: "sha-10" },
    }),
  );

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    { type: "request-review", issueNumber: 1, pullRequestNumber: 10, reviewers: [] },
  ]);
});

test("buildPlan honors the review label on the PR itself, even when the issue is gone", () => {
  const snapshot = cleanSelfReviewSnapshot({ pullRequestLabels: [REVIEW_LABEL], issues: [] });

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    { type: "request-review", issueNumber: 1, pullRequestNumber: 10, reviewers: [] },
  ]);
});

// ─── parking: the final PR is left for the human ─────────────────────────────

test("buildPlan parks a review-gated PR after request-review and frees its cylinder", () => {
  const snapshot: RepositorySnapshot = {
    issues: [
      createIssue({ number: 1, labels: [REVIEW_LABEL] }),
      createIssue({ number: 2, createdAt: "2024-01-02T00:00:00.000Z" }),
    ],
    pullRequests: [createPullRequest({ number: 10, linkedIssueNumbers: [1], labels: [REVIEW_LABEL] })],
    agentSessions: [
      createSession({
        id: "s1",
        issueNumber: 1,
        pullRequestNumber: 10,
        phase: "request-review",
        updatedAt: "2024-01-02T00:00:00.000Z",
      }),
    ],
  };

  // With a single cylinder, the parked PR must not starve issue 2.
  const plan = buildPlan(snapshot, 1);

  assert.deepEqual(plan.actions, [{ type: "start-implementation", issueNumber: 2 }]);
});

test("buildPlan re-queues a review-gated PR converted back to draft", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 1, labels: [REVIEW_LABEL] })],
    pullRequests: [
      createPullRequest({ number: 10, linkedIssueNumbers: [1], labels: [REVIEW_LABEL], draft: true }),
    ],
    agentSessions: [
      createSession({
        id: "s1",
        issueNumber: 1,
        pullRequestNumber: 10,
        phase: "request-review",
        updatedAt: "2024-01-02T00:00:00.000Z",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    { type: "self-review", issueNumber: 1, pullRequestNumber: 10, pullRequestHeadSha: "sha-10" },
  ]);
});

test("buildPlan re-queues a review-gated PR with new human comments", () => {
  const snapshot: RepositorySnapshot = {
    issues: [createIssue({ number: 1, labels: [REVIEW_LABEL] })],
    pullRequests: [
      createPullRequest({
        number: 10,
        linkedIssueNumbers: [1],
        labels: [REVIEW_LABEL],
        hasNewCommentsSinceLastRead: true,
      }),
    ],
    agentSessions: [
      createSession({
        id: "s1",
        issueNumber: 1,
        pullRequestNumber: 10,
        phase: "request-review",
        updatedAt: "2024-01-02T00:00:00.000Z",
      }),
    ],
  };

  const plan = buildPlan(snapshot, 3);

  assert.deepEqual(plan.actions, [
    { type: "self-review", issueNumber: 1, pullRequestNumber: 10, pullRequestHeadSha: "sha-10" },
  ]);
});

// ─── actions: label propagation and review request without reviewers ─────────

test("executeAction start-implementation copies the review label onto the new PR", async () => {
  const labeled: Array<{ pullRequestNumber: number; labels: string[] }> = [];

  const gitHubClient = {
    getDefaultBranch: async () => "main",
    createPullRequest: async () => ({ number: 10, headSha: "sha", created: true }),
    updatePullRequestBody: async () => {},
    squashMergePullRequest: async () => {},
    listFailingCheckRuns: async () => [],
    cancelStalledWorkflowRunsForPullRequest: async () => 0,
    postComment: async () => 9000,
    listPullRequestComments: async () => [],
    addEyesReaction: async () => {},
    addLabelsToPullRequest: async (pullRequestNumber: number, labels: string[]) => {
      labeled.push({ pullRequestNumber, labels });
    },
  } satisfies ActionGitHubClient;

  const sessions: Array<{ phase: string }> = [];
  const sessionStore: ActionSessionStore = {
    createSession: async (input) => {
      sessions.push({ phase: input.phase });
    },
  };

  const claudeAgentClient = {
    implementIssue: async () => ({
      branch: "my-branch",
      pullRequestTitle: "My PR",
      pullRequestBody: "body",
      headSha: "sha",
    }),
  } as unknown as ActionClaudeAgentClient;

  const context: ExecuteActionContext = {
    owner: "owner",
    repo: "repo",
    issues: [createIssue({ number: 1, labels: [REVIEW_LABEL] })],
    pullRequests: [],
  };

  const action: OrchestratorAction = { type: "start-implementation", issueNumber: 1 };
  await executeAction(gitHubClient, sessionStore, claudeAgentClient, action, false, context);

  assert.deepEqual(labeled, [{ pullRequestNumber: 10, labels: [REVIEW_LABEL] }]);
  assert.ok(sessions.some((s) => s.phase === "implementation"));
});

test("executeAction start-implementation leaves unlabelled issues alone", async () => {
  const labeled: string[] = [];

  const gitHubClient = {
    getDefaultBranch: async () => "main",
    createPullRequest: async () => ({ number: 10, headSha: "sha", created: true }),
    updatePullRequestBody: async () => {},
    squashMergePullRequest: async () => {},
    listFailingCheckRuns: async () => [],
    cancelStalledWorkflowRunsForPullRequest: async () => 0,
    postComment: async () => 9000,
    listPullRequestComments: async () => [],
    addEyesReaction: async () => {},
    addLabelsToPullRequest: async () => {
      labeled.push("called");
    },
  } satisfies ActionGitHubClient;

  const sessionStore: ActionSessionStore = { createSession: async () => {} };
  const claudeAgentClient = {
    implementIssue: async () => ({
      branch: "my-branch",
      pullRequestTitle: "My PR",
      pullRequestBody: "body",
      headSha: "sha",
    }),
  } as unknown as ActionClaudeAgentClient;

  const context: ExecuteActionContext = {
    owner: "owner",
    repo: "repo",
    issues: [createIssue({ number: 1 })],
    pullRequests: [],
  };

  await executeAction(
    gitHubClient,
    sessionStore,
    claudeAgentClient,
    { type: "start-implementation", issueNumber: 1 },
    false,
    context,
  );

  assert.deepEqual(labeled, []);
});

test("executeAction request-review with no reviewers marks ready without requesting or moving status", async () => {
  const calls: string[] = [];
  const sessions: Array<{ phase: string; pullRequestNumber?: number }> = [];

  const gitHubClient = {
    getDefaultBranch: async () => "main",
    createPullRequest: async () => ({ number: 10, headSha: "sha", created: true }),
    updatePullRequestBody: async () => {},
    squashMergePullRequest: async () => {},
    listFailingCheckRuns: async () => [],
    cancelStalledWorkflowRunsForPullRequest: async () => 0,
    postComment: async (prNumber: number, body: string) => {
      calls.push(`postComment:${prNumber}:${body}`);
      return 9000;
    },
    listPullRequestComments: async () => [],
    addEyesReaction: async () => {},
    markPullRequestReadyForReview: async (prNumber: number) => {
      calls.push(`markReady:${prNumber}`);
    },
    requestPullRequestReview: async (prNumber: number, reviewers: string[]) => {
      calls.push(`requestReview:${prNumber}:${reviewers.join(",")}`);
    },
    moveIssueToProjectStatus: async (_p: number, issueNumber: number, status: string) => {
      calls.push(`moveStatus:${issueNumber}:${status}`);
    },
  } satisfies ActionGitHubClient;

  const sessionStore: ActionSessionStore = {
    createSession: async (input) => {
      const entry: { phase: string; pullRequestNumber?: number } = { phase: input.phase };
      if (input.pullRequestNumber !== undefined) entry.pullRequestNumber = input.pullRequestNumber;
      sessions.push(entry);
    },
    setLastReadCommentAt: async () => {},
  };

  const claudeAgentClient = {} as ActionClaudeAgentClient;

  const context: ExecuteActionContext = {
    owner: "owner",
    repo: "repo",
    issues: [createIssue({ number: 1, labels: [REVIEW_LABEL] })],
    pullRequests: [
      createPullRequest({ number: 10, linkedIssueNumbers: [1], labels: [REVIEW_LABEL], draft: true }),
    ],
  };

  await executeAction(
    gitHubClient,
    sessionStore,
    claudeAgentClient,
    { type: "request-review", issueNumber: 1, pullRequestNumber: 10, reviewers: [] },
    false,
    context,
  );

  assert.ok(calls.includes("markReady:10"), "expected the PR to be marked ready for review");
  assert.ok(
    !calls.some((c) => c.startsWith("requestReview:")),
    "expected no reviewer request when reviewers is empty",
  );
  assert.ok(
    !calls.some((c) => c.startsWith("moveStatus:")),
    "expected no project-board move outside project mode",
  );
  assert.ok(
    sessions.some((s) => s.phase === "request-review" && s.pullRequestNumber === 10),
    "expected a request-review session to be recorded",
  );
});

// ─── approval on the dashboard: carry on with the squash-merge (#274) ────────

/**
 * PR #10 on review-labelled issue #1, parked after `request-review` — or, with
 * `approved`, approved on the dashboard since.
 */
function parkedSnapshot(overrides: {
  pullRequest?: Partial<PullRequest>;
  issueLabels?: string[];
  approved?: boolean;
  sessions?: AgentSession[];
} = {}): RepositorySnapshot {
  const agentSessions = [
    createSession({
      id: "s1",
      issueNumber: 1,
      pullRequestNumber: 10,
      phase: "request-review",
      updatedAt: "2024-01-02T00:00:00.000Z",
    }),
    ...(overrides.approved
      ? [
          createSession({
            id: "s2",
            issueNumber: 1,
            pullRequestNumber: 10,
            phase: "approval",
            updatedAt: "2024-01-03T00:00:00.000Z",
          }),
        ]
      : []),
    ...(overrides.sessions ?? []),
  ];
  return {
    issues: [createIssue({ number: 1, labels: overrides.issueLabels ?? [REVIEW_LABEL] })],
    pullRequests: [
      createPullRequest({
        number: 10,
        linkedIssueNumbers: [1],
        labels: [REVIEW_LABEL],
        title: "Add the thing",
        body: "Closes #1",
        ...overrides.pullRequest,
      }),
    ],
    agentSessions,
  };
}

const SQUASH_MERGE_10 = {
  type: "squash-merge",
  issueNumber: 1,
  pullRequestNumber: 10,
  pullRequestTitle: "Add the thing",
  pullRequestHeadRefName: "branch-10",
  closingIssueNumbers: [1],
  pullRequestBody: "Closes #1",
};

test("buildPlan squash-merges a review-gated PR once it is approved", () => {
  const plan = buildPlan(parkedSnapshot({ approved: true }), 3);

  assert.deepEqual(plan.actions, [SQUASH_MERGE_10]);
});

test("buildPlan merges an approved PR even if its review label is removed since", () => {
  const snapshot = parkedSnapshot({ approved: true, issueLabels: [], pullRequest: { labels: [] } });

  assert.deepEqual(buildPlan(snapshot, 3).actions, [SQUASH_MERGE_10]);
});

test("buildPlan holds an approved PR's merge while its checks run, without spending a cylinder", () => {
  const snapshot = parkedSnapshot({ approved: true, pullRequest: { checksStatus: "pending" } });
  snapshot.issues.push(createIssue({ number: 2, createdAt: "2024-01-02T00:00:00.000Z" }));

  const plan = buildPlan(snapshot, 1);

  assert.deepEqual(plan.actions, [{ type: "start-implementation", issueNumber: 2 }]);
});

test("buildPlan never merges an approved PR over failing checks: it fixes them first", () => {
  const plan = buildPlan(parkedSnapshot({ approved: true, pullRequest: { checksStatus: "failure" } }), 3);

  assert.deepEqual(plan.actions, [
    { type: "address-failing-checks", issueNumber: 1, pullRequestNumber: 10, pullRequestHeadSha: "sha-10" },
  ]);
});

test("buildPlan resolves an approved PR's merge conflicts before anything else", () => {
  const plan = buildPlan(parkedSnapshot({ approved: true, pullRequest: { hasMergeConflicts: true } }), 3);

  assert.deepEqual(plan.actions, [
    { type: "resolve-conflicts", issueNumber: 1, pullRequestNumber: 10, pullRequestHeadSha: "sha-10" },
  ]);
});

test("buildPlan re-reviews an approved PR converted back to draft or commented on, instead of merging", () => {
  for (const pullRequest of [{ draft: true }, { hasNewCommentsSinceLastRead: true }]) {
    const plan = buildPlan(parkedSnapshot({ approved: true, pullRequest }), 3);

    assert.deepEqual(
      plan.actions,
      [{ type: "self-review", issueNumber: 1, pullRequestNumber: 10, pullRequestHeadSha: "sha-10" }],
      JSON.stringify(pullRequest),
    );
  }
});

test("buildPlan treats work done after an approval as new: the PR comes back for approval", () => {
  // Approved, then yoke fixed its failing checks and re-reviewed it clean.
  const snapshot = parkedSnapshot({
    approved: true,
    sessions: [
      createSession({
        id: "s3",
        issueNumber: 1,
        pullRequestNumber: 10,
        phase: "address-failing-checks",
        updatedAt: "2024-01-04T00:00:00.000Z",
      }),
      createSession({
        id: "s4",
        issueNumber: 1,
        pullRequestNumber: 10,
        phase: "self-review",
        updatedAt: "2024-01-05T00:00:00.000Z",
        result: { madeChanges: false, pullRequestHeadSha: "sha-10" },
      }),
    ],
  });

  assert.deepEqual(buildPlan(snapshot, 3).actions, [
    { type: "request-review", issueNumber: 1, pullRequestNumber: 10, reviewers: [] },
  ]);
});

test("reviewApprovalState: a review-gated PR parked after request-review awaits approval", () => {
  for (const snapshot of [
    parkedSnapshot(),
    parkedSnapshot({ issueLabels: [] }),
    parkedSnapshot({ pullRequest: { labels: [] } }),
    parkedSnapshot({ pullRequest: { checksStatus: "pending" } }),
    parkedSnapshot({ pullRequest: { checksStatus: "failure" } }),
  ]) {
    assert.equal(reviewApprovalState(snapshot.pullRequests[0]!, snapshot), "awaiting-approval");
  }
});

test("reviewApprovalState: an approved PR reads approved until its merge", () => {
  const snapshot = parkedSnapshot({ approved: true });

  assert.equal(reviewApprovalState(snapshot.pullRequests[0]!, snapshot), "approved");
});

test("reviewApprovalState: nothing is awaited from a PR yoke would act on, or that no label holds back", () => {
  const cases: Array<[string, RepositorySnapshot, boolean?]> = [
    ["no review label anywhere", parkedSnapshot({ issueLabels: [], pullRequest: { labels: [] } })],
    ["converted back to draft", parkedSnapshot({ pullRequest: { draft: true } })],
    ["new comments since the review request", parkedSnapshot({ pullRequest: { hasNewCommentsSinceLastRead: true } })],
    ["merge conflicts to resolve", parkedSnapshot({ pullRequest: { hasMergeConflicts: true } })],
    ["labelled manual", parkedSnapshot({ pullRequest: { labels: [REVIEW_LABEL, "manual"] } })],
    ["closed", parkedSnapshot({ pullRequest: { state: "closed" } })],
    ["project mode, where every PR waits on GitHub", parkedSnapshot(), true],
    ["still being self-reviewed", cleanSelfReviewSnapshot({ issueLabels: [REVIEW_LABEL] })],
    [
      "an engine on it",
      parkedSnapshot({
        sessions: [
          createSession({
            id: "s9",
            issueNumber: 1,
            pullRequestNumber: 10,
            phase: "implementation",
            status: "in_progress",
            updatedAt: "2024-01-09T00:00:00.000Z",
          }),
        ],
      }),
    ],
  ];
  for (const [description, snapshot, projectMode] of cases) {
    assert.equal(reviewApprovalState(snapshot.pullRequests[0]!, snapshot, projectMode), undefined, description);
  }
});

// ─── approvePullRequest: recording the approval ───────────────────────────────

function approvalFakes() {
  const sessions: AgentSession[] = [];
  const comments: Array<{ pullRequestNumber: number; body: string }> = [];
  const recordedCommentIds: number[] = [];
  const gitHubClient = {
    postComment: async (pullRequestNumber: number, body: string) => {
      comments.push({ pullRequestNumber, body });
      return 9001;
    },
  };
  const sessionStore: ActionSessionStore = {
    createSession: async (input) => {
      sessions.push(
        createSession({
          id: `approval-${sessions.length}`,
          issueNumber: input.issueNumber,
          phase: input.phase,
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.pullRequestNumber !== undefined ? { pullRequestNumber: input.pullRequestNumber } : {}),
          updatedAt: "2024-01-03T00:00:00.000Z",
        }),
      );
    },
    recordPostedCommentId: async (_pullRequestNumber, commentId) => {
      recordedCommentIds.push(commentId);
    },
  };
  return { gitHubClient, sessionStore, sessions, comments, recordedCommentIds };
}

test("approvePullRequest records the approval, and the planner then merges", async () => {
  const fakes = approvalFakes();
  const snapshot = parkedSnapshot();

  const result = await approvePullRequest(fakes.sessionStore, snapshot, 10);

  assert.deepEqual(result, { approved: true, checksPending: false });
  assert.equal(fakes.sessions.length, 1);
  assert.equal(fakes.sessions[0]!.phase, "approval");
  assert.equal(fakes.sessions[0]!.status, "completed");
  assert.equal(fakes.sessions[0]!.pullRequestNumber, 10);
  assert.equal(fakes.sessions[0]!.issueNumber, 1);

  snapshot.agentSessions.push(...fakes.sessions);
  assert.deepEqual(buildPlan(snapshot, 3).actions, [SQUASH_MERGE_10]);
});

test("approvePullRequest approves while checks run, for a merge once they pass", async () => {
  const fakes = approvalFakes();

  const result = await approvePullRequest(
    fakes.sessionStore,
    parkedSnapshot({ pullRequest: { checksStatus: "pending" } }),
    10,
  );

  assert.deepEqual(result, { approved: true, checksPending: true });
  assert.equal(fakes.sessions[0]?.phase, "approval");
});

test("approvePullRequest turns down a PR that is not parked awaiting approval, recording nothing", async () => {
  const cases: Array<[string, RepositorySnapshot, number, string, { projectModeEnabled?: boolean; dryRun?: boolean }?]> = [
    ["failing checks", parkedSnapshot({ pullRequest: { checksStatus: "failure" } }), 10, "its checks are failing"],
    ["no such PR", parkedSnapshot(), 11, "it is not open"],
    ["closed", parkedSnapshot({ pullRequest: { state: "closed" } }), 10, "it is not open"],
    ["already approved", parkedSnapshot({ approved: true }), 10, "it is already approved"],
    ["not review-gated", parkedSnapshot({ issueLabels: [], pullRequest: { labels: [] } }), 10, "it is not waiting on approval"],
    ["still in self-review", cleanSelfReviewSnapshot({ issueLabels: [REVIEW_LABEL] }), 10, "it is not waiting on approval"],
    ["project mode", parkedSnapshot(), 10, "it is not waiting on approval", { projectModeEnabled: true }],
    ["dry run", parkedSnapshot(), 10, "--dry-run records nothing", { dryRun: true }],
  ];
  for (const [description, snapshot, pullRequestNumber, reason, options] of cases) {
    const fakes = approvalFakes();
    const result = await approvePullRequest(fakes.sessionStore, snapshot, pullRequestNumber, options);
    assert.deepEqual(result, { approved: false, reason }, description);
    assert.deepEqual(fakes.sessions, [], `${description}: no approval recorded`);
  }
});

test("commentOnApproval says so on the PR, and yoke never reads its own comment back as feedback", async () => {
  const fakes = approvalFakes();

  await commentOnApproval(fakes.gitHubClient, fakes.sessionStore, 10, false);
  await commentOnApproval(fakes.gitHubClient, fakes.sessionStore, 11, true);

  assert.deepEqual(fakes.comments, [
    { pullRequestNumber: 10, body: "Approved on the yoke dashboard. Yoke is squash-merging this PR." },
    {
      pullRequestNumber: 11,
      body: "Approved on the yoke dashboard. Yoke will squash-merge this PR once its checks pass.",
    },
  ]);
  assert.deepEqual(fakes.recordedCommentIds, [9001, 9001]);
});
