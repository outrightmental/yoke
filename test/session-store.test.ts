import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FileSessionStore, migrateLegacySessionStore } from "../src/session-store.js";

async function withTempStore<T>(
  callback: (store: FileSessionStore, filePath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "yoke-session-test-"));
  const filePath = join(dir, "sessions.json");
  const store = new FileSessionStore(filePath);
  try {
    return await callback(store, filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("FileSessionStore returns an empty session list when the file does not exist", async () => {
  await withTempStore(async (store) => {
    assert.deepEqual(await store.load(), []);
  });
});

test("FileSessionStore createSession persists a new in_progress session by default", async () => {
  await withTempStore(async (store) => {
    const session = await store.createSession({
      issueNumber: 7,
      phase: "implementation",
    });
    assert.equal(session.status, "in_progress");
    assert.equal(session.issueNumber, 7);
    const sessions = await store.load();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.id, session.id);
  });
});

test("FileSessionStore createSession can persist a completed session in one call", async () => {
  await withTempStore(async (store) => {
    const session = await store.createSession({
      issueNumber: 1,
      phase: "implementation",
      status: "completed",
      result: { pullRequestHeadSha: "sha-1" },
    });
    assert.equal(session.status, "completed");
    assert.equal(session.completedAt, session.createdAt);
    assert.deepEqual(session.result, { pullRequestHeadSha: "sha-1" });
  });
});

test("FileSessionStore completeSession transitions an in_progress session", async () => {
  await withTempStore(async (store) => {
    const created = await store.createSession({
      issueNumber: 1,
      phase: "self-review",
    });
    const updated = await store.completeSession(created.id, { madeChanges: true });
    assert.ok(updated);
    assert.equal(updated!.status, "completed");
    assert.equal(updated!.result?.madeChanges, true);
  });
});

test("FileSessionStore failSession marks a session failed", async () => {
  await withTempStore(async (store) => {
    const created = await store.createSession({
      issueNumber: 1,
      phase: "implementation",
    });
    const failed = await store.failSession(created.id);
    assert.ok(failed);
    assert.equal(failed!.status, "failed");
    assert.ok(failed!.completedAt);
  });
});

test("FileSessionStore writes valid JSON to disk", async () => {
  await withTempStore(async (store, filePath) => {
    await store.createSession({ issueNumber: 1, phase: "implementation" });
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text) as { sessions: unknown[] };
    assert.equal(parsed.sessions.length, 1);
  });
});

test("FileSessionStore preserves multiple terminal sessions with the same key", async () => {
  await withTempStore(async (store) => {
    // Two terminal sessions with the same key — both should survive
    // so the orchestrator can detect consecutive clean self-reviews.
    const older = await store.createSession({
      issueNumber: 1,
      phase: "self-review",
      status: "completed",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await store.createSession({
      issueNumber: 1,
      phase: "self-review",
      status: "completed",
    });
    const sessions = await store.load();
    const reviewSessions = sessions.filter(
      (s) => s.issueNumber === 1 && s.phase === "self-review",
    );
    assert.equal(reviewSessions.length, 2);
    assert.ok(reviewSessions.some((s) => s.id === older.id));
    assert.ok(reviewSessions.some((s) => s.id === newer.id));
  });
});

test("FileSessionStore preserves active sessions through writes", async () => {
  await withTempStore(async (store) => {
    const active = await store.createSession({
      issueNumber: 5,
      phase: "implementation",
    });
    // Add unrelated terminal sessions
    await store.createSession({
      issueNumber: 6,
      phase: "self-review",
      status: "completed",
    });
    const sessions = await store.load();
    assert.ok(sessions.some((s) => s.id === active.id));
  });
});

test("FileSessionStore getLastReadCommentAt returns undefined when nothing recorded", async () => {
  await withTempStore(async (store) => {
    const result = await store.getLastReadCommentAt(42);
    assert.equal(result, undefined);
  });
});

test("FileSessionStore setLastReadCommentAt persists and getLastReadCommentAt retrieves it", async () => {
  await withTempStore(async (store) => {
    await store.setLastReadCommentAt(10, "2024-06-01T12:00:00.000Z");
    const result = await store.getLastReadCommentAt(10);
    assert.equal(result, "2024-06-01T12:00:00.000Z");
  });
});

test("FileSessionStore getPostedCommentIds returns an empty array when nothing recorded", async () => {
  await withTempStore(async (store) => {
    assert.deepEqual(await store.getPostedCommentIds(42), []);
  });
});

test("FileSessionStore recordPostedCommentId persists ids per PR without duplicates", async () => {
  await withTempStore(async (store) => {
    await store.recordPostedCommentId(10, 1001);
    await store.recordPostedCommentId(10, 1002);
    await store.recordPostedCommentId(10, 1001); // duplicate — ignored
    await store.recordPostedCommentId(11, 2001);

    assert.deepEqual(await store.getPostedCommentIds(10), [1001, 1002]);
    assert.deepEqual(await store.getPostedCommentIds(11), [2001]);
  });
});

test("FileSessionStore persists posted comment ids under the postedCommentIds key", async () => {
  await withTempStore(async (store, filePath) => {
    await store.recordPostedCommentId(10, 1001);
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(parsed.postedCommentIds, { "10": [1001] });
  });
});

test("FileSessionStore reads posted comment ids persisted under the legacy vibratorCommentIds key and migrates them on write", async () => {
  await withTempStore(async (store, filePath) => {
    // A store written before the vibrator → yoke rename (#237). The old key is
    // written out literally on purpose: it pins the on-disk format that
    // existing deployments already carry.
    await writeFile(
      filePath,
      JSON.stringify({
        sessions: [],
        lastReadPrComments: { "10": "2024-06-01T12:00:00.000Z" },
        vibratorCommentIds: { "10": [1001], "11": [2001] },
      }),
      "utf8",
    );

    assert.deepEqual(await store.getPostedCommentIds(10), [1001]);
    assert.deepEqual(await store.getPostedCommentIds(11), [2001]);

    await store.recordPostedCommentId(10, 1002);

    assert.deepEqual(await store.getPostedCommentIds(10), [1001, 1002]);
    assert.deepEqual(await store.getPostedCommentIds(11), [2001]);
    assert.equal(await store.getLastReadCommentAt(10), "2024-06-01T12:00:00.000Z");

    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(parsed.postedCommentIds, { "10": [1001, 1002], "11": [2001] });
    assert.equal("vibratorCommentIds" in parsed, false, "the legacy key is never written back");
  });
});

test("FileSessionStore setLastReadCommentAt preserves existing sessions when updating", async () => {
  await withTempStore(async (store) => {
    await store.createSession({ issueNumber: 1, phase: "implementation", status: "completed" });
    await store.setLastReadCommentAt(5, "2024-06-01T00:00:00.000Z");
    const sessions = await store.load();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.issueNumber, 1);
  });
});

test("FileSessionStore setLastReadCommentAt updates existing timestamp for same PR", async () => {
  await withTempStore(async (store) => {
    await store.setLastReadCommentAt(10, "2024-06-01T00:00:00.000Z");
    await store.setLastReadCommentAt(10, "2024-06-02T00:00:00.000Z");
    const result = await store.getLastReadCommentAt(10);
    assert.equal(result, "2024-06-02T00:00:00.000Z");
  });
});

test("FileSessionStore createSession preserves lastReadPrComments", async () => {
  await withTempStore(async (store) => {
    await store.setLastReadCommentAt(10, "2024-06-01T12:00:00.000Z");
    await store.createSession({ issueNumber: 1, phase: "request-review", status: "completed" });
    const result = await store.getLastReadCommentAt(10);
    assert.equal(result, "2024-06-01T12:00:00.000Z", "createSession must not erase lastReadPrComments");
  });
});

test("FileSessionStore completeSession preserves lastReadPrComments", async () => {
  await withTempStore(async (store) => {
    const session = await store.createSession({ issueNumber: 1, phase: "self-review" });
    await store.setLastReadCommentAt(10, "2024-06-01T12:00:00.000Z");
    await store.completeSession(session.id, { madeChanges: false });
    const result = await store.getLastReadCommentAt(10);
    assert.equal(result, "2024-06-01T12:00:00.000Z", "completeSession must not erase lastReadPrComments");
  });
});

// ─── migrateLegacySessionStore (vibrator → yoke default path move, #237) ─────

async function withTempDir<T>(callback: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "yoke-session-migrate-test-"));
  try {
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("migrateLegacySessionStore moves a legacy store into place when nothing exists at the current path", async () => {
  await withTempDir(async (dir) => {
    const legacyPath = join(dir, ".vibrator", "owner-repo-sessions.json");
    const currentPath = join(dir, ".yoke", "owner-repo-sessions.json");
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ sessions: [], lastReadPrComments: { "10": "2024-06-01T12:00:00.000Z" } }), "utf8");

    assert.equal(migrateLegacySessionStore(currentPath, legacyPath), true);

    assert.equal(existsSync(legacyPath), false, "the legacy file is moved, not copied");
    assert.equal(existsSync(currentPath), true);
    // The phase history survives the move: the store at the new path reads it back.
    const store = new FileSessionStore(currentPath);
    assert.equal(await store.getLastReadCommentAt(10), "2024-06-01T12:00:00.000Z");
  });
});

test("migrateLegacySessionStore never overwrites a store that already exists at the current path", async () => {
  await withTempDir(async (dir) => {
    const legacyPath = join(dir, ".vibrator", "owner-repo-sessions.json");
    const currentPath = join(dir, ".yoke", "owner-repo-sessions.json");
    await mkdir(dirname(legacyPath), { recursive: true });
    await mkdir(dirname(currentPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ sessions: [], lastReadPrComments: { "10": "legacy" } }), "utf8");
    await writeFile(currentPath, JSON.stringify({ sessions: [], lastReadPrComments: { "10": "current" } }), "utf8");

    assert.equal(migrateLegacySessionStore(currentPath, legacyPath), false);

    assert.equal(existsSync(legacyPath), true, "the legacy file is left alone");
    const store = new FileSessionStore(currentPath);
    assert.equal(await store.getLastReadCommentAt(10), "current");
  });
});

test("migrateLegacySessionStore is a no-op when there is no legacy store", async () => {
  await withTempDir(async (dir) => {
    const legacyPath = join(dir, ".vibrator", "owner-repo-sessions.json");
    const currentPath = join(dir, ".yoke", "owner-repo-sessions.json");

    assert.equal(migrateLegacySessionStore(currentPath, legacyPath), false);

    assert.equal(existsSync(currentPath), false);
    assert.equal(existsSync(dirname(currentPath)), false, "no directory is created for nothing");
  });
});
