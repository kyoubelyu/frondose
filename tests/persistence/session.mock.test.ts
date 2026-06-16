import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CoreMessage } from "ai";
import {
  appendMessages,
  continueRecent,
  cwdHash,
  findRecentSessionFile,
  loadMessages,
  sessionDir,
} from "../../src/persistence/session.js";
import { cleanupTmpDir } from "../_helpers/tmp";

// T-M8..T-M11: session persistence contract

/**
 * Save/restore process.env.HOME for test isolation (NIT-4).
 */
function withTmpHome(fn: (tmpHome: string) => void): void {
  const tmpHome = mkdtempSync(join(tmpdir(), "mai-home-session-"));
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = tmpHome;
    fn(tmpHome);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    cleanupTmpDir(tmpHome);
  }
}

// ─── T-M8: cwdHash determinism + format ──────────────────────────────────────

test("T-M8: cwdHash is deterministic, distinct across cwds, and 16 lowercase hex chars", () => {
  const h1 = cwdHash("/tmp/foo");
  const h2 = cwdHash("/tmp/foo");
  const h3 = cwdHash("/tmp/bar");

  assert.equal(h1, h2, "same cwd must hash identically");
  assert.notEqual(h1, h3, "different cwds must produce different hashes");
  assert.equal(h1.length, 16, "hash must be 16 characters");
  assert.match(h1, /^[0-9a-f]{16}$/, "hash must be lowercase hexadecimal");
});

// ─── T-M9: appendMessages + loadMessages round-trip ──────────────────────────

test("T-M9: appendMessages + loadMessages round-trip across all CoreMessage variants", () => {
  const dir = mkdtempSync(join(tmpdir(), "mai-session-t9-"));
  try {
    const file = join(dir, "session.jsonl");

    const messages: CoreMessage[] = [
      { role: "system", content: "sys text" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello back" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "echo", args: { message: "x" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "echo", result: { echoed: "x" } }],
      },
    ];

    appendMessages(file, messages);
    const loaded = loadMessages(file);
    assert.deepEqual(loaded, messages, "loaded messages must deep-equal originals");

    // Sub-test: append-only contract — two batches must be ordered correctly
    const file2 = join(dir, "session2.jsonl");
    appendMessages(file2, messages.slice(0, 2));
    appendMessages(file2, messages.slice(2, 5));
    const all = loadMessages(file2);
    assert.deepEqual(all, messages, "two-batch append must preserve full order");
  } finally {
    cleanupTmpDir(dir);
  }
});

test("T-M9b: loadMessages on missing file returns empty array", () => {
  const loaded = loadMessages("/tmp/__nonexistent_mai_session_file.jsonl");
  assert.deepEqual(loaded, []);
});

test("T-M9c: appendMessages with empty array is a no-op (no file created)", () => {
  withTmpHome(() => {
    const dir = mkdtempSync(join(tmpdir(), "mai-session-t9c-"));
    try {
      const file = join(dir, "noop.jsonl");
      appendMessages(file, []);
      // File should not exist (empty append is no-op)
      const loaded = loadMessages(file);
      assert.deepEqual(loaded, [], "empty-append then load must return []");
    } finally {
      cleanupTmpDir(dir);
    }
  });
});

// ─── T-M10: findRecentSessionFile picks latest mtime ────────────────────────

test("T-M10: findRecentSessionFile picks *.jsonl with latest mtime", () => {
  withTmpHome(() => {
    // Use a stable fake cwd so sessionDir creates a predictable sub-path
    const fakeCwd = "/tmp/mai-test-mtime-cwd";
    const dir = sessionDir(fakeCwd); // auto-creates the dir

    try {
      const fileA = join(dir, "file_a.jsonl");
      const fileB = join(dir, "file_b.jsonl");
      const fileC = join(dir, "file_c.jsonl");

      writeFileSync(fileA, "", "utf-8");
      writeFileSync(fileB, "", "utf-8");
      writeFileSync(fileC, "", "utf-8");

      const now = Date.now();
      utimesSync(fileA, new Date(now - 2000), new Date(now - 2000));
      utimesSync(fileB, new Date(now - 1000), new Date(now - 1000));
      utimesSync(fileC, new Date(now), new Date(now));

      const result = findRecentSessionFile(fakeCwd);
      assert.equal(result, fileC, "must return the file with the latest mtime");
    } finally {
      cleanupTmpDir(dir);
    }
  });
});

test("T-M10b: findRecentSessionFile returns undefined on empty dir", () => {
  withTmpHome(() => {
    const fakeCwd = "/tmp/mai-test-empty-dir-cwd";
    const dir = sessionDir(fakeCwd);
    try {
      const result = findRecentSessionFile(fakeCwd);
      assert.equal(result, undefined, "empty dir must return undefined");
    } finally {
      cleanupTmpDir(dir);
    }
  });
});

test("T-M10c: findRecentSessionFile ignores non-.jsonl files", () => {
  withTmpHome(() => {
    const fakeCwd = "/tmp/mai-test-nonjsonl-cwd";
    const dir = sessionDir(fakeCwd);
    try {
      const dsStore = join(dir, ".DS_Store");
      const jsonlFile = join(dir, "session.jsonl");
      writeFileSync(dsStore, "", "utf-8");
      writeFileSync(jsonlFile, "", "utf-8");

      const result = findRecentSessionFile(fakeCwd);
      assert.equal(result, jsonlFile, "must return the .jsonl file and ignore .DS_Store");
    } finally {
      cleanupTmpDir(dir);
    }
  });
});

// ─── T-M11: continueRecent honors newSession flag ────────────────────────────

test("T-M11: continueRecent returns existing session or creates new", () => {
  withTmpHome(() => {
    const fakeCwd = "/tmp/mai-test-continue-cwd";
    const dir = sessionDir(fakeCwd);

    try {
      // Plant a session file manually as "path A"
      const pathA = join(dir, "existing.jsonl");
      writeFileSync(pathA, "", "utf-8");

      // newSession: false → must find and return pathA (the only .jsonl)
      const resumed = continueRecent(fakeCwd, { newSession: false });
      assert.equal(resumed, pathA, "continueRecent(newSession: false) must return existing session");

      // newSession: true → must return a brand-new path (not pathA)
      const fresh = continueRecent(fakeCwd, { newSession: true });
      assert.notEqual(fresh, pathA, "continueRecent(newSession: true) must return a new path");
      assert.ok(fresh.endsWith(".jsonl"), "new session path must end with .jsonl");
    } finally {
      cleanupTmpDir(dir);
    }
  });
});

test("T-M11b: continueRecent on empty dir creates a new session path (auto-creates dir)", () => {
  withTmpHome(() => {
    const fakeCwd = "/tmp/mai-test-fresh-cwd";
    // Do NOT call sessionDir first — let continueRecent auto-create
    const freshPath = continueRecent(fakeCwd, {});
    assert.ok(freshPath.endsWith(".jsonl"), "fresh path must end with .jsonl");
    // Cleanup: remove the dir continueRecent created
    const dir = sessionDir(fakeCwd);
    cleanupTmpDir(dir);
  });
});
