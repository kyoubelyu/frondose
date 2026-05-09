/**
 * P-7 mock tests — T-Sessions1..T-Sessions5: runSessionsSubcommand.
 *
 * Tests:
 *   T-Sessions1 — list table output: session ID + msg count + preview
 *   T-Sessions2 — list JSON mode: NDJSON format, one session per line
 *   T-Sessions3 — continue touches mtime of the target session file
 *   T-Sessions4 — continue nonexistent-id → exit 1 with error
 *   T-Sessions5 — new creates a fresh session file + prints its ID
 *
 * No Chrome, no LLM required.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSessionsSubcommand } from "../../src/cli/subcommands/sessions.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a fake sessions root under a tmp dir and point HOME there. */
function makeFakeSessionsEnv(): {
  fakeHome: string;
  sessionsRoot: string;
  cleanup: () => void;
} {
  const fakeHome = mkdtempSync(join(tmpdir(), "mai-p7-sess-cli-"));
  const sessionsRoot = join(fakeHome, ".mai", "agent", "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  return {
    fakeHome,
    sessionsRoot,
    cleanup: () => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(fakeHome, { recursive: true, force: true });
    },
  };
}

/** Write a fake session JSONL into sessionsRoot/<hash>/<id>.jsonl */
function writeFakeSession(
  sessionsRoot: string,
  hashDir: string,
  sessionId: string,
  messages: object[],
  cwdLabel?: string,
): string {
  const hashPath = join(sessionsRoot, hashDir);
  mkdirSync(hashPath, { recursive: true });
  if (cwdLabel) writeFileSync(join(hashPath, "cwd.txt"), cwdLabel, "utf-8");
  const filePath = join(hashPath, `${sessionId}.jsonl`);
  writeFileSync(filePath, `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`, "utf-8");
  return filePath;
}

/** Capture stdout from an async fn. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stdout as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  await fn().finally(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stdout as any).write = origWrite;
  });
  return chunks.join("");
}

/** Capture stderr from an async fn. */
async function _captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stderr as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  await fn().finally(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restore
    (process.stderr as any).write = origWrite;
  });
  return chunks.join("");
}

// ─── T-Sessions1 — list table output ─────────────────────────────────────────

test("T-Sessions1: runSessionsSubcommand list prints table with session ID + msg count + preview", async () => {
  const { cleanup, sessionsRoot } = makeFakeSessionsEnv();
  try {
    writeFakeSession(
      sessionsRoot,
      "aabbccdd11223344",
      "2026-05-01T10-00-00-000Z",
      [
        { role: "user", content: "Tell me about the sales pipeline" },
        { role: "assistant", content: "Sure! Let me outline the key stages..." },
      ],
      "/home/operator/crm-project",
    );

    const output = await captureStdout(() => runSessionsSubcommand("list", {}));

    assert.ok(output.includes("2026-05-01T10-00-00-000Z"), "T-Sessions1: session ID must appear in table");
    assert.ok(output.includes("[2 msgs]"), "T-Sessions1: message count must appear");
    assert.ok(output.includes("Tell me about the sales pipeline"), "T-Sessions1: first prompt preview must appear");
    assert.ok(output.includes("/home/operator/crm-project"), "T-Sessions1: cwd label must appear");
    console.log("T-Sessions1: list table output ✓");
  } finally {
    cleanup();
  }
});

// ─── T-Sessions2 — list JSON mode ────────────────────────────────────────────

test("T-Sessions2: runSessionsSubcommand list --json prints NDJSON lines", async () => {
  const { cleanup, sessionsRoot } = makeFakeSessionsEnv();
  try {
    writeFakeSession(
      sessionsRoot,
      "ff00112233445566",
      "2026-05-02T09-30-00-000Z",
      [{ role: "user", content: "JSON test prompt" }],
      "/projects/json-test",
    );

    const output = await captureStdout(() => runSessionsSubcommand("list", { json: true }));

    // Each line should be valid JSON.
    const lines = output.trim().split("\n").filter(Boolean);
    assert.ok(lines.length >= 1, "T-Sessions2: must have at least one NDJSON line");

    let parsed: ReturnType<typeof JSON.parse>;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(lines[0]);
    }, "T-Sessions2: each line must be valid JSON");

    assert.ok("sessionId" in parsed, "T-Sessions2: parsed session must have sessionId");
    assert.ok("cwdLabel" in parsed, "T-Sessions2: parsed session must have cwdLabel");
    assert.ok("messageCount" in parsed, "T-Sessions2: parsed session must have messageCount");

    console.log("T-Sessions2: list JSON mode NDJSON ✓");
  } finally {
    cleanup();
  }
});

// ─── T-Sessions3 — continue touches mtime ────────────────────────────────────

test("T-Sessions3: runSessionsSubcommand continue updates mtime of target session file", async () => {
  const { cleanup, sessionsRoot } = makeFakeSessionsEnv();
  try {
    // Create session with a past mtime.
    const filePath = writeFakeSession(
      sessionsRoot,
      "deadbeef87654321",
      "2025-01-01T00-00-00-000Z",
      [{ role: "user", content: "Old session prompt" }],
      "/old/project",
    );

    // Set mtime to the past (2020-01-01).
    const oldDate = new Date("2020-01-01T00:00:00Z");
    const { utimesSync } = await import("node:fs");
    utimesSync(filePath, oldDate, oldDate);
    const oldMtime = statSync(filePath).mtimeMs;

    const before = Date.now();
    await captureStdout(() => runSessionsSubcommand("continue", { sessionId: "2025-01-01T00-00-00-000Z" }));
    const after = Date.now();

    const newMtime = statSync(filePath).mtimeMs;
    assert.ok(newMtime > oldMtime, `T-Sessions3: mtime must be updated; old=${oldMtime} new=${newMtime}`);
    assert.ok(
      newMtime >= before - 100 && newMtime <= after + 1000,
      `T-Sessions3: new mtime must be around now; got ${newMtime}`,
    );
    console.log("T-Sessions3: continue updates mtime ✓");
  } finally {
    cleanup();
  }
});

// ─── T-Sessions4 — continue not-found → exit 1 ───────────────────────────────

test("T-Sessions4: runSessionsSubcommand continue with nonexistent session-id exits 1 with error", async () => {
  const { cleanup, sessionsRoot } = makeFakeSessionsEnv();
  try {
    // No sessions created.
    let exitCode: number | undefined;
    const origExit = process.exit.bind(process);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process as any).exit = (code: number) => {
      exitCode = code;
      throw new Error(`__mock_exit_${code}`);
    };

    let stderrOutput = "";
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process.stderr as any).write = (chunk: string | Buffer) => {
      stderrOutput += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    };

    try {
      await runSessionsSubcommand("continue", { sessionId: "nonexistent-session-id" });
    } catch (err) {
      // Expected: the mocked process.exit threw.
      if (!(err instanceof Error && err.message.startsWith("__mock_exit_"))) throw err;
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = origExit;
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stderr as any).write = origStderrWrite;
    }

    assert.equal(exitCode, 1, "T-Sessions4: must exit 1 for not-found session");
    assert.ok(
      stderrOutput.includes("nonexistent-session-id") || stderrOutput.includes("not found"),
      `T-Sessions4: stderr must mention missing session; got "${stderrOutput}"`,
    );
    console.log("T-Sessions4: continue not-found → exit 1 ✓");
  } finally {
    cleanup();
  }
});

// ─── T-Sessions5 — new creates session + prints ID ───────────────────────────

test("T-Sessions5: runSessionsSubcommand new creates a fresh session file and prints its ID", async () => {
  const { fakeHome, cleanup } = makeFakeSessionsEnv();
  try {
    const output = await captureStdout(() => runSessionsSubcommand("new", {}));

    // Output must include "New session:" and the session ID.
    assert.ok(output.includes("New session:"), `T-Sessions5: must print "New session:"; got "${output}"`);
    assert.ok(output.includes("Run `mai`"), "T-Sessions5: must include instruction to run mai");

    // The session ID is printed after "New session: ".
    const match = output.match(/New session: (.+)/);
    assert.ok(match?.[1], "T-Sessions5: session ID must be printed");
    const sessionId = match?.[1].trim();
    assert.ok(sessionId.length > 10, `T-Sessions5: session ID looks too short: "${sessionId}"`);
    // Session ID must look like an ISO timestamp with dashes: "2026-05-01T10-00-00-000Z"
    assert.match(
      sessionId,
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/,
      `T-Sessions5: session ID must be timestamp-based; got "${sessionId}"`,
    );

    // The session DIR must exist under fakeHome (newSessionFile creates the dir but
    // not the .jsonl file — the file is only written on appendMessages).
    const sessionsRoot = join(fakeHome, ".mai", "agent", "sessions");
    const { readdirSync } = await import("node:fs");
    const hashDirs = readdirSync(sessionsRoot).filter((d) => {
      try {
        return statSync(join(sessionsRoot, d)).isDirectory();
      } catch {
        return false;
      }
    });
    assert.ok(hashDirs.length >= 1, `T-Sessions5: at least one hash dir must be created; got ${hashDirs.length}`);
    console.log(`T-Sessions5: new session created: ${sessionId} ✓`);
  } finally {
    cleanup();
  }
});
