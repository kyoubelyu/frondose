/**
 * P-30 Step 4a — T-SHARE.1
 *
 * Integration test for cross-terminal session sharing (P-23 invariant).
 * D-10: NO new runtime code — tests the existing acquireTurnLock +
 * appendMessagesShared + loadMessagesShared primitives under concurrent load.
 *
 * Gate coverage:
 *   T-SHARE.1 — G-P30.16: two concurrent callers under acquireTurnLock serialize;
 *               the JSONL contains all 10 messages with no torn/interleaved lines;
 *               the second caller blocks until the first releases the lock.
 *
 * Scaffold: assertion bodies are TODO — all tests intentionally fail.
 * Assertion bodies will be filled at Step 5.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CoreMessage } from "ai";
import { acquireTurnLock, releaseTurnLock } from "../../src/persistence/processLock.js";
import { appendMessagesShared, loadMessagesShared } from "../../src/persistence/sharedSession.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p30-share-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeMessages(prefix: string, count: number): CoreMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: "user" as const,
    content: `${prefix}-msg-${i}`,
  }));
}

// ─── T-SHARE.1 ────────────────────────────────────────────────────────────────

describe("T-SHARE: cross-terminal session sharing (G-P30.16)", () => {
  it("T-SHARE.1: two concurrent acquireTurnLock callers — second blocks until first releases; JSONL contains all 10 messages with no torn lines", async () => {
    // Given: a tmp shared-session JSONL path + a tmp lock file path
    // When:  caller-A acquires turn lock, holds it for 100ms (artificial delay), appends 5 messages, releases;
    //        caller-B tries to acquire concurrently (will block), then appends 5 messages once unblocked
    // Then:  loadMessagesShared returns exactly 10 messages;
    //        every line in the JSONL is valid JSON (no torn/interleaved writes);
    //        caller-B's acquireTurnLock resolved only AFTER caller-A called releaseTurnLock

    const { dir, cleanup } = makeTmpDir();
    try {
      const jsonlPath = join(dir, "active.jsonl");
      const lockPath = join(dir, "turn.lock");

      const msgsA = makeMessages("A", 5);
      const msgsB = makeMessages("B", 5);

      let callerAReleasedAt = -1;
      let callerBAcquiredAt = -1;

      const callerA = async () => {
        const handle = await acquireTurnLock(lockPath, "caller-A", { timeoutMs: 5000, pollMs: 10 });
        // Artificial hold delay to force B to wait
        await new Promise((r) => setTimeout(r, 100));
        appendMessagesShared(jsonlPath, msgsA);
        callerAReleasedAt = Date.now();
        releaseTurnLock(handle);
      };

      const callerB = async () => {
        // Small delay to ensure A acquires first
        await new Promise((r) => setTimeout(r, 10));
        const handle = await acquireTurnLock(lockPath, "caller-B", { timeoutMs: 5000, pollMs: 10 });
        callerBAcquiredAt = Date.now();
        appendMessagesShared(jsonlPath, msgsB);
        releaseTurnLock(handle);
      };

      await Promise.all([callerA(), callerB()]);

      const loaded = loadMessagesShared(jsonlPath);

      // All 10 messages loaded
      assert.equal(loaded.length, 10, `T-SHARE.1: must load exactly 10 messages; got ${loaded.length}`);

      // Every line in the JSONL is valid JSON (no torn/interleaved writes)
      const { readFileSync } = await import("node:fs");
      const rawLines = readFileSync(jsonlPath, "utf-8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      assert.equal(rawLines.length, 10, "T-SHARE.1: JSONL must have exactly 10 non-empty lines");
      for (const line of rawLines) {
        assert.doesNotThrow(
          () => JSON.parse(line),
          `T-SHARE.1: every JSONL line must be valid JSON; line: ${line.slice(0, 80)}`,
        );
      }

      // caller-B acquired AFTER caller-A released (serialization guarantee)
      assert.ok(callerAReleasedAt > 0, "T-SHARE.1: callerAReleasedAt must be set");
      assert.ok(callerBAcquiredAt > 0, "T-SHARE.1: callerBAcquiredAt must be set");
      assert.ok(
        callerBAcquiredAt >= callerAReleasedAt,
        `T-SHARE.1: callerB must acquire AFTER callerA releases; A released at ${callerAReleasedAt}, B acquired at ${callerBAcquiredAt}`,
      );
    } finally {
      cleanup();
    }
  });
});
