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
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import type { CurrentSurfaceContext, LinkedinSession } from "../../src/linkedin/types.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";

process.env.MAI_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

const SRC_ROOT = resolve(new URL(".", import.meta.url).pathname, "../../src");

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
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const mockControl: ControlSignals = { requestStop: () => {} };

// Pre-P-31 worker tool snapshot (31 keys) — P-31 adds `schedule_task` to make 32.
// P-44: updated from 28 to 31 to include P-39's search_memory/set_memory_note/get_memory_note.
const PRE_P31_WORKER_KEYS = [
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

// P-SP-A rebaseline: current worker tool snapshot (47 keys after 12 sales kernel tools).
const POST_P31_WORKER_KEYS = [
  ...PRE_P31_WORKER_KEYS,
  "get_account_context",
  "get_auto_run_state",
  "get_lead_context",
  "list_due_followups",
  "mark_message_sent",
  "promote_candidate_to_lead",
  "record_auto_action",
  "record_lead_event",
  "record_raw_candidate",
  "save_message_draft",
  "schedule_task",
  "schedule_follow_up",
  "suggest_card",
  "suggest_next_actions",
  "todo_write",
  "update_lead_stage",
].sort();

// Pre-P-31 server tool snapshot (22 keys).
// P-44: updated from 19 to 22 to include P-39's search_memory/set_memory_note/get_memory_note.
const PRE_P31_SERVER_KEYS = [
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
  "search_memory",
  "send_worker_message",
  "set_memory_note",
  "sleep",
  "stop",
  "telegram_notify",
  "web_fetch",
  "web_search",
].sort();

// P-Z2 rebaseline: current server tool snapshot (26 keys = pre-P-31 22 + schedule_task [P-31]
// + suggest_card/suggest_next_actions [P-57a] + todo_write [P-Y1]). CLAUDE.md:70 server=26.
const POST_P31_SERVER_KEYS = [
  ...PRE_P31_SERVER_KEYS,
  "schedule_task",
  "suggest_card",
  "suggest_next_actions",
  "todo_write",
].sort();

// ─── T-CONTRACT.WORKER ────────────────────────────────────────────────────────

describe("makeAllTools worker mode → 47 tool keys (rebaselined to P-SP-A from post-P-Y1) (G-P31.12)", () => {
  it("T-CONTRACT.WORKER: makeAllTools(session, {schedulePath}, control, undefined, {mode:'worker',workerId}) → 47 keys; set includes 12 sales kernel tools", () => {
    // Given:  makeAllTools called in worker mode with session + persistence (incl. schedulePath) + control
    // When:   worker mode tool set is built post-P-31
    // Then:   29 keys; deepEqual to POST_P31_WORKER_KEYS; diff from PRE is exactly {schedule_task}

    const { dir, cleanup } = makeTmpDir();
    try {
      const session = makeFakeSession();
      const tools = makeAllTools(
        session,
        {
          memoryDbPath: join(dir, "memory.sqlite"),
          identityPath: join(dir, "identity.json"),
          schedulePath: join(dir, "schedule.jsonl"),
        },
        mockControl,
        undefined,
        { mode: "worker", workerId: "w1" },
      );

      const keys = Object.keys(tools).sort();

      assert.equal(
        keys.length,
        47,
        `worker mode must return exactly 47 tools (got ${keys.length}): ${JSON.stringify(keys)}`,
      );
      assert.deepEqual(
        keys,
        POST_P31_WORKER_KEYS,
        "worker tool names must match POST_P31_WORKER_KEYS (current post-P-Y1 inventory)",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-CONTRACT.SERVER ────────────────────────────────────────────────────────

describe("makeAllTools server mode → 26 tool keys (rebaselined to current post-P-Y1; was P-31-era 23) (G-P31.12)", () => {
  it("T-CONTRACT.SERVER: makeAllTools(undefined, {schedulePath}, control, undefined, {mode:'server'}) → 26 keys; set = pre-P-31 22 + schedule_task + suggest_card/suggest_next_actions + todo_write", () => {
    // Given:  makeAllTools called in server mode with persistence (incl. schedulePath) + control
    // When:   server mode tool set is built post-P-31
    // Then:   20 keys; deepEqual to POST_P31_SERVER_KEYS; diff from PRE is exactly {schedule_task}

    const { dir, cleanup } = makeTmpDir();
    try {
      const tools = makeAllTools(
        undefined,
        {
          memoryDbPath: join(dir, "memory.sqlite"),
          identityPath: join(dir, "identity.json"),
          schedulePath: join(dir, "schedule.jsonl"),
        },
        mockControl,
        undefined,
        { mode: "server" },
      );

      const keys = Object.keys(tools).sort();

      assert.equal(
        keys.length,
        26,
        `server mode must return exactly 26 tools (got ${keys.length}): ${JSON.stringify(keys)}`,
      );
      assert.deepEqual(
        keys,
        POST_P31_SERVER_KEYS,
        "server tool names must match POST_P31_SERVER_KEYS (current post-P-Y1 inventory)",
      );
    } finally {
      cleanup();
    }
  });
});

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
      assert.ok(
        !content.includes("child_process"),
        `src/tools/cron/${file} must NOT import child_process (no-bash boundary)`,
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
