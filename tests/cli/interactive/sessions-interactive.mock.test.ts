/**
 * P-13 Step 4a — T-SessI.1..3 scaffolds
 *
 * Tests: runSessionsSubcommand('continue') interactive paths
 * Gate coverage: G-P13.3 + G-P13.7
 *
 * NOTE: Imports _prompts.ts (does NOT exist at Step 4a). All tests fail at
 * import-resolution until builder Step 4b. Step 5 fills assertion bodies.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runSessionsSubcommand } from "../../../src/cli/subcommands/sessions.js";
import { captureStdout, makeMockPrompter, stubInteractive } from "./_mockPrompter.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeSessionEnv(): { sessionsRoot: string; cleanup: () => void } {
  const fakeHome = mkdtempSync(join(tmpdir(), "mai-p13-sess-"));
  const sessionsRoot = join(fakeHome, ".mai", "agent", "sessions");
  mkdirSync(sessionsRoot, { recursive: true });
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  return {
    sessionsRoot,
    cleanup: () => {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(fakeHome, { recursive: true, force: true });
    },
  };
}

/**
 * Write N fake sessions under sessionsRoot, spaced 1 second apart in mtime order.
 * Returns array of session IDs in mtime-descending order (most recent first).
 */
function writeFakeSessions(sessionsRoot: string, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const sessionId = `session-${String(i).padStart(3, "0")}`;
    const hashDir = join(sessionsRoot, `hash${i.toString(16).padStart(16, "0")}`);
    mkdirSync(hashDir, { recursive: true });
    const filePath = join(hashDir, `${sessionId}.jsonl`);
    writeFileSync(filePath, `${JSON.stringify({ role: "user", content: `prompt ${i}` })}\n`, "utf-8");
    // Space out mtime so listAllSessions sorts correctly
    const mtime = new Date(Date.now() + i * 1000);
    utimesSync(filePath, mtime, mtime);
    ids.unshift(sessionId); // prepend so first element is most recent
  }
  return ids;
}

// ─── T-SessI.1 ───────────────────────────────────────────────────────────────

describe("runSessionsSubcommand('continue') — args-present regression", () => {
  it("T-SessI.1: when sessionId arg present, runs unchanged and prompter is NOT invoked", async () => {
    // Given: opts.sessionId is set to a known session ID; session file exists on disk
    // When:  runSessionsSubcommand("continue", { sessionId }, mockPrompter)
    // Then:  session file mtime updated; no prompter method called

    const { sessionsRoot, cleanup } = makeSessionEnv();
    const mp = makeMockPrompter();
    try {
      // Write one session
      const hashDir = join(sessionsRoot, "aabbccddeeff0011");
      mkdirSync(hashDir, { recursive: true });
      const sessionId = "abc123-test-session";
      writeFileSync(
        join(hashDir, `${sessionId}.jsonl`),
        `${JSON.stringify({ role: "user", content: "test" })}\n`,
        "utf-8",
      );

      await captureStdout(() => runSessionsSubcommand("continue", { sessionId }, mp));
      assert.equal(mp.calls.sessionsSelect.length, 0, "T-SessI.1: sessionsSelect MUST NOT be called");
    } finally {
      cleanup();
    }
  });
});

// ─── T-SessI.2 ───────────────────────────────────────────────────────────────

describe("runSessionsSubcommand('continue') — interactive picker", () => {
  it("T-SessI.2: when no sessionId AND isInteractive()=true AND 12 sessions exist, sessionsSelect receives exactly 10 (top by mtime)", async () => {
    // Given: no sessionId in opts; stdin.isTTY=true; 12 sessions on disk sorted by mtime
    // When:  runSessionsSubcommand("continue", {}, mockPrompter) with sessionsSelect returning one session's ID
    // Then:  sessionsSelect called once with exactly 10 sessions; selected session mtime updated

    const { sessionsRoot, cleanup } = makeSessionEnv();
    const restore = stubInteractive(true);
    let selectedId: string | undefined;
    const mp = makeMockPrompter({
      sessionsSelect: async (sessions: unknown[]) => {
        // Return the first (most-recent) session's ID
        // biome-ignore lint/suspicious/noExplicitAny: test helper
        selectedId = (sessions[0] as any)?.sessionId;
        return selectedId ?? "mock-session-id";
      },
    });
    try {
      writeFakeSessions(sessionsRoot, 12);
      await captureStdout(() => runSessionsSubcommand("continue", {}, mp));
      assert.equal(mp.calls.sessionsSelect.length, 1, "T-SessI.2: sessionsSelect called once");
      assert.equal(mp.calls.sessionsSelect[0].length, 10, "T-SessI.2: exactly 10 sessions passed (top by mtime)");
    } finally {
      restore();
      cleanup();
    }
  });
});

// ─── T-SessI.3 ───────────────────────────────────────────────────────────────

describe("runSessionsSubcommand('continue') — empty session list", () => {
  it("T-SessI.3: when no sessionId AND isInteractive()=true AND no sessions exist, prints 'No sessions found.' without calling sessionsSelect", async () => {
    // Given: no sessionId; stdin.isTTY=true; sessions directory is empty
    // When:  runSessionsSubcommand("continue", {}, mockPrompter)
    // Then:  stdout contains "No sessions found."; sessionsSelect MUST NOT be called

    const { cleanup } = makeSessionEnv();
    const restore = stubInteractive(true);
    const mp = makeMockPrompter();
    try {
      const stdout = await captureStdout(() => runSessionsSubcommand("continue", {}, mp));
      assert.ok(stdout.includes("No sessions found"), `T-SessI.3: must print no-sessions message; got: "${stdout}"`);
      assert.equal(mp.calls.sessionsSelect.length, 0, "T-SessI.3: sessionsSelect MUST NOT be called");
    } finally {
      restore();
      cleanup();
    }
  });
});
