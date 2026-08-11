/**
 * P-31 Step 4a — T-CONTRACT.* (tool counts 29/20, no-bash, D-6 helpers unchanged)
 *
 * Gate coverage:
 *   G-P31.12 — T-CONTRACT.WORKER (makeAllTools worker → 29 keys)
 *              T-CONTRACT.SERVER (makeAllTools server → 20 keys)
 *   G-P31.11 — T-CONTRACT.NO-BASH (zero child_process / node-cron in P-31 new files)
 *   G-P31.11 — T-CONTRACT.HELPERS (schedule.ts + replCron.ts byte-identical to pre-P-31)
 *
 * NOTE (Step 4a red state):
 *   T-CONTRACT.WORKER: makeAllTools returns 28 now (schedule_task not registered yet);
 *     assert 29 → FAILS. After builder Step 4b it will return 29 → PASSES.
 *   T-CONTRACT.SERVER: same, returns 19 now → FAILS; will return 20 after Step 4b.
 *   T-CONTRACT.NO-BASH: src/tools/cron/ exists (stub) and has no child_process → PASSES.
 *   T-CONTRACT.HELPERS: pre-P-31 SHA snapshots embedded → PASSES now;
 *     will FAIL if builder accidentally edits those files.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CdpClient } from "../../src/cdp/client.js";
import type { CurrentSurfaceContext, LinkedinSession } from "../../src/linkedin/types.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";
import { findChildProcessImports } from "../_helpers/childProcessAst.js";
import { cleanupTmpDir } from "../_helpers/tmp";

process.env.FRONDOSE_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

const SRC_ROOT = fileURLToPath(new URL("../../src", import.meta.url));

function makeFakeSession(): LinkedinSession {
  const fakeHandle = {};
  const client = CdpClient.fromHandle(fakeHandle);
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
  const dir = mkdtempSync(join(tmpdir(), "mai-p31-contract-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

const mockControl: ControlSignals = { requestStop: () => {} };

// Pre-P-31 worker tool snapshot (31 keys) — P-31 adds `schedule_task` to make 32.
// P-44: updated from 28 to 31 to include P-39's search_memory/set_memory_note/get_memory_note.
// clear_cookies removed from browser registry (no longer LLM-visible).
const PRE_P31_WORKER_KEYS = [
  "analyze_screenshot",
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
  "qualify_profile",
  "reload",
  "remember",
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

// P-Y3 rebaseline: current worker tool snapshot (54 keys with present_summary + 17 sales tools
// + stop_auto [P-REBASE-TOOL-COUNT: stop_auto added at P-AUTO-ISOLATE]).
// clear_cookies removed from browser registry (no longer LLM-visible).
const POST_P31_WORKER_KEYS = [
  ...PRE_P31_WORKER_KEYS,
  "end_auto_run",
  "get_account_context",
  "get_auto_run_state",
  "get_lead_context",
  "get_sales_report",
  "list_due_followups",
  "mark_message_sent",
  "present_summary",
  "promote_candidate_to_lead",
  "record_auto_action",
  "record_lead_event",
  "record_raw_candidate",
  "save_message_draft",
  "schedule_task",
  "schedule_follow_up",
  "stop_auto",
  "suggest_card",
  "suggest_next_actions",
  "todo_write",
  "update_lead_stage",
  "score_account",
  "score_lead",
  "start_auto_run",
].sort();

// Pre-P-31 server tool snapshot (23 keys).
// P-44: updated from 19 to 22 to include P-39's search_memory/set_memory_note/get_memory_note.

// P-73 rebaseline: current server tool snapshot (27 keys = pre-P-31 23 + schedule_task [P-31]
// + todo_write [P-Y1] + present_summary [P-Y3] + stop_auto [P-REBASE-TOOL-COUNT: stop_auto added
// at P-AUTO-ISOLATE]; suggest_card/suggest_next_actions worker-only per P-73).

// ─── T-CONTRACT.WORKER ────────────────────────────────────────────────────────

describe("makeAllTools worker mode → 54 tool keys (P-ISSUE-BOARD) (G-P31.12)", () => {
  it("T-CONTRACT.WORKER: makeAllTools(session, {schedulePath}, control) → 51 keys; set includes present_summary + 17 sales tools + stop_auto", () => {
    // Given:  makeAllTools called with session + persistence (incl. schedulePath) + control
    // When:   the single-mode App tool set is built post-P-31
    // Then:   51 keys; deepEqual to POST_P31_WORKER_KEYS (P-OPEN-SOURCE-SPLIT: 54 −
    //         report_issue − query_lead_globally − publish_event).

    const { dir, cleanup } = makeTmpDir();
    try {
      const session = makeFakeSession();
      const tools = makeAllTools(
        session,
        {
          memoryDbPath: join(dir, "memory.sqlite"),
          configPath: join(dir, "config.json"),
          schedulePath: join(dir, "schedule.jsonl"),
        },
        mockControl,
      );

      const keys = Object.keys(tools).sort();

      assert.equal(
        keys.length,
        51,
        `the App registry must return exactly 51 tools (got ${keys.length}): ${JSON.stringify(keys)}`,
      );
      assert.deepEqual(
        keys,
        POST_P31_WORKER_KEYS,
        "App tool names must match POST_P31_WORKER_KEYS (single-mode inventory)",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-CONTRACT.SERVER ─── RETIRED with the fleet server mode ────────────────
// (server mode and POST_P31_SERVER_KEYS are deleted per T-RETIRE.Fleet.1.)

// ─── T-CONTRACT.SERVER ────────────────────────────────────────────────────────

// ─── T-CONTRACT.NO-BASH ──────────────────────────────────────────────────────

describe("No child_process or node-cron in P-31 new files (G-P31.11)", () => {
  it("T-CONTRACT.NO-BASH: zero 'child_process' and zero 'node-cron' imports in src/tools/cron/**/*.ts", () => {
    // Given:  src/tools/cron/ exists with the schedule_task tool files (P-31 Step 4a stubs + Step 4b impl)
    // When:   reading each .ts file and checking for forbidden imports
    // Then:   no file contains 'child_process' or 'node-cron'

    const cronDir = join(SRC_ROOT, "tools", "cron");
    const files = readdirSync(cronDir).filter((f) => f.endsWith(".ts"));

    assert.ok(files.length >= 2, `src/tools/cron/ must have at least 2 .ts files (stub); found ${files.length}`);

    for (const file of files) {
      const content = readFileSync(join(cronDir, file), "utf-8");
      const violations = findChildProcessImports(file, content);
      assert.equal(
        violations.length,
        0,
        `src/tools/cron/${file} must NOT import child_process (no-bash boundary): ${violations
          .map((v) => `${v.kind} of "${v.specifier}" at line ${v.line}`)
          .join("; ")}`,
      );
      assert.ok(
        !content.includes("node-cron"),
        `src/tools/cron/${file} must NOT import node-cron (D-6: no new cron library)`,
      );
    }
  });
});

// P-Z2 (bucket 5b): T-CONTRACT.HELPERS (SHA-256 byte-freeze of schedule.ts + replCron.ts)
// DELETED. A "stays byte-identical to phase-N" SHA-pin is the wrong guard for evolving
// helper files — it false-alarms on every legitimate edit. The behavioral tests for those
// modules are the correct guard. (OQ-Z2.3.)
