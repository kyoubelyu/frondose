/** P-23: pidfile + advisory turn-lock helpers (plan §6.2).
 * No native deps; atomicity from `O_EXCL` on POSIX.
 * DO NOT import this from src/tools/** (Hard Rule 8 amendment: CLI-layer only).
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

export interface LockHandle {
  path: string;
  pid: number;
  owner: string;
}

export class LockBusy extends Error {
  constructor(
    public owner: string,
    public ownerPid: number,
  ) {
    super(`turn lock held by ${owner} (PID ${ownerPid})`);
    this.name = "LockBusy";
  }
}

// ─── Liveness ─────────────────────────────────────────────────────────────────

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM: process exists but not ours — still "alive"
    if (code === "EPERM") return true;
    return false;
  }
}

// ─── PID file helpers ──────────────────────────────────────────────────────────

export function writePid(filePath: string): void {
  const fd = openSync(filePath, "w");
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeSync(fd);
  }
}

export function readPid(filePath: string): number | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function removePid(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export function isPidAlive(filePath: string): boolean {
  const pid = readPid(filePath);
  return pid !== null && isAlive(pid);
}

// ─── Turn lock (O_EXCL advisory) ─────────────────────────────────────────────

interface LockMeta {
  owner: string;
  pid: number;
  ts: string;
}

function readLockMeta(filePath: string): LockMeta | null {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as LockMeta;
  } catch {
    return null;
  }
}

/** Acquire the turn lock with retry until timeout. Reaps stale locks. */
export async function acquireTurnLock(
  filePath: string,
  owner: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<LockHandle> {
  // Step-3b C3: 60_000 ms default — accommodates DeepSeek slow tool-chain turns (40-50 s).
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 100;
  const start = Date.now();
  for (;;) {
    try {
      const fd = openSync(filePath, "wx"); // O_EXCL | O_CREAT | O_WRONLY
      try {
        const body = JSON.stringify({ owner, pid: process.pid, ts: new Date().toISOString() });
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      return { path: filePath, pid: process.pid, owner };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // Stale-reap path: if existing lock's PID is dead, remove and retry immediately.
      const existing = readLockMeta(filePath);
      if (existing && !isAlive(existing.pid)) {
        try {
          unlinkSync(filePath);
        } catch {
          // race: another acquirer reaped first — fine, loop retries.
        }
        continue;
      }
      if (Date.now() - start >= timeoutMs) {
        throw new LockBusy(existing?.owner ?? "unknown", existing?.pid ?? -1);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

export function releaseTurnLock(handle: LockHandle): void {
  // Defensive: only remove if we still own it.
  const meta = readLockMeta(handle.path);
  if (meta?.pid !== handle.pid) return;
  try {
    unlinkSync(handle.path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
