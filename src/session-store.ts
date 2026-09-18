import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  AgentSession,
  AgentSessionPhase,
  AgentSessionResult,
  AgentSessionStatus,
} from "./types.js";
import { replaceFileCrossPlatform } from "./fs-utils.js";

interface SessionState {
  sessions: AgentSession[];
  /**
   * Maps pull request number → ISO timestamp of the most recent human
   * comment yoke has read for that PR. Used in project mode to detect
   * new comments that should trigger a re-queue.
   */
  lastReadPrComments?: Record<number, string>;
  /**
   * Maps pull request number → numeric ids of comments yoke has posted on
   * that PR. Persisted so yoke never reads or parses its own comments.
   */
  postedCommentIds?: Record<number, number[]>;
}

/**
 * Key under which {@link SessionState.postedCommentIds} was persisted before
 * the vibrator → yoke rename. Read-only: a store written under the old key is
 * loaded transparently and migrated to `postedCommentIds` on its next write,
 * so the ids of comments posted before the rename are never lost.
 *
 * Legacy `vibratorCommentIds` key retained read-only since the 2026-09-17 rename (#237).
 */
const LEGACY_POSTED_COMMENT_IDS_KEY = "vibratorCommentIds";

/** {@link SessionState} as it may appear on disk, including the legacy key. */
type PersistedSessionState = SessionState & {
  [LEGACY_POSTED_COMMENT_IDS_KEY]?: SessionState["postedCommentIds"];
};

const MAX_PERSISTED_TERMINAL_SESSIONS = 200;

function nowIsoString(): string {
  return new Date().toISOString();
}

function isActiveSession(session: AgentSession): boolean {
  return session.status === "in_progress";
}

function getSessionSortTimestamp(session: AgentSession): number {
  return Date.parse(session.updatedAt);
}

function pruneSessions(sessions: AgentSession[]): AgentSession[] {
  const activeSessions = sessions.filter(isActiveSession);
  const terminalSessions = [...sessions]
    .filter((session) => !isActiveSession(session))
    .sort((left, right) => getSessionSortTimestamp(right) - getSessionSortTimestamp(left))
    .slice(0, MAX_PERSISTED_TERMINAL_SESSIONS);

  return [...activeSessions, ...terminalSessions].sort(
    (left, right) => getSessionSortTimestamp(left) - getSessionSortTimestamp(right),
  );
}

export class FileSessionStore {
  constructor(private readonly filePath: string) {}

  private async loadState(): Promise<SessionState> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(contents) as PersistedSessionState;
      const state: SessionState = { sessions: parsed.sessions ?? [] };
      if (parsed.lastReadPrComments && Object.keys(parsed.lastReadPrComments).length > 0) {
        state.lastReadPrComments = parsed.lastReadPrComments;
      }
      const postedCommentIds = parsed.postedCommentIds ?? parsed[LEGACY_POSTED_COMMENT_IDS_KEY];
      if (postedCommentIds && Object.keys(postedCommentIds).length > 0) {
        state.postedCommentIds = postedCommentIds;
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { sessions: [] };
      }

      throw error;
    }
  }

  private async writeState(state: SessionState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempFilePath = `${this.filePath}.${randomUUID()}.tmp`;
    const payload: SessionState = {
      sessions: pruneSessions(state.sessions),
      ...(state.lastReadPrComments && Object.keys(state.lastReadPrComments).length > 0
        ? { lastReadPrComments: state.lastReadPrComments }
        : {}),
      ...(state.postedCommentIds && Object.keys(state.postedCommentIds).length > 0
        ? { postedCommentIds: state.postedCommentIds }
        : {}),
    };
    await writeFile(tempFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await replaceFileCrossPlatform(tempFilePath, this.filePath);
  }

  async load(): Promise<AgentSession[]> {
    return (await this.loadState()).sessions;
  }

  async save(sessions: AgentSession[]): Promise<void> {
    const state = await this.loadState();
    await this.writeState({ ...state, sessions });
  }

  async createSession(input: {
    issueNumber?: number | undefined;
    pullRequestNumber?: number;
    phase: AgentSessionPhase;
    status?: AgentSessionStatus;
    result?: AgentSessionResult;
  }): Promise<AgentSession> {
    const sessions = await this.load();
    const createdAt = nowIsoString();
    const session: AgentSession = {
      id: randomUUID(),
      issueNumber: input.issueNumber,
      phase: input.phase,
      status: input.status ?? "in_progress",
      createdAt,
      updatedAt: createdAt,
    };
    if (input.pullRequestNumber !== undefined) {
      session.pullRequestNumber = input.pullRequestNumber;
    }
    if (input.result !== undefined) {
      session.result = input.result;
    }
    if (session.status === "completed" || session.status === "failed") {
      session.completedAt = createdAt;
    }
    sessions.push(session);
    await this.save(sessions);
    return session;
  }

  async completeSession(
    sessionId: string,
    result?: AgentSessionResult,
  ): Promise<AgentSession | undefined> {
    const sessions = await this.load();
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      return undefined;
    }

    const completedAt = nowIsoString();
    session.status = "completed";
    session.updatedAt = completedAt;
    session.completedAt = completedAt;
    if (result !== undefined) {
      session.result = result;
    }
    await this.save(sessions);
    return session;
  }

  async getLastReadCommentAt(pullRequestNumber: number): Promise<string | undefined> {
    const state = await this.loadState();
    return state.lastReadPrComments?.[pullRequestNumber];
  }

  async setLastReadCommentAt(pullRequestNumber: number, createdAt: string): Promise<void> {
    const state = await this.loadState();
    await this.writeState({
      ...state,
      lastReadPrComments: {
        ...(state.lastReadPrComments ?? {}),
        [pullRequestNumber]: createdAt,
      },
    });
  }

  /** Returns the ids of comments yoke has posted on the given PR. */
  async getPostedCommentIds(pullRequestNumber: number): Promise<number[]> {
    const state = await this.loadState();
    return state.postedCommentIds?.[pullRequestNumber] ?? [];
  }

  /** Records a comment id yoke has posted on the given PR. */
  async recordPostedCommentId(pullRequestNumber: number, commentId: number): Promise<void> {
    const state = await this.loadState();
    const existing = state.postedCommentIds?.[pullRequestNumber] ?? [];
    if (existing.includes(commentId)) {
      return;
    }
    await this.writeState({
      ...state,
      postedCommentIds: {
        ...(state.postedCommentIds ?? {}),
        [pullRequestNumber]: [...existing, commentId],
      },
    });
  }

  async failSession(sessionId: string): Promise<AgentSession | undefined> {
    const sessions = await this.load();
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      return undefined;
    }

    const failedAt = nowIsoString();
    session.status = "failed";
    session.updatedAt = failedAt;
    session.completedAt = failedAt;
    await this.save(sessions);
    return session;
  }
}
