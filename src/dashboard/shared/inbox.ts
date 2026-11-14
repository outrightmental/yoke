import type { ActionFailure, DiskSpace } from '../store/types.js';
import { formatBytes, formatDuration } from './format.js';
import type { IssueColor } from './issue-colors.js';
import { approveKey, type ApproveButtonStep, type ApproveTarget } from './pill-approval.js';
import type { KeepAwakeStatus } from './keep-awake.js';
import { actionVerb, STAGES, type StatusTone, type WorkView } from './work-view.js';

/**
 * The inbox: everything on the dashboard that is waiting on a person, in one
 * place, down the right-hand side of the screen.
 *
 * It is federated — each kind of thing a person can do comes from its own
 * source, and they are all drawn the same way, as cards, in one list:
 *
 * - `disk`: the disk yoke keeps its checkouts on is short of space even after
 *   every idle checkout was removed, so no new work starts until someone makes
 *   room (#288).
 * - `keep-awake`: the browser refused to play the keep-awake loop; one tap
 *   starts it (#246).
 * - `approval`: a PR parked by the `review` label, to approve and merge here
 *   (#274), and every approval under way until its PR has merged (#276, #278).
 * - `review`: a PR yoke has asked a person to review on GitHub (Project SDLC).
 * - `failure`: an action an engine ran that failed, until an engine takes the
 *   work up again or the card is dismissed.
 * - `manual`: a PR labelled `manual`, which yoke leaves to a person.
 *
 * A new source is one more function from the dashboard's state to cards, added
 * to `buildInbox`; nothing that draws the inbox has to know of it.
 */
export type InboxSource = 'disk' | 'keep-awake' | 'approval' | 'review' | 'failure' | 'manual';

/** The sources in the order their cards are listed, most pressing first. */
export const INBOX_SOURCES: readonly InboxSource[] = ['disk', 'keep-awake', 'approval', 'review', 'failure', 'manual'];

/** The one thing a card's big button does. */
export type InboxAction =
  /** Approve a PR (#274): the button follows the approval from there (#278). */
  | { type: 'approve'; target: ApproveTarget; step: ApproveButtonStep; label: string; disabled: boolean; hint: string }
  /** Open a page on GitHub in a new tab. */
  | { type: 'open'; href: string; label: string; hint: string }
  /** Start the keep-awake loop the browser refused to autoplay. */
  | { type: 'keep-awake'; label: string; hint: string };

export interface InboxLink {
  label: string;
  href: string;
}

export interface InboxCard {
  /** Stable for as long as the card stands for the same thing: the list keeps
   *  its place by it, and the field tethers its work to it. */
  id: string;
  source: InboxSource;
  /** The work on the field this card is about (`WorkView.key`), or null. */
  workKey: string | null;
  /** The work's color at its burn level; null for a card about no work. */
  color: IssueColor | null;
  /** How the card is accented: by its work's color, or as a warning or an
   *  alarm in the status colors. */
  accent: 'work' | 'warning' | 'alarm';
  /** The line above the title saying what kind of thing this is. */
  eyebrow: string;
  /** "owner/repo", shown when several projects share the dashboard. */
  repo: string;
  title: string;
  /** Short facts under the title, beside its links: "checks passing". */
  facts: string[];
  /** What is happening with it right now, announced as it changes. */
  line: { text: string; tone: StatusTone } | null;
  action: InboxAction | null;
  links: InboxLink[];
  /** Whether a person can put it away. Only a notice can: a card standing for
   *  something still waiting on them stays until it no longer is. */
  dismissible: boolean;
}

/** What the field or the inbox has had picked out, to say more about. */
export type Selection =
  | { kind: 'work'; key: string }
  | { kind: 'engine'; index: number }
  | { kind: 'usage' }
  | { kind: 'hold' };

function checksFact(checks: WorkView['checks']): string | null {
  switch (checks) {
    case 'success': return 'checks passing';
    case 'failure': return 'checks failing';
    case 'pending': return 'checks running';
    default: return null;
  }
}

/** What a card about a PR says beside its links, which already name the PR
 *  and the issue it closes: how its checks stand. */
function pullRequestFacts(work: WorkView): string[] {
  const checks = checksFact(work.checks);
  return checks ? [checks] : [];
}

function workLinks(work: WorkView): InboxLink[] {
  const links: InboxLink[] = [];
  if (work.prUrl && work.pair.pr) links.push({ label: `PR #${work.pair.pr.number}`, href: work.prUrl });
  if (work.issueUrl && work.pair.issue) links.push({ label: `Issue #${work.pair.issue.number}`, href: work.issueUrl });
  return links;
}

/** A PR's own title, falling back to its issue's. */
function pullRequestTitle(work: WorkView): string {
  return work.pair.pr?.title || work.title;
}

const APPROVAL_EYEBROWS: Readonly<Record<ApproveButtonStep, string>> = {
  idle: 'Approve to merge',
  queued: 'Approval queued',
  approving: 'Approving',
  merged: 'Merged',
  retry: 'Not approved',
};

/**
 * A card for every PR with an approval to give or to follow: one parked by the
 * `review` label, and one whose approval is queued, being carried out, was
 * refused, or has just merged. It is the pill's Approve button and its line,
 * moved to where a hand can reach them; `approvalView` still decides what both
 * say, so the button behaves exactly as it did on the pill.
 */
function approvalCards(works: readonly WorkView[]): InboxCard[] {
  const cards: InboxCard[] = [];
  for (const work of works) {
    const pr = work.pair.pr;
    const { button, line } = work.approval;
    if (!pr || (button === null && line === null)) continue;
    const target: ApproveTarget = { repo: work.repo, pullRequestNumber: pr.number };
    cards.push({
      id: `approval:${approveKey(target)}`,
      source: 'approval',
      workKey: work.key,
      color: work.color,
      accent: 'work',
      eyebrow: button ? APPROVAL_EYEBROWS[button.step] : 'Approval',
      repo: work.repo,
      title: pullRequestTitle(work),
      facts: pullRequestFacts(work),
      line,
      action: button
        ? { type: 'approve', target, step: button.step, label: button.label, disabled: button.disabled, hint: button.title }
        : null,
      links: workLinks(work),
      dismissible: false,
    });
  }
  return cards;
}

/** A card for every PR yoke has asked a person to review on GitHub. */
function reviewCards(works: readonly WorkView[]): InboxCard[] {
  const cards: InboxCard[] = [];
  for (const work of works) {
    const pr = work.pair.pr;
    if (!pr || !work.prUrl || work.pair.awaitingReview !== true || work.pair.disabled || work.engine) continue;
    cards.push({
      id: `review:${work.key}`,
      source: 'review',
      workKey: work.key,
      color: work.color,
      accent: 'work',
      eyebrow: 'Ready for your review',
      repo: work.repo,
      title: pullRequestTitle(work),
      facts: pullRequestFacts(work),
      line: null,
      action: {
        type: 'open',
        href: work.prUrl,
        label: `Review PR #${pr.number}`,
        hint: `Open PR #${pr.number} on GitHub: yoke carries on once it is merged, commented on or returned to draft`,
      },
      links: workLinks(work).filter((link) => link.href !== work.prUrl),
      dismissible: false,
    });
  }
  return cards;
}

/** A card for every PR labelled `manual`, which yoke will not touch. */
function manualCards(works: readonly WorkView[]): InboxCard[] {
  const cards: InboxCard[] = [];
  for (const work of works) {
    const pr = work.pair.pr;
    if (!pr || !work.prUrl || !work.pair.disabled || work.pair.prPhase === 'completed') continue;
    cards.push({
      id: `manual:${work.key}`,
      source: 'manual',
      workKey: work.key,
      color: work.color,
      accent: 'work',
      eyebrow: 'Manual — yours',
      repo: work.repo,
      title: pullRequestTitle(work),
      facts: pullRequestFacts(work),
      line: null,
      action: {
        type: 'open',
        href: work.prUrl,
        label: `Open PR #${pr.number}`,
        hint: `PR #${pr.number} is labelled manual: yoke leaves it to you`,
      },
      links: workLinks(work).filter((link) => link.href !== work.prUrl),
      dismissible: false,
    });
  }
  return cards;
}

/** The id of the card for one failure: a later failure of the same work is a
 *  new card, so dismissing this one does not hide the next. */
export function failureCardId(failure: Pick<ActionFailure, 'key' | 'atMs'>): string {
  return `failure:${failure.key}@${failure.atMs}`;
}

/** The work a failure was on, if the field still shows it. */
function failedWork(failure: ActionFailure, works: readonly WorkView[]): WorkView | null {
  for (const work of works) {
    if (work.repo && failure.repo && work.repo !== failure.repo) continue;
    if (failure.prNumber !== null && work.pair.pr?.number === failure.prNumber) return work;
    if (failure.prNumber === null && failure.issueNumber !== null && work.pair.issue?.number === failure.issueNumber) return work;
  }
  return null;
}

/**
 * A card for every action that failed and has not been taken up again. Yoke
 * retries a failed action by itself, so there is nothing a person must do —
 * but a failure used to be one red line scrolling out of a four-line log, and
 * a person who wants to look should not have to catch it going by.
 */
function failureCards(
  failures: readonly ActionFailure[],
  works: readonly WorkView[],
  nowMs: number,
  showForMs: number,
): InboxCard[] {
  const cards: InboxCard[] = [];
  for (const failure of failures) {
    if (nowMs - failure.atMs >= showForMs) continue;
    const work = failedWork(failure, works);
    const baseUrl = failure.repo ? `https://github.com/${failure.repo}` : null;
    const links: InboxLink[] = work ? workLinks(work) : [];
    if (!work && baseUrl) {
      if (failure.prNumber !== null) links.push({ label: `PR #${failure.prNumber}`, href: `${baseUrl}/pull/${failure.prNumber}` });
      if (failure.issueNumber !== null) links.push({ label: `Issue #${failure.issueNumber}`, href: `${baseUrl}/issues/${failure.issueNumber}` });
    }
    const facts = [`engine ${failure.engineIndex + 1}`, `${formatDuration(Math.max(0, nowMs - failure.atMs))} ago`];
    cards.push({
      id: failureCardId(failure),
      source: 'failure',
      workKey: work?.key ?? null,
      color: work?.color ?? null,
      accent: 'alarm',
      eyebrow: `Failed ${actionVerb(failure.actionType)}`,
      repo: failure.repo,
      title: failure.prTitle || failure.issueTitle || work?.title || 'an action',
      facts,
      line: { text: `${failure.error} — yoke retries it`, tone: 'problem' },
      action: null,
      links,
      dismissible: true,
    });
  }
  return cards;
}

/**
 * The card for a disk too full to start new work on (#288). Yoke has already
 * removed every checkout it could, so only a person can make room; work under
 * way carries on, and new work starts by itself once there is enough.
 */
function diskCards(disk: DiskSpace | null | undefined): InboxCard[] {
  if (!disk?.low) return [];
  return [{
    id: 'disk',
    source: 'disk',
    workKey: null,
    color: null,
    accent: 'alarm',
    eyebrow: 'Disk almost full',
    repo: '',
    title: `${formatBytes(disk.freeBytes)} free — new work is on hold`,
    facts: [`needs ${formatBytes(disk.minFreeBytes)}`, disk.path].filter(Boolean),
    line: {
      text: 'every idle checkout is already removed — free some space and yoke resumes by itself',
      tone: 'problem',
    },
    action: null,
    links: [],
    dismissible: false,
  }];
}

/** The card for a keep-awake loop the browser would not autoplay (#246). */
function keepAwakeCards(status: KeepAwakeStatus): InboxCard[] {
  if (status !== 'blocked') return [];
  return [{
    id: 'keep-awake',
    source: 'keep-awake',
    workKey: null,
    color: null,
    accent: 'warning',
    eyebrow: 'Keep awake',
    repo: '',
    title: 'This computer may sleep mid-run',
    facts: ['the browser would not start the keep-awake loop by itself'],
    line: null,
    action: {
      type: 'keep-awake',
      label: 'Keep awake',
      hint: 'Start the keep-awake loop — the browser refused to autoplay it',
    },
    links: [],
    dismissible: false,
  }];
}

export interface InboxInput {
  works: readonly WorkView[];
  /** The failed actions the store still holds (`DashboardState.failures`). */
  failures: readonly ActionFailure[];
  keepAwake: KeepAwakeStatus;
  /** The latest free-space reading (`DashboardState.disk`); a card while it is low. */
  disk?: DiskSpace | null;
  /** Ids of the cards a person has put away. */
  dismissed: ReadonlySet<string>;
  /** When each card was first listed (`InboxLedger`), by id. */
  arrivals: ReadonlyMap<string, number>;
  nowMs: number;
  /** How long a failure is listed for (`FAILURE_SHOW_MS`). */
  failureShowMs: number;
}

/**
 * The inbox's cards, top to bottom.
 *
 * They are grouped by source, most pressing first, and within a source listed
 * in the order they arrived, the longest-waiting on top. So a card never moves
 * because of how it changes — an approval stays where it was pressed while it
 * reads Queued, Approving and Merged — and a new arrival lands below its
 * source's others rather than push one out from under a finger.
 */
export function buildInbox(input: InboxInput): InboxCard[] {
  const { works, arrivals } = input;
  const cards = [
    ...diskCards(input.disk),
    ...keepAwakeCards(input.keepAwake),
    ...approvalCards(works),
    ...reviewCards(works),
    ...failureCards(input.failures, works, input.nowMs, input.failureShowMs),
    ...manualCards(works),
  ].filter((card) => !card.dismissible || !input.dismissed.has(card.id));

  const rank = (card: InboxCard): number => INBOX_SOURCES.indexOf(card.source);
  const arrived = (card: InboxCard): number => arrivals.get(card.id) ?? Number.MAX_SAFE_INTEGER;
  return cards.sort((a, b) =>
    rank(a) - rank(b) || arrived(a) - arrived(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The cards whose buttons must not take a press just yet: the ones that have
 * only now appeared in the list, and the ones that have moved since it was
 * last drawn. `before` and `after` are where each card's top edge sat, by id.
 *
 * One press of Approve merges a pull request (#278), so the list must never
 * be what chose which: when the card above leaves and the next slides up
 * under a finger already on its way down, that press has to land on nothing.
 */
export function cardsToShield(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): string[] {
  const shielded: string[] = [];
  for (const [id, top] of after) {
    const was = before.get(id);
    if (was === undefined || Math.abs(was - top) > 1) shielded.push(id);
  }
  return shielded;
}

/**
 * When each inbox card first appeared. The inbox is ordered by it, and a list
 * a person presses buttons in must not be reordered by a clock they cannot
 * see: the ledger is the one piece of memory the inbox has, kept apart so that
 * `buildInbox` stays a function of what it is given.
 */
export class InboxLedger {
  private readonly _arrivals = new Map<string, number>();

  /** Note the cards now listed, and forget the ones that have gone. */
  observe(ids: Iterable<string>, nowMs: number): ReadonlyMap<string, number> {
    const present = new Set(ids);
    for (const id of this._arrivals.keys()) {
      if (!present.has(id)) this._arrivals.delete(id);
    }
    for (const id of present) {
      if (!this._arrivals.has(id)) this._arrivals.set(id, nowMs);
    }
    return this._arrivals;
  }

  get arrivals(): ReadonlyMap<string, number> {
    return this._arrivals;
  }
}

/**
 * The inbox for `input`, with `ledger` brought up to date: built once to learn
 * which cards there are, and again in the order that puts the new ones in.
 */
export function inboxWithLedger(input: Omit<InboxInput, 'arrivals'>, ledger: InboxLedger): InboxCard[] {
  const listed = buildInbox({ ...input, arrivals: ledger.arrivals });
  const arrivals = ledger.observe(listed.map((card) => card.id), input.nowMs);
  return buildInbox({ ...input, arrivals });
}

// ── What a tap on the field says more about ────────────────────────────────

/**
 * The card at the foot of the inbox that says more about whatever was tapped
 * on the field. The field has room for a line about each piece of work and
 * nothing to hover over on a touch screen, so the rest — the whole title, the
 * links to GitHub, why a gauge reads what it reads — is said here.
 */
export interface Inspection {
  /** The work on the field it is about, or null for an engine with none or an instrument. */
  workKey: string | null;
  color: IssueColor | null;
  eyebrow: string;
  repo: string;
  title: string;
  facts: string[];
  /** A sentence or two more. */
  body: string[];
  links: InboxLink[];
}

const LEVEL_WORDS = { burning: 'Burning', queued: 'Queued', waiting: 'Waiting', cold: 'Cold' } as const;

function inspectWork(work: WorkView): Inspection {
  const facts = pullRequestFacts(work);
  if (work.pair.pr?.draft) facts.unshift('draft');
  if (work.pair.issue && work.pair.issue.state !== 'open') facts.push(`issue ${work.pair.issue.state}`);
  const body = [work.status.text];
  const prTitle = work.pair.pr?.title;
  if (prTitle && work.pair.issue && prTitle !== work.pair.issue.title) body.push(`PR: ${prTitle}`);
  return {
    workKey: work.key,
    color: work.color,
    eyebrow: [LEVEL_WORDS[work.level], STAGES[work.stage]].filter(Boolean).join(' · '),
    repo: work.repo,
    title: work.title,
    facts,
    body,
    links: workLinks(work),
  };
}

/** What the inspector says about `selection`, or null when it is no longer there to say anything about. */
export function inspect(
  selection: Selection | null,
  context: {
    works: readonly WorkView[];
    engines: ReadonlyArray<{ index: number; line: string; model: string | null; iteration: number; repo: string; color: IssueColor; hasWork: boolean }>;
    usageHeading: string;
    usageTitle: string;
    hold: { remaining: string; deadline: string; reason: string } | null;
  },
): Inspection | null {
  if (selection === null) return null;
  switch (selection.kind) {
    case 'work': {
      const work = context.works.find((candidate) => candidate.key === selection.key);
      return work ? inspectWork(work) : null;
    }
    case 'engine': {
      const engine = context.engines.find((candidate) => candidate.index === selection.index);
      if (!engine) return null;
      const work = context.works.find((candidate) => candidate.engine !== null && candidate.engine.index === engine.index + 1) ?? null;
      const facts: string[] = [];
      if (engine.model) facts.push(engine.model);
      if (engine.iteration > 0) facts.push(`cycle ${engine.iteration}`);
      return {
        workKey: work?.key ?? null,
        color: engine.hasWork ? engine.color : null,
        eyebrow: `Engine ${engine.index + 1}`,
        repo: engine.repo,
        title: engine.line,
        facts,
        body: work ? [work.title] : [],
        links: work ? workLinks(work) : [],
      };
    }
    case 'usage':
      return {
        workKey: null, color: null, eyebrow: 'Claude usage', repo: '',
        title: context.usageHeading, facts: [], body: [context.usageTitle], links: [],
      };
    case 'hold':
      if (!context.hold) return null;
      return {
        workKey: null, color: null, eyebrow: 'Waiting', repo: '',
        title: `${context.hold.remaining} until ${context.hold.deadline}`,
        facts: [],
        body: [`for ${context.hold.reason} · no work is planned or started until then`],
        links: [],
      };
  }
}
