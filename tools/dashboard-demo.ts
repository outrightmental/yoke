/**
 * A stand-in engine pool for working on the Dashboard.
 *
 * Starts the real Dashboard server and feeds it the events a real run emits,
 * from a small simulation of the loop: engines plan, implement, review, fix
 * checks and squash-merge a made-up backlog across four made-up projects, and
 * an Approve press on the page is answered the way yoke answers one. Nothing
 * touches GitHub or Claude, so the page can be worked on — and screenshotted —
 * without a token, a backlog, or an hour of waiting for something to happen.
 *
 *   npm run demo:dashboard                      # http://localhost:3000
 *   npm run demo:dashboard -- --port=4000 --speed=4
 *   npm run demo:dashboard -- --scene=hold      # busy | quiet | hold | single | crowded | review
 *   npm run demo:dashboard -- --shutdown-after=20   # a graceful shutdown, 20 s in
 *   npm run demo:dashboard -- --fail=0.5        # how often a run fails outright
 *
 * Run from the repository root (the server serves the bundle from ./dist).
 */
import { DashboardServer } from "../src/dashboard-server.js";
import { EventEmitter } from "../src/event-emitter.js";

type Checks = "success" | "failure" | "pending" | "none";
type Scene = "busy" | "quiet" | "hold" | "single" | "crowded" | "review";

interface DemoIssue {
  number: number;
  title: string;
  /** Carries the `review` label: its PR waits for an Approve. */
  review: boolean;
  blockedBy: number[];
  /** Its blockers never close: it stays blocked for the whole run. */
  stuck: boolean;
  /** Its status on the project board, when it is out of the queue ("Backlog"). */
  projectStatus: string | null;
  closed: boolean;
}

interface DemoPullRequest {
  number: number;
  title: string;
  /** The issue it closes, or null for a PR that closes none. */
  issue: number | null;
  draft: boolean;
  checks: Checks;
  /** When its running checks finish, and how. */
  checksDoneAtMs: number | null;
  checksWillFail: boolean;
  manual: boolean;
  cleanReviews: number;
  approval: "awaiting-approval" | "approved" | null;
  /** Parked for a person to review on GitHub (Project SDLC). */
  awaitingReview: boolean;
  merged: boolean;
  /** When a merged PR drops off the lifecycle. */
  goneAtMs: number | null;
}

interface DemoProject {
  repo: string;
  issues: DemoIssue[];
  pullRequests: DemoPullRequest[];
  /** Issues an engine has claimed for implementation. */
  planning: Set<number>;
}

interface DemoAction {
  type: "start-implementation" | "self-review" | "address-failing-checks" | "resolve-conflicts" | "squash-merge";
  project: DemoProject;
  issue: DemoIssue | null;
  pullRequest: DemoPullRequest | null;
  model: string;
  doneAtMs: number;
}

interface DemoEngine {
  index: number;
  iteration: number;
  action: DemoAction | null;
  /** When it next plans. */
  wakeAtMs: number;
}

// ── Arguments ────────────────────────────────────────────────────────────────

function argument(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const PORT = Number(argument("port", "3000"));
const SPEED = Math.max(0.1, Number(argument("speed", "1")));
const SCENE = argument("scene", "busy") as Scene;
const ENGINES = Number(argument("engines", SCENE === "single" ? "3" : "6"));
const SEED = Number(argument("seed", "7"));
const FAIL = Math.max(0, Math.min(1, Number(argument("fail", "0.07"))));
const SHUTDOWN_AFTER = Number(argument("shutdown-after", "0"));

/** Seeded, so two runs of a scene look the same (mulberry32). */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = seededRandom(SEED);
const between = (low: number, high: number): number => low + random() * (high - low);
/** A span of simulated work, in real milliseconds at the chosen speed. */
const span = (lowSeconds: number, highSeconds: number): number => (between(lowSeconds, highSeconds) * 1000) / SPEED;

// ── The made-up backlog ──────────────────────────────────────────────────────

const INITIAL_MODEL = "claude-sonnet-5-5";
const REVIEW_MODEL = "claude-opus-5-5";
const DESCRIBE_MODEL = "claude-haiku-5-5";

function issue(
  number: number,
  title: string,
  options: Partial<Pick<DemoIssue, "review" | "blockedBy" | "projectStatus">> = {},
): DemoIssue {
  return {
    number, title,
    review: options.review ?? false,
    blockedBy: options.blockedBy ?? [],
    stuck: false,
    projectStatus: options.projectStatus ?? null,
    closed: false,
  };
}

function pullRequest(
  number: number,
  issueNumber: number | null,
  title: string,
  options: Partial<Pick<DemoPullRequest, "draft" | "checks" | "manual" | "cleanReviews" | "approval">> = {},
): DemoPullRequest {
  return {
    number,
    title,
    issue: issueNumber,
    draft: options.draft ?? true,
    checks: options.checks ?? "success",
    checksDoneAtMs: null,
    checksWillFail: false,
    manual: options.manual ?? false,
    cleanReviews: options.cleanReviews ?? 0,
    approval: options.approval ?? null,
    awaitingReview: false,
    merged: false,
    goneAtMs: null,
  };
}

function buildProjects(scene: Scene): DemoProject[] {
  const ledger: DemoProject = {
    repo: "northwind/ledger",
    planning: new Set(),
    issues: [
      issue(36, "Implement supplier tax onboarding, bills, expense coding and 1099 export"),
      issue(37, "Connect referral fees to invoicing, receivables and the payout run"),
      issue(40, "Record working time, contributor agreements and approval periods"),
      issue(114, "Build the end-to-end workflow for a license-holder renewal", { review: true }),
      issue(121, "Reconcile bank feeds nightly and flag unmatched lines", { blockedBy: [36] }),
      issue(123, "Export the general ledger as a signed, dated archive", { blockedBy: [36, 37] }),
      issue(127, "Round currency conversions the way the invoice says they were rounded"),
    ],
    pullRequests: [
      pullRequest(116, 114, "Build the end-to-end workflow for a license-holder renewal", { draft: false, cleanReviews: 1, approval: "awaiting-approval" }),
      pullRequest(118, 37, "Connect referral fees to invoicing, receivables and the payout run", { checks: "failure" }),
      pullRequest(119, 36, "Implement supplier tax onboarding, bills, expense coding and 1099 export", { checks: "pending" }),
    ],
  };
  const press: DemoProject = {
    repo: "northwind/press",
    planning: new Set(),
    issues: [
      issue(619, "Drop tile artwork from the “Also on the wire” rail", { review: true }),
      issue(620, "Replace “supermodel” with “Top Model” wherever a person is named", { review: true }),
      issue(624, "Set pull quotes in type so the rails carry no artwork"),
      issue(626, "Caption every photograph with its credit and its date", { blockedBy: [624] }),
    ],
    pullRequests: [
      pullRequest(621, 620, "Refer to a named person as a Top Model, never a supermodel", { draft: false, cleanReviews: 1, approval: "awaiting-approval" }),
      pullRequest(622, 619, "Set the quotes area in type so its rails carry no artwork", { draft: false, checks: "pending", cleanReviews: 1, approval: "awaiting-approval" }),
    ],
  };
  const courier: DemoProject = {
    repo: "northwind/courier",
    planning: new Set(),
    issues: [
      issue(12, "Strip the signature from reply bodies and keep replies in scope", { review: true }),
      issue(21, "Retry a bounced delivery once, then hold it for a person"),
      issue(22, "Thread replies by Message-ID before falling back to the subject"),
      issue(25, "Quarantine attachments over the size limit instead of dropping them", { blockedBy: [21] }),
    ],
    pullRequests: [
      pullRequest(13, 12, "Strip the signature from reply bodies and keep replies in scope", { draft: false, checks: "failure", cleanReviews: 1, approval: "awaiting-approval" }),
      pullRequest(18, null, "Read the account’s issuer from the token, never import it", { draft: false, manual: true }),
    ],
  };
  const atlas: DemoProject = {
    repo: "northwind/atlas",
    planning: new Set(),
    issues: [
      issue(66, "Move the state interface into a centre-screen modal inside the nav lightbox"),
      issue(70, "Share one lightbox component between the nav and the persona sheet"),
      issue(72, "Draw constellation rays beneath every nav option chip"),
      issue(74, "Fire the stage’s hold knob when its bar fills, without waiting a beat"),
      issue(78, "Let a pinch zoom the map without losing the selected marker"),
      issue(81, "Cache tiles by content hash so a redeploy doesn’t refetch them", { blockedBy: [78] }),
      issue(83, "Label rivers along their course rather than at their source"),
      issue(84, "Snap the compass to north on a double tap"),
    ],
    pullRequests: [
      pullRequest(69, 66, "Move the state interface into a centre-screen modal inside the nav lightbox", { cleanReviews: 1 }),
      pullRequest(73, 72, "Draw constellation rays beneath every nav option chip", { checks: "pending" }),
      pullRequest(75, 74, "Fire the stage’s hold knob when its bar fills, without waiting a beat", { cleanReviews: 1 }),
      pullRequest(76, 70, "Share one lightbox component between the nav and the persona sheet", { checks: "pending" }),
    ],
  };

  if (scene === "single") {
    return [{ ...atlas, repo: "northwind/atlas" }];
  }
  if (scene === "quiet") {
    // Everything is parked on a person or a blocker: nothing for an engine to do.
    for (const project of [ledger, press, courier, atlas]) {
      project.issues = project.issues.filter((i) => i.review || i.blockedBy.length > 0);
      const kept = new Set(project.issues.map((i) => i.number));
      project.pullRequests = project.pullRequests.filter((pr) => pr.manual || (pr.issue !== null && kept.has(pr.issue) && pr.approval !== null));
      for (const pr of project.pullRequests) if (pr.checks === "failure") pr.checks = "success";
      for (const candidate of project.issues) candidate.stuck = candidate.blockedBy.length > 0;
    }
  }
  if (scene === "review") {
    // Project SDLC: nothing is approved here. Every ready PR waits for a
    // person to review it on GitHub.
    for (const project of [ledger, press, courier, atlas]) {
      for (const pr of project.pullRequests) {
        if (pr.approval === null) continue;
        pr.approval = null;
        pr.awaitingReview = true;
        if (pr.checks === "failure") pr.checks = "success";
      }
      for (const candidate of project.issues) candidate.review = false;
    }
  }
  if (scene === "crowded") {
    // A backlog an order of magnitude longer, most of it out of the queue.
    const nouns = ["invoice", "ledger", "tile", "marker", "digest", "webhook", "export", "import", "session", "banner", "footer", "cache"];
    const verbs = ["Paginate", "Deduplicate", "Validate", "Archive", "Localise", "Rate-limit", "Index", "Redact", "Batch", "Sign"];
    let n = 300;
    for (const project of [ledger, press, courier, atlas]) {
      for (let i = 0; i < 16; i++) {
        const title = `${verbs[(n + i) % verbs.length]} every ${nouns[(n * 7 + i) % nouns.length]} before it reaches the ${nouns[(n + i * 3) % nouns.length]} view`;
        const made = issue(n, title, i % 3 === 0 ? { projectStatus: "Backlog" } : i % 4 === 1 ? { blockedBy: [n - 1] } : {});
        made.stuck = made.blockedBy.length > 0;
        project.issues.push(made);
        n += 1;
      }
    }
  }
  return [ledger, press, courier, atlas];
}

// ── The simulation ───────────────────────────────────────────────────────────

const emitter = new EventEmitter();
const projects = buildProjects(SCENE);
const multiProject = projects.length > 1;
const engines: DemoEngine[] = Array.from({ length: ENGINES }, (_, index) => ({
  index,
  iteration: 0,
  action: null,
  wakeAtMs: Date.now() + span(0.2, 2.5),
}));
const claimed = new Set<string>();
/** Work whose last run failed, and when it may be tried again: yoke backs a
 *  failed action off rather than throw the next free engine at it. */
const coolingUntil = new Map<string, number>();
let nextNumber = 700;
let usagePercent = SCENE === "hold" ? 100 : 41;
const usageResetsAtMs = Date.now() + (SCENE === "hold" ? 2 * 3600_000 + 14 * 60_000 : 3 * 3600_000 + 7 * 60_000);
const holdUntilMs = SCENE === "hold" ? usageResetsAtMs : null;

function log(level: "info" | "success" | "warning" | "error", message: string, repo = ""): void {
  emitter.emit("log-message", { level, message, repo });
}

/** The issues still blocking `candidate`. */
function blockers(project: DemoProject, candidate: DemoIssue): number[] {
  if (candidate.stuck) return candidate.blockedBy;
  return candidate.blockedBy.filter((n) => project.issues.some((other) => other.number === n && !other.closed));
}

function isBlocked(project: DemoProject, candidate: DemoIssue): boolean {
  return blockers(project, candidate).length > 0;
}

function prFor(project: DemoProject, issueNumber: number): DemoPullRequest | undefined {
  return project.pullRequests.find((pr) => pr.issue === issueNumber && !pr.merged);
}

function emitLifecycle(project: DemoProject): void {
  const pairs: Record<string, unknown>[] = [];
  const paired = new Set<number>();
  const prCard = (pr: DemoPullRequest) => ({
    number: pr.number, title: pr.title, state: "open", draft: pr.draft, checksStatus: pr.checks,
  });
  for (const pr of project.pullRequests) {
    const linked = pr.issue === null ? undefined : project.issues.find((candidate) => candidate.number === pr.issue);
    if (linked) paired.add(linked.number);
    pairs.push({
      issue: linked ? { number: linked.number, title: linked.title, state: "open" } : null,
      pr: prCard(pr),
      prPhase: pr.merged ? "completed" : pr.draft ? "active" : "review",
      colorIndex: (linked?.number ?? pr.number) % 6,
      ...(pr.manual ? { disabled: true } : {}),
      ...(pr.approval !== null && !pr.merged ? { approval: pr.approval } : {}),
      ...(pr.awaitingReview && !pr.merged ? { awaitingReview: true } : {}),
    });
  }
  for (const candidate of project.issues) {
    if (candidate.closed || paired.has(candidate.number)) continue;
    if (candidate.projectStatus !== null) {
      pairs.push({
        issue: { number: candidate.number, title: candidate.title, state: "open" },
        pr: null, prPhase: "inactive", colorIndex: candidate.number % 6, projectStatus: candidate.projectStatus,
      });
      continue;
    }
    const blockedBy = blockers(project, candidate);
    pairs.push({
      issue: { number: candidate.number, title: candidate.title, state: "open" },
      pr: null,
      prPhase: project.planning.has(candidate.number) ? "planning" : "absent",
      colorIndex: candidate.number % 6,
      ...(blockedBy.length > 0 ? { blockedByIssueNumbers: blockedBy } : {}),
    });
  }
  emitter.emit("lifecycle-update", { pairs, repo: project.repo });
}

function emitSnapshot(project: DemoProject): void {
  const open = project.pullRequests.filter((pr) => !pr.merged);
  const issues = project.issues.filter((candidate) => !candidate.closed);
  emitter.emit("snapshot-update", {
    repo: project.repo,
    issueCount: issues.length,
    prCount: open.length,
    sessionCount: engines.filter((engine) => engine.action?.project === project).length,
    issues: issues.map((candidate) => ({ number: candidate.number, title: candidate.title, state: "open" })),
    pullRequests: open.map((pr) => ({
      number: pr.number, title: pr.title, state: "open", draft: pr.draft, checksStatus: pr.checks,
      closingIssueNumbers: pr.issue === null ? [] : [pr.issue], linkedIssueNumbers: pr.issue === null ? [] : [pr.issue],
    })),
  });
}

function emitUsage(): void {
  emitter.emit("usage-update", {
    status: "ok",
    fiveHourPercent: Math.min(100, usagePercent),
    resetsAtMs: usageResetsAtMs,
    fetchedAtMs: Date.now(),
    reason: "",
  });
}

function broadcastPullRequest(project: DemoProject, pr: DemoPullRequest, action: string, stateAfter: string, excellence: string): void {
  emitter.emit("broadcast-pr-update", {
    prNumber: pr.number,
    title: pr.title,
    action,
    state: pr.merged ? "merged" : "open",
    draft: pr.draft,
    checksStatus: pr.checks,
    stateBefore: `PR #${pr.number} "${pr.title}"`,
    changeHow: action,
    stateAfter,
    excellence,
    repo: project.repo,
  });
}

function startChecks(pr: DemoPullRequest, willFail = random() < 0.25): void {
  pr.checks = "pending";
  pr.checksDoneAtMs = Date.now() + span(14, 40);
  pr.checksWillFail = willFail;
}

/** The action an engine would take next, most pressing first; null for none. */
function plan(): DemoAction | null {
  const free = (project: DemoProject, kind: string, n: number): boolean => {
    const key = `${project.repo}:${kind}:${n}`;
    return !claimed.has(key) && (coolingUntil.get(key) ?? 0) <= Date.now();
  };
  const duration = (low: number, high: number): number => Date.now() + span(low, high);

  for (const project of projects) {
    for (const pr of project.pullRequests) {
      if (pr.merged || pr.manual || !free(project, "pr", pr.number)) continue;
      const linked = pr.issue === null ? null : project.issues.find((candidate) => candidate.number === pr.issue) ?? null;
      const make = (type: DemoAction["type"], model: string, low: number, high: number): DemoAction =>
        ({ type, project, issue: linked, pullRequest: pr, model, doneAtMs: duration(low, high) });
      if (pr.checks === "pending") continue;
      if (pr.checks === "failure") {
        // Yoke fixes failing checks itself — but never on a PR parked for a person.
        if (pr.approval === "awaiting-approval") continue;
        return make("address-failing-checks", INITIAL_MODEL, 22, 60);
      }
      if (pr.approval === "approved") return make("squash-merge", DESCRIBE_MODEL, 8, 16);
      if (pr.approval === "awaiting-approval" || pr.awaitingReview) continue;
      if (pr.cleanReviews >= 2) return make("squash-merge", DESCRIBE_MODEL, 8, 16);
      return make("self-review", REVIEW_MODEL, 26, 80);
    }
  }
  for (const project of projects) {
    for (const candidate of project.issues) {
      if (candidate.closed || candidate.projectStatus !== null || isBlocked(project, candidate)) continue;
      if (prFor(project, candidate.number) || !free(project, "issue", candidate.number)) continue;
      return {
        type: "start-implementation", project, issue: candidate, pullRequest: null,
        model: INITIAL_MODEL, doneAtMs: duration(40, 130),
      };
    }
  }
  return null;
}

function claimKey(action: DemoAction): string {
  return action.pullRequest
    ? `${action.project.repo}:pr:${action.pullRequest.number}`
    : `${action.project.repo}:issue:${action.issue!.number}`;
}

function describe(action: DemoAction): string {
  const pr = action.pullRequest ? `PR #${action.pullRequest.number}` : "";
  switch (action.type) {
    case "start-implementation": return `Implement issue #${action.issue!.number} "${action.issue!.title}" via Claude`;
    case "self-review": return `Self-review ${pr} "${action.pullRequest!.title}"`;
    case "address-failing-checks": return `Fix failing checks on ${pr}`;
    case "resolve-conflicts": return `Resolve merge conflicts on ${pr}`;
    case "squash-merge": return `Write the final description of ${pr} and squash-merge it`;
  }
}

function startAction(engine: DemoEngine, action: DemoAction): void {
  engine.action = action;
  claimed.add(claimKey(action));
  if (action.type === "start-implementation") {
    action.project.planning.add(action.issue!.number);
    emitLifecycle(action.project);
  }
  emitter.emit("phase-update", { phase: "implementation" });
  emitter.emit("action-start", {
    actionIndex: engine.index + 1,
    totalActions: ENGINES,
    repo: action.project.repo,
    description: describe(action),
    type: action.type,
    issueNumber: action.issue?.number ?? null,
    pullRequestNumber: action.pullRequest?.number ?? null,
    issueTitle: action.issue?.title ?? null,
    pullRequestTitle: action.pullRequest?.title ?? null,
    model: action.model,
    startedAt: Date.now(),
  });
}

function finishAction(engine: DemoEngine): void {
  const action = engine.action!;
  const { project, pullRequest: pr } = action;
  engine.action = null;
  claimed.delete(claimKey(action));
  usagePercent += between(0.4, 1.6);

  // Now and then a run fails outright, and is retried next cycle.
  if (action.type !== "squash-merge" && random() < FAIL) {
    if (action.type === "start-implementation") project.planning.delete(action.issue!.number);
    coolingUntil.set(claimKey(action), Date.now() + span(50, 90));
    emitter.emit("action-error", {
      actionIndex: engine.index + 1, totalActions: ENGINES, repo: project.repo,
      error: "Claude run ended without a result: the CLI exited with status 1",
    });
    emitLifecycle(project);
    return;
  }

  switch (action.type) {
    case "start-implementation": {
      const made = pullRequest(nextNumber++, action.issue!.number, action.issue!.title);
      startChecks(made, random() < 0.3);
      project.pullRequests.push(made);
      project.planning.delete(action.issue!.number);
      broadcastPullRequest(project, made, "opened", "OPEN — draft, CI pending", "New change in flight — implementation is underway");
      break;
    }
    case "self-review": {
      if (random() < 0.3) {
        pr!.cleanReviews = 0;
        startChecks(pr!);
        emitter.emit("broadcast-commit", {
          hash: Math.floor(random() * 0xfffffff).toString(16).padStart(7, "0") + "c0ffee1",
          author: "yoke", message: `Address self-review of #${pr!.number}`,
          stateBefore: "Branch was at previous commit", changeHow: "yoke pushed review fixes",
          stateAfter: `Branch advanced: "Address self-review of #${pr!.number}"`,
          excellence: "", repo: project.repo,
        });
      } else {
        pr!.cleanReviews += 1;
        if (SCENE === "review" && pr!.cleanReviews >= 1) {
          pr!.draft = false;
          pr!.awaitingReview = true;
          broadcastPullRequest(project, pr!, "ready for review", "OPEN — ready, review requested", "Clean review — parked for a person");
        } else if (action.issue?.review && pr!.cleanReviews >= 1) {
          pr!.draft = false;
          pr!.approval = "awaiting-approval";
          broadcastPullRequest(project, pr!, "ready for review", "OPEN — ready, waiting for approval", "Clean review — parked for a person");
        }
      }
      break;
    }
    case "address-failing-checks": {
      startChecks(pr!, false);
      break;
    }
    case "resolve-conflicts": {
      startChecks(pr!, false);
      break;
    }
    case "squash-merge": {
      pr!.merged = true;
      pr!.draft = false;
      pr!.approval = null;
      pr!.goneAtMs = Date.now() + span(20, 30);
      if (action.issue) action.issue.closed = true;
      broadcastPullRequest(project, pr!, "squash-merged", "MERGED", "Shipped — one more issue closed");
      if (action.issue) {
        emitter.emit("broadcast-issue-update", {
          issueNumber: action.issue.number, title: action.issue.title, action: "closed", state: "closed",
          stateBefore: `Issue #${action.issue.number} "${action.issue.title}" was open`,
          changeHow: `Issue closed: "${action.issue.title}"`,
          stateAfter: `Issue #${action.issue.number} is CLOSED`,
          excellence: "", repo: project.repo,
        });
      }
      break;
    }
  }

  emitter.emit("action-complete", {
    actionIndex: engine.index + 1, totalActions: ENGINES, repo: project.repo, noCommitsPushed: false,
  });
  emitLifecycle(project);
  emitSnapshot(project);
}

let stopping = false;
const stopped = new Set<number>();

function tickEngine(engine: DemoEngine, nowMs: number): void {
  if (stopped.has(engine.index)) return;
  if (engine.action) {
    if (nowMs >= engine.action.doneAtMs) {
      finishAction(engine);
      if (stopping) {
        stopped.add(engine.index);
        emitter.emit("engine-shutdown", { engineIndex: engine.index });
        return;
      }
      const waitMs = span(6, 14);
      engine.wakeAtMs = nowMs + waitMs;
      emitter.emit("engine-idle", { engineIndex: engine.index, nextCycleAtMs: engine.wakeAtMs });
    }
    return;
  }
  if (stopping) {
    // No engine starts new work once a shutdown is requested.
    stopped.add(engine.index);
    emitter.emit("engine-shutdown", { engineIndex: engine.index });
    return;
  }
  if (nowMs < engine.wakeAtMs) return;

  if (holdUntilMs !== null && nowMs < holdUntilMs) {
    engine.wakeAtMs = nowMs + 5000;
    emitter.emit("engine-idle", {
      engineIndex: engine.index, reason: "claude-usage-limit",
      rateLimitedUntilMs: holdUntilMs, nextCycleAtMs: holdUntilMs,
    });
    return;
  }

  engine.iteration += 1;
  emitter.emit("iteration-start", { iterationNumber: engine.iteration, engineIndex: engine.index, maxConcurrency: ENGINES });
  const action = plan();
  if (action) {
    startAction(engine, action);
    return;
  }
  engine.wakeAtMs = nowMs + span(8, 16);
  emitter.emit("engine-idle", { engineIndex: engine.index, reason: "nothing to do this cycle" });
  emitter.emit("engine-idle", { engineIndex: engine.index, nextCycleAtMs: engine.wakeAtMs });
}

function tickChecks(nowMs: number): void {
  for (const project of projects) {
    let changed = false;
    for (const pr of project.pullRequests) {
      if (pr.checks === "pending" && pr.checksDoneAtMs !== null && nowMs >= pr.checksDoneAtMs) {
        pr.checks = pr.checksWillFail ? "failure" : "success";
        pr.checksDoneAtMs = null;
        changed = true;
        emitter.emit("broadcast-ci-status", {
          prNumber: pr.number, status: pr.checks,
          stateBefore: `PR #${pr.number} CI checks were running`,
          changeHow: "CI pipeline executed",
          stateAfter: pr.checks === "success" ? `All checks PASSED for PR #${pr.number}` : `Checks FAILED for PR #${pr.number}`,
          excellence: "", repo: project.repo,
        });
      }
    }
    const before = project.pullRequests.length;
    project.pullRequests = project.pullRequests.filter((pr) => !(pr.merged && pr.goneAtMs !== null && nowMs >= pr.goneAtMs));
    project.issues = project.issues.filter((candidate) =>
      !candidate.closed || project.pullRequests.some((pr) => pr.issue === candidate.number));
    if (changed || project.pullRequests.length !== before) {
      emitLifecycle(project);
      emitSnapshot(project);
    }
  }
}

/** Answer an Approve press the way the engine pool does (#276). */
function approve(repo: string, pullRequestNumber: number): void {
  const requestedAt = new Date().toISOString();
  const say = (state: string, extra: Record<string, unknown> = {}): void => {
    emitter.emit("pull-request-approval", { repo, pullRequestNumber, requestedAt, state, ...extra });
  };
  const project = projects.find((candidate) => candidate.repo === repo);
  const pr = project?.pullRequests.find((candidate) => candidate.number === pullRequestNumber && !candidate.merged);
  log("info", `Approve requested on the dashboard: ${repo} PR #${pullRequestNumber}`, repo);
  say("loading");
  setTimeout(() => {
    say("waiting");
    setTimeout(() => {
      if (!project || !pr) {
        say("refused", { reason: "it is not an open pull request" });
        return;
      }
      if (pr.approval === "approved") {
        say("approved", { checksPending: pr.checks === "pending", alreadyApproved: true });
        return;
      }
      if (pr.checks === "failure") {
        say("refused", { reason: "its checks are failing" });
        log("warning", `  ✗ not approved: its checks are failing.`, repo);
        return;
      }
      if (pr.approval !== "awaiting-approval") {
        say("refused", { reason: "it is not waiting on approval" });
        return;
      }
      pr.approval = "approved";
      say("approved", { checksPending: pr.checks === "pending", alreadyApproved: false });
      log("success", `  ✓ approved — an engine will squash-merge it next.`, repo);
      emitLifecycle(project);
      // Wake an idle engine now rather than at the end of its cycle wait.
      const idle = engines.find((engine) => engine.action === null);
      if (idle) idle.wakeAtMs = Date.now() + 600;
    }, 900 / SPEED);
  }, 500 / SPEED);
}

// ── Run ──────────────────────────────────────────────────────────────────────

const server = new DashboardServer({
  port: PORT,
  host: argument("host", "localhost"),
  owner: multiProject ? "" : projects[0]!.repo.split("/")[0]!,
  repo: multiProject ? "" : projects[0]!.repo.split("/")[1]!,
  dashboardTitle: argument("title", "Outright Mental"),
  maxConcurrency: ENGINES,
  multiProject,
  projects: projects.map((project) => project.repo),
  eventEmitter: emitter,
});

emitter.subscribe((event) => {
  if (event.type !== "pull-request-approve") return;
  approve(String(event.data["repo"]), Number(event.data["pullRequestNumber"]));
});

await server.initialize();
try {
  await server.start();
} catch (error) {
  console.error(
    `[demo] Could not start the Dashboard on port ${PORT}: ${error instanceof Error ? error.message : String(error)}\n` +
      `       Pass another with -- --port=4000.`,
  );
  process.exit(1);
}

for (const project of projects) {
  for (const pr of project.pullRequests) if (pr.checks === "pending") startChecks(pr, false);
  emitLifecycle(project);
  emitSnapshot(project);
}
emitUsage();
if (holdUntilMs !== null) {
  emitter.emit("work-hold", { kind: "claude-usage-limit", reason: "Claude usage limit", untilMs: holdUntilMs });
}
log("info", `demo: ${projects.length} project(s), ${ENGINES} engines, scene "${SCENE}", speed ×${SPEED}`);

const ticker = setInterval(() => {
  const nowMs = Date.now();
  tickChecks(nowMs);
  for (const engine of engines) tickEngine(engine, nowMs);
}, 250);
const usageTicker = setInterval(emitUsage, 5000);

/** Stop the way yoke does: finish what is in flight, start nothing new, then exit. */
function shutdown(): void {
  if (stopping) {
    process.exit(0);
  }
  stopping = true;
  emitter.emit("shutdown-requested", {});
  console.log("[demo] Shutdown requested — engines stop after their current action. Ctrl+C again to exit now.");
  const drained = setInterval(() => {
    if (stopped.size < engines.length) return;
    clearInterval(drained);
    clearInterval(ticker);
    clearInterval(usageTicker);
    emitter.emit("app-shutdown", {});
    if (argument("stay", "") !== "") return;
    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 500);
  }, 200);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
if (SHUTDOWN_AFTER > 0) setTimeout(shutdown, SHUTDOWN_AFTER * 1000);

console.log(`[demo] Dashboard demo at ${server.getUrl()} — Ctrl+C to stop.`);
