/**
 * P-23 Step 4a scaffold — T-LOCK.1..4, T-PIDFILE.1..3
 *
 * Process-lock helpers: acquireTurnLock / releaseTurnLock (O_EXCL advisory turn.lock)
 * and PID-file helpers: writePid / readPid / removePid / isPidAlive / isAlive.
 * (src/persistence/processLock.ts — NEW at builder Step 4b per plan §6.2.)
 *
 * Gate coverage: G-P23.4, G-P23.6
 *
 * All assertion bodies are TODO. Builder must make scaffolds reach assert.fail at Step 4b.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  acquireTurnLock,
  isAlive,
  isPidAlive,
  LockBusy,
  readPid,
  releaseTurnLock,
  removePid,
  writePid,
} from "../../src/persistence/processLock.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p23-lock-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── Turn lock ────────────────────────────────────────────────────────────────

describe("processLock: acquireTurnLock / releaseTurnLock", () => {
  it("T-LOCK.1: when turn.lock absent, acquireTurnLock returns handle; lock file exists", async () => {
    // Given: no turn.lock file on disk in a fresh tmp dir
    // When:  acquireTurnLock(lockPath, 'daemon') is called
    // Then:  returns a LockHandle; lock file exists; file contents JSON = {owner, pid, ts}
    const { dir, cleanup } = makeTmpDir();
    try {
      const lockPath = join(dir, "turn.lock");
      const handle = await acquireTurnLock(lockPath, "daemon");
      assert.ok(existsSync(lockPath), "lock file must be created");
      const meta = JSON.parse(readFileSync(lockPath, "utf-8"));
      assert.strictEqual(meta.owner, "daemon");
      assert.strictEqual(meta.pid, process.pid);
      assert.ok(typeof meta.ts === "string");
      // cleanup: release before directory removal
      releaseTurnLock(handle);
    } finally {
      cleanup();
    }
  });

  it("T-LOCK.2: when turn.lock held by another process, acquireTurnLock throws LockBusy after timeout", async () => {
    // Given: turn.lock file exists, contents = {owner: 'other', pid: <current process.pid>, ts}
    // When:  acquireTurnLock called with timeoutMs=100
    // Then:  throws LockBusy with owner='other' within ~100 ms
    const { dir, cleanup } = makeTmpDir();
    try {
      const lockPath = join(dir, "turn.lock");
      // Simulate a lock held by current PID (alive)
      writeFileSync(
        lockPath,
        JSON.stringify({ owner: "other", pid: process.pid, ts: new Date().toISOString() }),
        "utf-8",
      );
      await assert.rejects(
        () => acquireTurnLock(lockPath, "acquirer", { timeoutMs: 150, pollMs: 10 }),
        (err: unknown) => {
          assert.ok(err instanceof LockBusy, `expected LockBusy, got ${String(err)}`);
          assert.strictEqual((err as LockBusy).owner, "other");
          return true;
        },
      );
    } finally {
      cleanup();
    }
  });

  it("T-LOCK.3: when turn.lock held by a stale PID, acquireTurnLock reaps and acquires", async () => {
    // Given: turn.lock exists with pid=-999999 (guaranteed dead; isAlive returns false for pid<=0)
    // When:  acquireTurnLock is called
    // Then:  old lock reaped; new LockHandle returned with current process.pid
    const { dir, cleanup } = makeTmpDir();
    try {
      const lockPath = join(dir, "turn.lock");
      writeFileSync(lockPath, JSON.stringify({ owner: "stale", pid: -999999, ts: new Date().toISOString() }), "utf-8");
      const handle = await acquireTurnLock(lockPath, "new-owner");
      assert.ok(existsSync(lockPath));
      const meta = JSON.parse(readFileSync(lockPath, "utf-8"));
      assert.strictEqual(meta.owner, "new-owner");
      assert.strictEqual(meta.pid, process.pid);
      releaseTurnLock(handle);
    } finally {
      cleanup();
    }
  });

  it("T-LOCK.4: when held lock handle released, subsequent acquire from another caller succeeds", async () => {
    // Given: lock acquired successfully, handle returned
    // When:  releaseTurnLock(handle) called; then a second acquireTurnLock for same path
    // Then:  lock file removed after release; second acquire returns a valid handle
    const { dir, cleanup } = makeTmpDir();
    try {
      const lockPath = join(dir, "turn.lock");
      const h1 = await acquireTurnLock(lockPath, "first");
      releaseTurnLock(h1);
      // Lock file must be gone
      assert.ok(!existsSync(lockPath), "lock file must be removed after release");
      // Second acquire must succeed
      const h2 = await acquireTurnLock(lockPath, "second");
      assert.ok(existsSync(lockPath));
      const meta = JSON.parse(readFileSync(lockPath, "utf-8"));
      assert.strictEqual(meta.owner, "second");
      releaseTurnLock(h2);
    } finally {
      cleanup();
    }
  });
});

// ─── PID file helpers ──────────────────────────────────────────────────────────

describe("processLock: PID file helpers", () => {
  it("T-PIDFILE.1: when no repl.pid, writePid() creates file with current PID", () => {
    // Given: pidPath does not exist
    // When:  writePid(pidPath) is called
    // Then:  file created at pidPath; readPid(pidPath) === process.pid
    const { dir, cleanup } = makeTmpDir();
    try {
      const pidPath = join(dir, "repl.pid");
      writePid(pidPath);
      assert.ok(existsSync(pidPath));
      assert.strictEqual(readPid(pidPath), process.pid);
    } finally {
      cleanup();
    }
  });

  it("T-PIDFILE.2: when repl.pid contains a stale (dead) PID, isPidAlive() returns false", () => {
    // Given: pidPath contains PID -999999 (guaranteed dead; isAlive returns false for pid<=0)
    // When:  isPidAlive(pidPath) is called
    // Then:  returns false
    const { dir, cleanup } = makeTmpDir();
    try {
      const pidPath = join(dir, "repl.pid");
      writeFileSync(pidPath, "-999999", "utf-8");
      assert.strictEqual(isPidAlive(pidPath), false);
    } finally {
      cleanup();
    }
  });

  it("T-PIDFILE.3: when repl.pid contains a live PID (current process.pid), isPidAlive() returns true", () => {
    // Given: pidPath contains process.pid (the running test process — always alive)
    // When:  isPidAlive(pidPath) is called
    // Then:  returns true
    const { dir, cleanup } = makeTmpDir();
    try {
      const pidPath = join(dir, "repl.pid");
      writeFileSync(pidPath, String(process.pid), "utf-8");
      assert.strictEqual(isPidAlive(pidPath), true);
    } finally {
      cleanup();
    }
  });
});
