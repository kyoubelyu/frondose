/**
 * P-25 Step 5 — T-SRV.SESS.1..3
 *
 * Tests for server session file helpers.
 * Gate coverage: G-P25.1
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { CoreMessage } from "ai";
import { appendServerSession, loadServerSession, serverSessionFile } from "../../src/persistence/serverSession.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p25-srvsess-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

// ─── T-SRV.SESS ───────────────────────────────────────────────────────────────

describe("serverSession helpers (G-P25.1)", () => {
  it("T-SRV.SESS.1: serverSessionFile() returns path under server sessions dir; auto-creates parent dir; no cwdHash", () => {
    // Given: server sessions dir does NOT exist; process.env.HOME overridden to tmp
    // When:  serverSessionFile() called
    // Then:  returned path ends in .jsonl; parent dir is auto-created; no cwdHash in path
    const { dir, cleanup } = makeTmpDir();
    const savedHome = process.env.HOME;
    const savedHomeBase = process.env.FRONDOSE_HOME_BASE;
    try {
      process.env.HOME = dir;
      process.env.FRONDOSE_HOME_BASE = dir;
      const filePath = serverSessionFile();
      // Ends in .jsonl
      assert.ok(filePath.endsWith(".jsonl"), `path must end in .jsonl, got: ${filePath}`);
      // Parent dir auto-created
      assert.ok(existsSync(dirname(filePath)), `sessions dir must be auto-created at ${dirname(filePath)}`);
      // Path is under the tmp dir (HOME override worked)
      assert.ok(filePath.startsWith(dir), `path must be under tmpDir ${dir}, got: ${filePath}`);
      // Path contains "sessions" directory
      assert.ok(filePath.includes("sessions"), `path must contain 'sessions/', got: ${filePath}`);
      // No cwdHash — file is directly under sessions/, not in a subdirectory.
      // Worker sessions use ~/.mai/agent/sessions/<cwdHash>/<ts>.jsonl (2-level nesting);
      // server sessions use ~/.mai/server/sessions/<ts>.jsonl (flat, 1-level).
      // Check: basename(dirname(filePath)) === "sessions"
      assert.equal(
        basename(dirname(filePath)),
        "sessions",
        `file must be directly under sessions/ directory, no cwdHash subdir; got: ${filePath}`,
      );
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedHomeBase === undefined) delete process.env.FRONDOSE_HOME_BASE;
      else process.env.FRONDOSE_HOME_BASE = savedHomeBase;
      cleanup();
    }
  });

  it("T-SRV.SESS.2: loadServerSession returns array of CoreMessage objects from existing JSONL", () => {
    // Given: JSONL file with 2 message lines (user + assistant)
    // When:  loadServerSession(path)
    // Then:  returns array of 2 CoreMessage objects with correct role + content
    const { dir, cleanup } = makeTmpDir();
    try {
      const sessionPath = join(dir, "test-session.jsonl");
      const msg1: CoreMessage = { role: "user", content: "hello" };
      const msg2: CoreMessage = { role: "assistant", content: "world" };
      writeFileSync(sessionPath, `${JSON.stringify(msg1)}\n${JSON.stringify(msg2)}\n`, "utf-8");

      const messages = loadServerSession(sessionPath);
      assert.equal(messages.length, 2, "must return 2 messages");
      assert.equal(messages[0].role, "user", "first message role must be 'user'");
      assert.equal(messages[0].content, "hello", "first message content must be 'hello'");
      assert.equal(messages[1].role, "assistant", "second message role must be 'assistant'");
      assert.equal(messages[1].content, "world", "second message content must be 'world'");
    } finally {
      cleanup();
    }
  });

  it("T-SRV.SESS.3: appendServerSession appends lines to file via appendFileSync (O_APPEND semantics)", () => {
    // Given: existing session file with 1 message
    // When:  appendServerSession(path, [newMsg]) called
    // Then:  file now has 2 lines; newMsg readable via loadServerSession
    const { dir, cleanup } = makeTmpDir();
    try {
      const sessionPath = join(dir, "append-test.jsonl");
      const existing: CoreMessage = { role: "user", content: "first" };
      const newMsg: CoreMessage = { role: "assistant", content: "second" };
      writeFileSync(sessionPath, `${JSON.stringify(existing)}\n`, "utf-8");

      appendServerSession(sessionPath, [newMsg]);

      const messages = loadServerSession(sessionPath);
      assert.equal(messages.length, 2, "must have 2 messages after append");
      assert.equal(messages[0].content, "first", "original message preserved");
      assert.equal(messages[1].content, "second", "appended message present");
    } finally {
      cleanup();
    }
  });
});
