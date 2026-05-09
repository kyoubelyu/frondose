/**
 * P-7 mock tests — T-Sessions6..T-Sessions7: session.ts P-7 additions.
 *
 * Tests:
 *   T-Sessions6 — sessionDir() writes cwd.txt companion on fresh hash dir creation
 *   T-Sessions7 — listAllSessions() reads cwd.txt for cwdLabel; pre-P-7 dir without
 *                 cwd.txt shows cwdHash as fallback
 *
 * No Chrome, no LLM required.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cwdHash, listAllSessions, sessionDir } from "../../src/persistence/session.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Redirect SESSIONS_ROOT to a temp dir for isolation. Returns restore fn. */
function withTmpSessionsRoot(): { tmpRoot: string; restore: () => void } {
  const tmpRoot = mkdtempSync(join(tmpdir(), "mai-p7-sessions-"));
  const prevHome = process.env.HOME;
  // SESSIONS_ROOT() = join(homedir(), ".mai", "agent", "sessions")
  // We can't easily override it without patching the module, so we point
  // process.env.HOME at a tmp dir that mirrors the structure.
  // The actual sessions root will be: tmpRoot/.mai/agent/sessions
  const fakeHome = mkdtempSync(join(tmpdir(), "mai-p7-fakehome-"));
  process.env.HOME = fakeHome;
  return {
    tmpRoot: fakeHome,
    restore: () => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(tmpRoot, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    },
  };
}

// ─── T-Sessions6 — sessionDir writes cwd.txt ─────────────────────────────────

test("T-Sessions6: sessionDir() writes cwd.txt with the cwd path on first creation", () => {
  const { tmpRoot, restore } = withTmpSessionsRoot();
  try {
    const testCwd = "/tmp/test-project-abc";
    const dir = sessionDir(testCwd);

    assert.ok(existsSync(dir), "T-Sessions6: sessionDir must exist after call");

    const cwdTxtPath = join(dir, "cwd.txt");
    assert.ok(existsSync(cwdTxtPath), "T-Sessions6: cwd.txt must be written in fresh session dir");

    const content = readFileSync(cwdTxtPath, "utf-8").trim();
    assert.equal(content, testCwd, `T-Sessions6: cwd.txt content must equal testCwd; got "${content}"`);

    // Call again — should NOT throw (idempotent, dir already exists).
    const dir2 = sessionDir(testCwd);
    assert.equal(dir2, dir, "T-Sessions6: second call must return same dir");

    console.log("T-Sessions6: cwd.txt written by sessionDir ✓");
  } finally {
    restore();
  }
});

// ─── T-Sessions7 — listAllSessions cwd label recovery ────────────────────────

test("T-Sessions7: listAllSessions reads cwd.txt for post-P-7 dirs; hash-only fallback for pre-P-7 dirs", () => {
  const { tmpRoot, restore } = withTmpSessionsRoot();
  try {
    // Build the sessions root under the fake home.
    const sessionsRoot = join(tmpRoot, ".mai", "agent", "sessions");
    mkdirSync(sessionsRoot, { recursive: true });

    const testCwd = "/home/operator/my-project";
    const hash = cwdHash(testCwd);

    // ── Post-P-7 session dir: has cwd.txt ────────────────────────────────────
    const postP7Dir = join(sessionsRoot, hash);
    mkdirSync(postP7Dir, { recursive: true });
    writeFileSync(join(postP7Dir, "cwd.txt"), testCwd, "utf-8");
    // Write one JSONL session file.
    const sessionFile1 = join(postP7Dir, "2026-05-01T10-00-00-000Z.jsonl");
    writeFileSync(sessionFile1, `${JSON.stringify({ role: "user", content: "Hello from test" })}\n`, "utf-8");

    // ── Pre-P-7 session dir: NO cwd.txt ──────────────────────────────────────
    const preP7Hash = "abcdef1234567890";
    const preP7Dir = join(sessionsRoot, preP7Hash);
    mkdirSync(preP7Dir, { recursive: true });
    // No cwd.txt file.
    const sessionFile2 = join(preP7Dir, "2025-12-01T08-00-00-000Z.jsonl");
    writeFileSync(sessionFile2, `${JSON.stringify({ role: "user", content: "Old session" })}\n`, "utf-8");

    const sessions = listAllSessions();

    // Should have 2 sessions.
    assert.equal(sessions.length, 2, `T-Sessions7: must list 2 sessions; got ${sessions.length}`);

    // Post-P-7 session: cwdLabel must equal testCwd.
    const post = sessions.find((s) => s.cwdHash === hash);
    assert.ok(post, "T-Sessions7: post-P-7 session must be listed");
    assert.equal(post?.cwdLabel, testCwd, `T-Sessions7: cwdLabel must equal testCwd; got "${post?.cwdLabel}"`);
    assert.equal(post?.firstPrompt, "Hello from test", "T-Sessions7: firstPrompt must be parsed from JSONL");
    assert.equal(post?.messageCount, 1, "T-Sessions7: messageCount must be 1");

    // Pre-P-7 session: cwdLabel must be null (no cwd.txt).
    const pre = sessions.find((s) => s.cwdHash === preP7Hash);
    assert.ok(pre, "T-Sessions7: pre-P-7 session must be listed");
    assert.equal(pre?.cwdLabel, null, `T-Sessions7: cwdLabel must be null for pre-P-7 dir; got "${pre?.cwdLabel}"`);
    assert.equal(pre?.firstPrompt, "Old session", "T-Sessions7: firstPrompt for pre-P-7 session");

    console.log("T-Sessions7: listAllSessions cwd label recovery ✓");
  } finally {
    restore();
  }
});
