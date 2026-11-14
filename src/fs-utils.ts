import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readdir, rename, rm, statfs } from "node:fs/promises";
import { join } from "node:path";

const WINDOWS_RENAME_CONFLICT_ERROR_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

export async function replaceFileCrossPlatform(tempPath: string, finalPath: string): Promise<void> {
  try {
    await rename(tempPath, finalPath);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !WINDOWS_RENAME_CONFLICT_ERROR_CODES.has(code)) {
      throw error;
    }
  }

  const backupPath = `${finalPath}.${randomUUID()}.bak`;
  let backupCreated = false;
  try {
    try {
      await rename(finalPath, backupPath);
      backupCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(tempPath, finalPath);
  } catch (error) {
    if (backupCreated) {
      try { await rename(backupPath, finalPath); } catch { /* best effort */ }
    }
    await rm(tempPath, { force: true });
    throw error;
  }
  if (backupCreated) {
    try { await rm(backupPath, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Bytes free to an unprivileged user on the filesystem holding `path` — what
 * `df` reports as "Avail" — or undefined when it cannot be read (`statfs` is
 * missing on this Node, or the path is gone).
 */
export async function readFreeBytes(path: string): Promise<number | undefined> {
  try {
    const stats = await statfs(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

/**
 * Disk space a directory tree takes up, in bytes, without following symlinks.
 * Uses `du -sk` where there is one, which is much faster than walking a large
 * `node_modules` from JavaScript, and falls back to a walk where there is not
 * (Windows) or it fails. A tree that vanishes partway counts as what was seen.
 */
export async function measureDirectoryBytes(dir: string): Promise<number> {
  if (process.platform !== "win32") {
    const kib = await new Promise<number | undefined>((resolve) => {
      execFile("du", ["-sk", dir], { timeout: 10 * 60_000 }, (error, stdout) => {
        const value = Number.parseInt(String(stdout).trim().split(/\s+/)[0] ?? "", 10);
        // du exits 1 when a file vanished or was unreadable mid-walk, but still
        // prints its total; only a missing number means it told us nothing.
        resolve(Number.isFinite(value) ? value : error ? undefined : 0);
      });
    });
    if (kib !== undefined) return kib * 1024;
  }
  return walkDirectoryBytes(dir);
}

async function walkDirectoryBytes(dir: string): Promise<number> {
  let total = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      try {
        const stats = await lstat(path);
        total += stats.blocks > 0 ? stats.blocks * 512 : stats.size;
      } catch {
        // Gone already: nothing to count.
      }
    }
  }
  return total;
}

/** "1.4 GB", "312 MB", "18 KB": binary units, as `df -h` and `du -h` count them. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/, "")} ${units[unit]}`;
}
