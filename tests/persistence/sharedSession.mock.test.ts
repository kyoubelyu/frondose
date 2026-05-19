/**
 * P-23 Step 4a scaffold — T-SHARED.1..3
 *
 * Shared session JSONL: path resolver + flock-protected append/load.
 * (src/persistence/sharedSession.ts — NEW at builder Step 4b per plan §6.6.)
 *
 * Gate coverage: G-P23.5, G-P23.12
 *
 * All assertion bodies are TODO. Builder must make scaffolds reach assert.fail at Step 4b.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { appendMessagesShared, loadMessagesShared, sharedSessionPath } from "../../src/persistence/sharedSession.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "mai-p23-shsession-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

// ─── Shared session tests ─────────────────────────────────────────────────────

describe("sharedSession: path resolver + append + load", () => {
  it("T-SHARED.1: when called, sharedSessionPath returns ~/.mai/agent/sessions/shared/active.jsonl", () => {
    // Given:  HOME env set to isolated tmpHome
    // When:   sharedSessionPath() called
    // Then:   returned path ends with 'sessions/shared/active.jsonl'; dir is created if absent
    const { home, cleanup } = makeTmpHome();
    const origHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const p = sharedSessionPath();
      assert.ok(p.endsWith("sessions/shared/active.jsonl"), `expected shared path suffix, got: ${p}`);
      // sharedSessionPath creates the directory on first call
      assert.ok(existsSync(dirname(p)), "sessions/shared directory must be created");
    } finally {
      process.env.HOME = origHome;
      cleanup();
    }
  });

  it("T-SHARED.2: appendMessagesShared writes CoreMessages as JSONL; loadMessagesShared round-trips them", () => {
    // Given:  a writable file path in a tmp dir
    // When:   appendMessagesShared(path, [{role:'user', content:'hello'}]) called
    // Then:   loadMessagesShared(path) returns [{ role:'user', content:'hello' }]
    const { home, cleanup } = makeTmpHome();
    try {
      const filePath = join(home, "active.jsonl");
      const messages = [{ role: "user" as const, content: "hello" }];
      appendMessagesShared(filePath, messages);
      const loaded = loadMessagesShared(filePath);
      assert.strictEqual(loaded.length, 1);
      assert.strictEqual(loaded[0]?.role, "user");
      assert.strictEqual(loaded[0]?.content, "hello");
    } finally {
      cleanup();
    }
  });

  it("T-SHARED.3: two sequential appendMessagesShared calls both persist; no lines lost or duplicated", () => {
    // Given:  empty active.jsonl; two callers each append one message sequentially
    // When:   appendMessagesShared x2 with distinct messages
    // Then:   loadMessagesShared returns both messages in order; no interleaving of JSON
    const { home, cleanup } = makeTmpHome();
    try {
      const filePath = join(home, "active.jsonl");
      appendMessagesShared(filePath, [{ role: "user" as const, content: "first" }]);
      appendMessagesShared(filePath, [{ role: "assistant" as const, content: "second" }]);
      const loaded = loadMessagesShared(filePath);
      assert.strictEqual(loaded.length, 2, "must have both messages without duplication");
      assert.strictEqual(loaded[0]?.content, "first");
      assert.strictEqual(loaded[1]?.content, "second");
    } finally {
      cleanup();
    }
  });
});
