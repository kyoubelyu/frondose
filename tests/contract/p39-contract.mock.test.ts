/**
 * P-39 Step 5 — T-Count.1-2, T-NoBash.1, T-FileSize.1
 *
 * Assertions filled at Step 5.
 *
 * Gates covered: G-P39.11 (tool counts 32/23), G-P39.12 (no child_process, file size)
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import type { CurrentSurfaceContext, LinkedinSession } from "../../src/linkedin/types.js";
import { makeAllTools } from "../../src/tools/index.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../");

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeFakeSession(): LinkedinSession {
  const client = CdpClient.fromHandle({});
  return {
    inputMode: "cdp" as const,
    getOrInitClient: async () => ({ ok: true as const, client }),
    getClient: () => client,
    heartbeat: async () => true,
    setLastContext: (_ctx: CurrentSurfaceContext) => {},
    getLastContext: () => undefined,
  };
}

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p39-contract-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const mockControl: ControlSignals = { requestStop: () => {} };

// Frozen P-39 tool name snapshots — P-38 (29/20) + 3 new memory tools.
const FROZEN_WORKER_TOOL_KEYS_P39 = [
  "analyze_screenshot",
  "clear_cookies",
  "click",
  "close",
  "echo",
  "escalate_for_capability",
  "get_memory_note",
  "getIdentity",
  "getMemory",
  "gh_issue",
  "identity",
  "inspect",
  "launch",
  "navigate_to_url",
  "press",
  "publish_event",
  "qualify_profile",
  "query_lead_globally",
  "reload",
  "remember",
  "schedule_task",
  "screenshot",
  "scroll",
  "search_memory",
  "set_memory_note",
  "sleep",
  "stop",
  "telegram_notify",
  "type",
  "upload",
  "web_fetch",
  "web_search",
].sort();

const FROZEN_SERVER_TOOL_KEYS_P39 = [
  "analyze_screenshot",
  "dispatch_google_login",
  "echo",
  "escalate_for_capability",
  "get_memory_note",
  "getIdentity",
  "getMemory",
  "gh_issue",
  "identity",
  "list_personas",
  "list_workers",
  "provision_worker",
  "remember",
  "revoke_worker",
  "schedule_task",
  "search_memory",
  "send_worker_message",
  "set_memory_note",
  "sleep",
  "stop",
  "telegram_notify",
  "web_fetch",
  "web_search",
].sort();

// ─── T-Count.1 ────────────────────────────────────────────────────────────────

describe("P-39 tool count: worker 32 (G-P39.11)", () => {
  it("T-Count.1: makeAllTools worker mode → exactly 32 tools, including search_memory / set_memory_note / get_memory_note", () => {
    // Given: makeAllTools called with a fake session + persistence + control in worker mode
    // When:  Object.keys(workerTools).length checked; set includes the 3 new P-39 tools
    // Then:  32 tools; workerKeys deepEquals FROZEN_WORKER_TOOL_KEYS_P39
    const { dir, cleanup } = makeTmpDir();
    try {
      const session = makeFakeSession();
      const workerTools = makeAllTools(
        session,
        { memoryDbPath: join(dir, "memory.sqlite"), identityPath: join(dir, "identity.json") },
        mockControl,
        undefined,
        { mode: "worker", workerId: "w1" },
      );
      const workerKeys = Object.keys(workerTools).sort();
      assert.equal(
        workerKeys.length,
        32,
        `worker tool count must be 32; got ${workerKeys.length}: ${workerKeys.join(", ")}`,
      );
      assert.deepEqual(workerKeys, FROZEN_WORKER_TOOL_KEYS_P39, "worker tool set must match frozen P-39 snapshot");
    } finally {
      cleanup();
    }
  });
});

// ─── T-Count.2 ────────────────────────────────────────────────────────────────

describe("P-39 tool count: server 23 (G-P39.11)", () => {
  it("T-Count.2: makeAllTools server mode → exactly 23 tools, including search_memory / set_memory_note / get_memory_note", () => {
    // Given: makeAllTools called with undefined session + persistence + control in server mode
    // When:  Object.keys(serverTools).length checked; set includes the 3 new P-39 tools
    // Then:  23 tools; serverKeys deepEquals FROZEN_SERVER_TOOL_KEYS_P39
    const { dir, cleanup } = makeTmpDir();
    try {
      const serverTools = makeAllTools(
        undefined,
        { memoryDbPath: join(dir, "memory.sqlite"), identityPath: join(dir, "identity.json") },
        mockControl,
        undefined,
        { mode: "server" },
      );
      const serverKeys = Object.keys(serverTools).sort();
      assert.equal(
        serverKeys.length,
        23,
        `server tool count must be 23; got ${serverKeys.length}: ${serverKeys.join(", ")}`,
      );
      assert.deepEqual(serverKeys, FROZEN_SERVER_TOOL_KEYS_P39, "server tool set must match frozen P-39 snapshot");
    } finally {
      cleanup();
    }
  });
});

// ─── T-NoBash.1 ───────────────────────────────────────────────────────────────

describe("no child_process in P-39 new/edited .ts files (G-P39.12)", () => {
  it("T-NoBash.1: grep child_process across P-39's new/edited source files → zero matches", () => {
    // Given: the set of TypeScript files new or edited in P-39
    //        (memory.ts, remember.ts, getMemory.ts, searchMemory.ts, setMemoryNote.ts,
    //         getMemoryNote.ts, index.ts [memory], checkpoint.ts, soul.ts)
    // When:  each file is read and scanned for child_process import statements
    // Then:  zero matches — all P-39 persistence is better-sqlite3 sync API, no shell-out
    const p39TsFiles = [
      resolve(ROOT, "src/persistence/memory.ts"),
      resolve(ROOT, "src/tools/memory/remember.ts"),
      resolve(ROOT, "src/tools/memory/getMemory.ts"),
      resolve(ROOT, "src/tools/memory/searchMemory.ts"),
      resolve(ROOT, "src/tools/memory/setMemoryNote.ts"),
      resolve(ROOT, "src/tools/memory/getMemoryNote.ts"),
      resolve(ROOT, "src/tools/memory/index.ts"),
      resolve(ROOT, "src/agent/systemPrompt/checkpoint.ts"),
      resolve(ROOT, "src/agent/systemPrompt/soul.ts"),
    ];

    // Matches: import ... from "child_process" or import ... from "node:child_process"
    const importRe = /\bimport\b[^;]*from\s+["'](?:node:)?child_process["']/;

    for (const filePath of p39TsFiles) {
      const content = readFileSync(filePath, "utf-8");
      assert.ok(
        !importRe.test(content),
        `${filePath} must NOT import child_process (G-P39.12 no-bash boundary)`,
      );
    }
  });
});

// ─── T-FileSize.1 ─────────────────────────────────────────────────────────────

describe("memory.ts file size ≤ 800 lines (G-P39.12)", () => {
  it("T-FileSize.1: src/persistence/memory.ts line count is <= 800 after P-39 additions", () => {
    // Given: src/persistence/memory.ts read from disk
    // When:  line count measured (split by newline)
    // Then:  <= 800 (plan estimate ~330–400; well under the 800 LOC cap)
    const content = readFileSync(resolve(ROOT, "src/persistence/memory.ts"), "utf-8");
    const lineCount = content.split("\n").length;
    assert.ok(
      lineCount <= 800,
      `src/persistence/memory.ts has ${lineCount} lines; must be <= 800 (G-P39.12 file-size cap)`,
    );
  });
});
