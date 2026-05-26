/**
 * P-36 Step 5 — T-CONTRACT.NO-BASH (PASS from Step 4a) + T-CONTRACT.TOOLS (filled)
 *
 * Contract regression tests:
 *   - No child_process import in P-36's 8 edited files (G-P36.14)
 *   - Tool counts worker 29 / server 20 unchanged across P-36 (G-P36.14)
 *
 * Gate coverage:
 *   G-P36.14 — T-CONTRACT.NO-BASH, T-CONTRACT.TOOLS
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import type { CurrentSurfaceContext, LinkedinSession } from "../../src/linkedin/types.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";

process.env.MAI_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../");

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  const dir = mkdtempSync(join(tmpdir(), "mai-p36-contract-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const mockControl: ControlSignals = { requestStop: () => {} };

// Current worker tool name snapshot (47 tools after P-SP-A sales kernel rebaseline).
// P-44: updated from 29 to 32 to include P-39's search_memory/set_memory_note/get_memory_note.
// Identical to FROZEN_WORKER_TOOL_KEYS in p33-contract.mock.test.ts (P-36 contract freeze).
const FROZEN_WORKER_TOOL_KEYS_P36 = [
  "analyze_screenshot",
  "clear_cookies",
  "click",
  "close",
  "echo",
  "escalate_for_capability",
  "get_account_context",
  "get_auto_run_state",
  "get_lead_context",
  "get_memory_note",
  "getIdentity",
  "getMemory",
  "gh_issue",
  "identity",
  "inspect",
  "launch",
  "list_due_followups",
  "mark_message_sent",
  "navigate_to_url",
  "press",
  "promote_candidate_to_lead",
  "publish_event",
  "qualify_profile",
  "query_lead_globally",
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
  "stop",
  // P-Z3 rebaseline: accreted since P-44 (P-57a suggestion tools + P-Y1 workflow)
  "suggest_card",
  "suggest_next_actions",
  "telegram_notify",
  "todo_write",
  "type",
  "update_lead_stage",
  "upload",
  "web_fetch",
  "web_search",
].sort();

// Post-P-31 server tool name snapshot (23 tools — P-36 adds NO new tools).
// P-44: updated from 20 to 23 to include P-39's search_memory/set_memory_note/get_memory_note.
const FROZEN_SERVER_TOOL_KEYS_P36 = [
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
  // P-Z3 rebaseline: accreted since P-44 (P-57a suggestion tools + P-Y1 workflow)
  "suggest_card",
  "suggest_next_actions",
  "telegram_notify",
  "todo_write",
  "web_fetch",
  "web_search",
].sort();

// ─── T-CONTRACT.NO-BASH ───────────────────────────────────────────────────────

describe("no child_process import in P-36's 8 edited production files (G-P36.14)", () => {
  it("T-CONTRACT.NO-BASH: none of P-36's edited TypeScript files contain 'child_process' import", () => {
    // Given: P-36's 8 in-scope production files read from src/
    // When:  grep for 'child_process' in each file
    // Then:  zero matches in all 8 files
    const p36Files = [
      resolve(ROOT, "src/agent/modelResolver.ts"),
      resolve(ROOT, "src/cli/serverRepl.ts"),
      resolve(ROOT, "src/cli/serverDaemon.ts"),
      resolve(ROOT, "src/cli/subcommands/serverWebToken.ts"),
      resolve(ROOT, "src/persistence/secrets.ts"),
      resolve(ROOT, "src/persistence/config.ts"),
      resolve(ROOT, "src/cli/main.ts"),
      resolve(ROOT, "src/cli/subcommands/auth.ts"),
    ];
    for (const filePath of p36Files) {
      const content = readFileSync(filePath, "utf-8");
      assert.ok(
        !content.includes("child_process"),
        `child_process found in ${filePath} — violates no-bash boundary (G-P36.14)`,
      );
    }
    // T-CONTRACT.NO-BASH passes at Step 4a (invariant — none of these files had child_process) ✅
  });
});

// ─── T-CONTRACT.TOOLS ─────────────────────────────────────────────────────────

describe("tool counts: worker 47 / server 26 rebaselined at P-SP-A (G-P36.14)", () => {
  it("T-CONTRACT.TOOLS: P-36 count contract follows current makeAllTools inventory (worker 47 / server 26)", () => {
    // Given: makeAllTools called in worker mode and server mode with fake deps
    // When:  count the tool registrations returned
    // Then:  worker count === 47; server count === 26 (P-SP-A adds sales kernel tools only to worker mode)
    const { dir, cleanup } = makeTmpDir();
    try {
      // Worker mode — 29 tools
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
        47,
        `T-CONTRACT.TOOLS: worker mode must have exactly 47 tools across P-36; got ${workerKeys.length}: ${JSON.stringify(workerKeys)}`,
      );
      assert.deepEqual(
        workerKeys,
        FROZEN_WORKER_TOOL_KEYS_P36,
        "T-CONTRACT.TOOLS: worker tool names must match P-36 snapshot (47 tools, P-SP-A rebaseline)",
      );

      // Server mode — 20 tools
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
        26,
        `T-CONTRACT.TOOLS: server mode must have exactly 26 tools across P-36; got ${serverKeys.length}: ${JSON.stringify(serverKeys)}`,
      );
      assert.deepEqual(
        serverKeys,
        FROZEN_SERVER_TOOL_KEYS_P36,
        "T-CONTRACT.TOOLS: server tool names must match P-36 snapshot (23 tools, unchanged from P-31+)",
      );
    } finally {
      cleanup();
    }
  });
});
