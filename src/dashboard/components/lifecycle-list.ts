import { LitElement, html } from 'lit';
import type { CylinderState, LifecyclePair } from '../store/types.js';
import { issueColor, NEUTRAL_COLOR, NEUTRAL_COLOR_RGB } from '../shared/issue-colors.js';
import { pillActivity, pillKey, type PillActivity } from '../shared/pill-activity.js';
import { withWorkedPairs } from '../shared/worked-pairs.js';
import './lifecycle-pill.js';

function lifecycleTier(pair: LifecyclePair): number {
  if (pair.prPhase === 'review') return 0;
  if (pair.prPhase === 'active') return 1;
  if (pair.prPhase === 'completed') return 2;
  if (pair.prPhase === 'planning') return 3;
  if (pair.prPhase === 'inactive') return 6;
  const blocked = (pair.blockedByIssueNumbers?.length ?? 0) > 0;
  return blocked ? 5 : 4;
}

function compareLifecyclePairs(
  a: LifecyclePair,
  b: LifecyclePair,
  cylinderByIssue: Map<number, number>
): number {
  const aCyl = a.issue ? cylinderByIssue.get(a.issue.number) : undefined;
  const bCyl = b.issue ? cylinderByIssue.get(b.issue.number) : undefined;
  if (aCyl !== undefined && bCyl !== undefined) return aCyl - bCyl;
  if (aCyl !== undefined) return -1;
  if (bCyl !== undefined) return 1;
  const ap = lifecycleTier(a);
  const bp = lifecycleTier(b);
  if (ap !== bp) return ap - bp;
  const aNum = a.issue ? a.issue.number : (a.pr?.number ?? 0);
  const bNum = b.issue ? b.issue.number : (b.pr?.number ?? 0);
  return aNum - bNum;
}

function resolvePillColor(issueNumber: number | null | undefined): { hex: string; rgb: string } {
  // Every issue keeps its own stable color forever; pills without an issue
  // (orphan PRs) stay neutral gray (issue #236).
  if (issueNumber != null) {
    const c = issueColor(issueNumber);
    return { hex: c.hex, rgb: c.rgb };
  }
  return { hex: NEUTRAL_COLOR, rgb: NEUTRAL_COLOR_RGB };
}

export class LifecycleList extends LitElement {
  static override properties = {
    pairs: { type: Array },
    cylinders: { attribute: false },
    cylinderByIssue: { attribute: false },
    cylinderByPR: { attribute: false },
    owner: { type: String },
    repo: { type: String },
    multiProject: { type: Boolean },
    dark: { type: Boolean },
    frozenActivity: { attribute: false },
  };

  pairs: LifecyclePair[] = [];
  cylinders: CylinderState[] = [];
  cylinderByIssue: Map<number, number> = new Map();
  cylinderByPR: Map<number, number> = new Map();
  owner = '';
  repo = '';
  multiProject = false;
  /** Yoke is shutting down: every pill goes dark (issue #268). */
  dark = false;
  /** Each pill's activity when the pills went dark, so their icons stay frozen. */
  frozenActivity: Map<string, PillActivity | null> | null = null;

  protected override createRenderRoot() { return this; }

  override render() {
    // Anything a cylinder is actively working gets a pill even when GitHub's
    // open lists no longer carry it, so this pane never silently disagrees
    // with the engine pane beside it.
    const pairs = withWorkedPairs(this.pairs, this.cylinders);
    const sorted = [...pairs].sort((a, b) => compareLifecyclePairs(a, b, this.cylinderByIssue));

    const active = pairs.filter(p => p.prPhase === 'active' || p.prPhase === 'planning').length;
    const subtitle = pairs.length === 0
      ? ''
      : `${pairs.length} item${pairs.length !== 1 ? 's' : ''} · ${active} in progress`;

    return html`
      <div class="panel panel-b">
        <div class="panel-header">
          ⚡ ISSUE→PR LIFECYCLE
          ${subtitle ? html`<span>${subtitle}</span>` : ''}
        </div>
        <div class="panel-body">
          <div class="lifecycle-content">
            ${sorted.length === 0
              ? html`<div class="lifecycle-empty">Connecting to yoke…</div>`
              : sorted.map((pair) => {
                  const issueNum = pair.issue?.number ?? null;
                  const color = resolvePillColor(issueNum);
                  // Key includes the repo so pills from different projects that
                  // happen to share an issue/PR number don't collide in the DOM.
                  const key = pillKey(pair);
                  // A dark pill shows the activity it had when it went dark.
                  const activity = this.frozenActivity?.has(key)
                    ? this.frozenActivity.get(key) ?? null
                    : pillActivity(pair, this.cylinders);
                  return html`
                    <lifecycle-pill
                      data-key="${key}"
                      .pair=${pair}
                      .color=${color.hex}
                      .colorRgb=${color.rgb}
                      .activity=${activity}
                      .dark=${this.dark}
                      .owner=${this.owner}
                      .repo=${this.repo}
                      .multiProject=${this.multiProject}
                    ></lifecycle-pill>
                  `;
                })
            }
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('lifecycle-list', LifecycleList);
