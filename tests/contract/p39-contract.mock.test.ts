/**
 * P-39 Step 5 — T-Count.1-2, T-NoBash.1, T-FileSize.1
 *
 * Assertions filled at Step 5.
 *
 * Gates covered: G-P39.11 (tool counts 32/23), G-P39.12 (no child_process, file size)
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CdpClient } from "../../src/cdp/client.js";
import type { CurrentSurfaceContext, LinkedinSession } from "../../src/linkedin/types.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";
import { cleanupTmpDir } from "../_helpers/tmp";

process.env.FRONDOSE_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

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
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

const mockControl: ControlSignals = { requestStop: () => {} };

// Frozen P-39 tool name snapshots — P-38 (29/20) + 3 new memory tools.
// P-SP-B: +2 scoring tools (score_lead + score_account) → 49 worker tools.
// clear_cookies removed from browser registry (no longer LLM-visible).
const FROZEN_WORKER_TOOL_KEYS_P39 = [
  "analyze_screenshot",
  "click",
  "close",
  "echo",
  "end_auto_run",
  "escalate_for_capability",
  "get_account_context",
  "get_auto_run_state",
  "get_lead_context",
  "get_memory_note",
  "get_sales_report",
  "getIdentity",
  "getMemory",
  "gh_issue",
  "identity",
  "inspect",
  "launch",
  "list_due_followups",
  "mark_message_sent",
  "navigate_to_url",
  "present_summary",
  "press",
  "promote_candidate_to_lead",
  "qualify_profile",
  "record_auto_action",
  "record_lead_event",
  "record_raw_candidate",
  "reload",
  "remember",
  "save_message_draft",
  "schedule_task",
  "schedule_follow_up",
  "screenshot",
  "scroll",
  "search_memory",
  "set_memory_note",
  "sleep",
  "start_auto_run",
  "stop",
  "stop_auto", // P-REBASE-TOOL-COUNT: stop_auto added at P-AUTO-ISOLATE
  // P-Z2 rebaseline: accreted since P-39 (P-57a suggestion tools + P-Y1 workflow)
  "suggest_card",
  "suggest_next_actions",
  "telegram_notify",
  "todo_write",
  "type",
  "update_lead_stage",
  "upload",
  "web_fetch",
  "web_search",
  // P-SP-B: +2 sales-value scoring tools
  "score_account",
  "score_lead",
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
  "present_summary",
  "provision_worker",
  "remember",
  "revoke_worker",
  "schedule_task",
  "search_memory",
  "send_worker_message",
  "set_memory_note",
  "sleep",
  "stop",
  "stop_auto", // P-REBASE-TOOL-COUNT: stop_auto added at P-AUTO-ISOLATE
  // P-73: suggest_card/suggest_next_actions are worker-only overlay tools (removed from server)
  "telegram_notify",
  "todo_write",
  "web_fetch",
  "web_search",
].sort();

// ─── T-Count.1 ────────────────────────────────────────────────────────────────

describe("P-39 tool count: worker 54 (P-ISSUE-BOARD) (G-P39.11)", () => {
  it("T-Count.1: makeAllTools (single-mode App registry) → exactly 51 tools, including present_summary and current sales tools", () => {
    // Given: makeAllTools called with a fake session + persistence + control (single-mode App registry)
    // When:  Object.keys(workerTools).length checked; set includes the 3 P-39 memory tools + 2 P-SP-B scoring tools + stop_auto
    // Then:  51 tools; workerKeys deepEquals FROZEN_WORKER_TOOL_KEYS_P39
    //        (P-OPEN-SOURCE-SPLIT: 54 − report_issue − query_lead_globally − publish_event)
    const { dir, cleanup } = makeTmpDir();
    try {
      const session = makeFakeSession();
      const workerTools = makeAllTools(
        session,
        { memoryDbPath: join(dir, "memory.sqlite"), identityPath: join(dir, "identity.json") },
        mockControl,
      );
      const workerKeys = Object.keys(workerTools).sort();
      assert.equal(
        workerKeys.length,
        51,
        `App tool count must be 51; got ${workerKeys.length}: ${workerKeys.join(", ")}`,
      );
      assert.deepEqual(workerKeys, FROZEN_WORKER_TOOL_KEYS_P39, "App tool set must match the single-mode snapshot");
    } finally {
      cleanup();
    }
  });
});

// ─── T-Count.2 ─── RETIRED with the fleet server mode ─────────────────────────
// (server mode is deleted per T-RETIRE.Fleet.1; FROZEN_SERVER_TOOL_KEYS_P39 is
// removed with it.)

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
      assert.ok(!importRe.test(content), `${filePath} must NOT import child_process (G-P39.12 no-bash boundary)`);
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
