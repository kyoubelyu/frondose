import { closeSync, existsSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getHomeBase } from "../../persistence/paths.js";

const UPDATE_LOCK = (): string => join(getHomeBase(), ".mai", "agent", "update.lock");
// Step-3b C3: 45 min provides ~24.5 min margin over worst-case 20-min cold-cache
// `npm install` + 15s build. Eliminates false-takeover-then-duplicate-build.
const LOCK_STALE_MS = 45 * 60 * 1000;

// §6.6: file lock ────────────────────────────────────────────────────────────

export function acquireUpdateLock(nowMs: number): number {
  const lockPath = UPDATE_LOCK();
  mkdirSync(dirname(lockPath), { recursive: true });
  // Stale-lock reaper: if existing lock is older than LOCK_STALE_MS, drop it.
  if (existsSync(lockPath)) {
    try {
      const st = statSync(lockPath);
      if (nowMs - st.mtimeMs > LOCK_STALE_MS) {
        unlinkSync(lockPath);
      }
    } catch {
      // stat/unlink race — let openSync resolve atomically below.
    }
  }
  // O_EXCL | O_CREAT | O_WRONLY: atomic. EEXIST = lock held.
  return openSync(lockPath, "wx");
}

export function releaseUpdateLock(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // fd already closed (e.g. re-exec path) — ignore.
  }
  try {
    unlinkSync(UPDATE_LOCK());
  } catch {
    // lock already unlinked — ignore.
  }
}
