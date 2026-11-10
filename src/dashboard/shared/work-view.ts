import type { CylinderState, DashboardState, LifecyclePair } from '../store/types.js';
import { burnColor, pillBurnLevel, type BurnLevel } from './burn-level.js';
import { NEUTRAL_COLOR, NEUTRAL_COLOR_RGB, workColor, type IssueColor } from './issue-colors.js';
import { pillActivity, pillKey, pillsDark, type PillActivity } from './pill-activity.js';
import { approvalPressFor, approvalStatusFor, approvalView, type ApprovalView } from './pill-approval.js';
import { withWorkedPairs } from './worked-pairs.js';
import { workingCylinder } from './working-cylinder.js';

/**
 * One piece of work as the field draws it: an issue, its pull request, or
 * both, with everything the dashboard has worked out about where it stands.
 *
 * Every pane used to work these out for itself as it rendered — the pill its
 * color and icon, the list its order, the row its verb. They are worked out
 * once here instead, from the store's state and the clock alone, so the field,
 * the inbox and the screen-reader mirror cannot disagree about a piece of
 * work, and so all of it can be tested without a canvas.
 */
export interface WorkView {
  /** Its identity across updates (`pillKey`): the field animates by it. */
  key: string;
  pair: LifecyclePair;
  /** "owner/repo"; empty when the dashboard has one project and no need to say. */
  repo: string;
  /** The number it goes by: its issue's, or its PR's when it closes no issue. */
  number: number | null;
  /** Its issue's title, or its PR's when it closes no issue. */
  title: string;
  /** What it is doing or waiting on (the status glyph); frozen at shutdown. */
  activity: PillActivity | null;
  /** How much token burn it stands for right now. */
  level: BurnLevel;
  /** Its stable color at full saturation: which issue it is. */
  hue: IssueColor;
  /** That color at its level's saturation: how hot it is. */
  color: IssueColor;
  /** How far along the lifecycle it is: an index into `STAGES`. */
  stage: number;
  /** One line saying where it stands. */
  status: WorkStatus;
  /** Its PR's checks, or null with no PR or no checks to speak of. */
  checks: 'success' | 'failure' | 'pending' | null;
  /** Issue numbers still blocking it; empty when none are. */
  blockedBy: number[];
  /** The engine cylinder running an action on it right now, if one is. */
  engine: CylinderState | null;
  /** What its PR's dashboard approval shows (#276, #278). */
  approval: ApprovalView;
  /** Yoke is shutting down, so it has gone dark (#268). */
  dark: boolean;
  issueUrl: string | null;
  prUrl: string | null;
}

/** What a line of status is saying, which picks its color. `plain` is trim. */
export type StatusTone = 'plain' | 'progress' | 'approved' | 'problem';

export interface WorkStatus {
  text: string;
  tone: StatusTone;
  /** True when the line says only what its stratum already does — waiting its
   *  turn for an engine — so that a list of such lines can leave it unsaid
   *  rather than say it eight times over. */
  routine?: boolean;
  /** The same in a word or two, for a line with no room for the sentence:
   *  "checks failing" for "checks failing — an engine fixes them next". Left
   *  out when the text is already as short as it gets. */
  brief?: string;
}

/** What a line of work with room for only a few words says of where it stands. */
export function briefStatus(status: WorkStatus): string {
  if (status.routine) return '';
  return status.brief ?? status.text;
}

/**
 * The lifecycle every piece of work runs through, in order: an open issue, an
 * engine building it, a draft PR that yoke reviews and fixes, a PR that is
 * ready, and the merge. The field draws a work's place on it as a track of
 * five marks.
 */
export const STAGES = ['issue', 'build', 'draft', 'ready', 'merged'] as const;

/** The stage a lifecycle pair has reached, as an index into `STAGES`. */
export function pairStage(pair: LifecyclePair): number {
  switch (pair.prPhase) {
    case 'completed': return 4;
    case 'review': return 3;
    case 'active': return 2;
    case 'planning': return 1;
    default: return 0;
  }
}

/** What an engine is doing, and what it did, for each action it can run. */
const VERBS: Readonly<Record<string, { doing: string; done: string }>> = {
  'start-implementation': { doing: 'implementing', done: 'implemented' },
  'self-review': { doing: 'reviewing', done: 'reviewed' },
  'address-failing-checks': { doing: 'fixing checks', done: 'fixed checks' },
  'resolve-conflicts': { doing: 'resolving conflicts', done: 'resolved conflicts' },
  'squash-merge': { doing: 'merging', done: 'merged' },
  'request-review': { doing: 'requesting review', done: 'requested review' },
};

/** "implementing", "fixing checks", … — or the action's own name for one this
 *  dashboard has not heard of, and "working" for none at all. */
export function actionVerb(actionType: string | null, tense: 'doing' | 'done' = 'doing'): string {
  if (!actionType) return tense === 'doing' ? 'working' : 'worked';
  return VERBS[actionType]?.[tense] ?? actionType;
}

/** What an action is run on, as the engine names it: "#40" for an
 *  implementation, which has only an issue, and "PR #118" for the rest. */
export function actionTarget(cyl: Pick<CylinderState, 'actionType' | 'issueNumber' | 'prNumber'>): string {
  if (cyl.prNumber !== null && cyl.actionType !== 'start-implementation') return `PR #${cyl.prNumber}`;
  if (cyl.issueNumber !== null) return `#${cyl.issueNumber}`;
  return cyl.prNumber !== null ? `PR #${cyl.prNumber}` : '';
}

function numbersList(numbers: readonly number[]): string {
  return numbers.map((n) => `#${n}`).join(', ');
}

/**
 * Where a piece of work stands, in one line. An approval says its own piece
 * first — it is the one thing here a person set in motion, so its progress
 * (`queued — sent to yoke…`) or its refusal outranks everything the lifecycle
 * has to say. After that the line names the one thing the work is waiting on.
 */
export function workStatus(params: {
  pair: LifecyclePair;
  activity: PillActivity | null;
  approval: ApprovalView;
  engine: CylinderState | null;
  dark: boolean;
}): WorkStatus {
  const { pair, activity, approval, engine, dark } = params;
  const pr = pair.pr ?? null;

  if (engine) {
    const target = actionTarget(engine);
    return { text: target ? `${actionVerb(engine.actionType)} ${target}` : actionVerb(engine.actionType), tone: 'plain' };
  }
  if (approval.line) {
    // An approval's line leads with the word for where it has got to —
    // "queued — sent to yoke…", "not approved: its checks are failing".
    const brief = approval.line.text.split(/ — |: /)[0] ?? approval.line.text;
    return { text: approval.line.text, tone: approval.line.tone, brief };
  }
  if (pair.disabled) return { text: 'manual — yoke leaves it to you', tone: 'plain', brief: 'manual' };
  if (pair.prPhase === 'completed') return { text: 'merged', tone: 'approved' };
  if (pair.prPhase === 'inactive') return { text: pair.projectStatus || 'out of the queue', tone: 'plain' };
  if (pair.prPhase === 'planning') return { text: dark ? 'shut down' : 'implementing…', tone: 'plain' };

  if (!pr) {
    const blockedBy = pair.blockedByIssueNumbers ?? [];
    if (blockedBy.length > 0) return { text: `blocked by ${numbersList(blockedBy)}`, tone: 'problem' };
    return { text: dark ? 'shut down' : 'waiting for an engine', tone: 'plain', routine: true };
  }

  if (activity === 'waiting-ci') return { text: 'checks running', tone: 'progress' };
  if (pair.prPhase === 'review') {
    if (pair.approval === 'awaiting-approval') {
      return pr.checksStatus === 'failure'
        ? { text: 'ready — but its checks are failing', tone: 'problem', brief: 'checks failing' }
        : { text: 'ready — waiting for your approval', tone: 'plain', brief: 'awaiting approval' };
    }
    return { text: 'ready for review', tone: 'plain' };
  }
  if (pr.checksStatus === 'failure') {
    return { text: 'checks failing — an engine fixes them next', tone: 'problem', brief: 'checks failing' };
  }
  return { text: dark ? 'shut down' : 'draft — waiting for an engine', tone: 'plain', routine: true };
}

function checksOf(pair: LifecyclePair): WorkView['checks'] {
  const status = pair.pr?.checksStatus;
  return status === 'success' || status === 'failure' || status === 'pending' ? status : null;
}

/**
 * Every piece of work on the dashboard, as the field draws it at `nowMs`.
 *
 * It is the lifecycle the projects reported, plus anything an engine is
 * working that GitHub's open lists no longer carry (`withWorkedPairs`), so the
 * field never shows an engine burning on nothing.
 */
export function workViews(state: DashboardState, nowMs: number): WorkView[] {
  const dark = pillsDark(state);
  const connected = state.connection === 'connected';
  const fallbackRepo = state.owner && state.repo ? `${state.owner}/${state.repo}` : '';
  const pairs = withWorkedPairs(state.lastLifecyclePairs, state.cylinders);

  return pairs.map((pair) => {
    const key = pillKey(pair);
    const engine = workingCylinder(pair, state.cylinders);
    // A dark pill keeps the activity it had when it went dark (#268).
    const activity = state.frozenPillActivity?.has(key)
      ? state.frozenPillActivity.get(key) ?? null
      : pillActivity(pair, state.cylinders);
    const level = pillBurnLevel(pair, activity, dark);
    // Work is never gray (#280): an orphan PR takes its own number's color.
    const hue = workColor(pair.issue?.number, pair.pr?.number) ?? { hex: NEUTRAL_COLOR, rgb: NEUTRAL_COLOR_RGB };
    const approval = approvalView({
      pair,
      activity,
      workingAction: engine?.actionType ?? null,
      dark,
      status: approvalStatusFor(state.approvals, pair),
      press: approvalPressFor(state.approvalPresses, pair),
      connected,
      nowMs,
    });
    const linkRepo = pair.repo || fallbackRepo;
    const baseUrl = linkRepo ? `https://github.com/${linkRepo}` : null;

    return {
      key,
      pair,
      repo: pair.repo ?? '',
      number: pair.issue?.number ?? pair.pr?.number ?? null,
      title: pair.issue?.title || pair.pr?.title || '',
      activity,
      level,
      hue,
      color: burnColor(hue, level),
      stage: pairStage(pair),
      status: workStatus({ pair, activity, approval, engine, dark }),
      checks: checksOf(pair),
      blockedBy: pair.pr ? [] : [...(pair.blockedByIssueNumbers ?? [])],
      engine,
      approval,
      dark,
      issueUrl: baseUrl && pair.issue ? `${baseUrl}/issues/${pair.issue.number}` : null,
      prUrl: baseUrl && pair.pr ? `${baseUrl}/pull/${pair.pr.number}` : null,
    };
  });
}

/**
 * The small mark at the end of a line of work saying what it is doing or
 * waiting on. The first four are the pill's status icons (#262) and mean what
 * they did: an engine on it, a person's to do, its checks running, ready for
 * review. The rest say what a line has no badge to say any more: approved and
 * waiting for its merge, checks failing, blocked, merged.
 */
export type WorkGlyph = 'engine' | 'person' | 'checks' | 'eye' | 'approved' | 'failing' | 'blocked' | 'merged';

export function workGlyph(work: Pick<WorkView, 'activity' | 'pair' | 'approval' | 'checks' | 'blockedBy'>): WorkGlyph | null {
  switch (work.activity) {
    case 'working': return 'engine';
    case 'manual': return 'person';
    case 'waiting-ci': return 'checks';
    case 'review': return 'eye';
  }
  if (work.pair.prPhase === 'completed') return 'merged';
  if (work.pair.approval === 'approved' || work.approval.approved) return 'approved';
  if (work.checks === 'failure') return 'failing';
  if (work.blockedBy.length > 0) return 'blocked';
  return null;
}

/**
 * Where a level's work sorts within its own stratum: the nearest to moving
 * first. Within `queued` that is an approved merge, then a PR waiting on its
 * checks, then one waiting for an engine, then an issue; within `waiting`, a PR
 * waiting on a person ahead of an issue waiting on other issues; within
 * `cold`, a merge — the freshest outcome — ahead of what was never in play.
 */
function tier(work: WorkView): number {
  const { pair } = work;
  if (pair.prPhase === 'completed') return 0;
  if (pair.approval === 'approved' || work.approval.approved) return 1;
  if (pair.prPhase === 'review') return 2;
  if (pair.prPhase === 'active') return work.checks === 'pending' ? 3 : 4;
  if (pair.prPhase === 'planning') return 5;
  if (pair.disabled) return 6;
  if (pair.prPhase === 'inactive') return 9;
  return work.blockedBy.length > 0 ? 8 : 7;
}

/** The order work is laid out in within one stratum, stable from one update
 *  to the next so that nothing changes place unless its state did. */
export function compareWork(a: WorkView, b: WorkView): number {
  const byTier = tier(a) - tier(b);
  if (byTier !== 0) return byTier;
  const byNumber = (a.number ?? 0) - (b.number ?? 0);
  if (byNumber !== 0) return byNumber;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
