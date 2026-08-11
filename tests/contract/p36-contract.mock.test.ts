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
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CdpClient } from "../../src/cdp/client.js";
import type { CurrentSurfaceContext, LinkedinSession } from "../../src/linkedin/types.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";
import { findChildProcessImports } from "../_helpers/childProcessAst.js";
import { cleanupTmpDir } from "../_helpers/tmp";

process.env.FRONDOSE_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

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
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

const mockControl: ControlSignals = { requestStop: () => {} };

// Current worker tool name snapshot (52 tools after clear_cookies removed from browser registry).
// P-44: updated from 29 to 32 to include P-39's search_memory/set_memory_note/get_memory_note.
// Identical to FROZEN_WORKER_TOOL_KEYS in p33-contract.mock.test.ts (P-36 contract freeze).
// P-SP-B: +2 scoring tools (score_lead + score_account) → 49 worker tools.
const FROZEN_WORKER_TOOL_KEYS_P36 = [
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
  // P-SP-B: +2 sales-value scoring tools
  "score_account",
  "score_lead",
].sort();

// Post-P-73 server tool name snapshot (25 tools).
// P-44: updated from 20 to 23; P-73: removed suggest_card/suggest_next_actions (worker-only overlay tools).

// ─── T-CONTRACT.NO-BASH ───────────────────────────────────────────────────────

describe("no child_process import in P-36's 8 edited production files (G-P36.14)", () => {
  it("T-CONTRACT.NO-BASH: none of P-36's edited TypeScript files contain 'child_process' import", () => {
    // Given: P-36's 8 in-scope production files read from src/
    // When:  grep for 'child_process' in each file
    // Then:  zero matches in all 8 files
    // P-APP-11 stage (b1): auth.ts deleted → removed from this scan (was present since P-36).
    // P-OPEN-SOURCE-SPLIT: the CLI/fleet files (serverRepl, serverDaemon,
    // serverWebToken, main) are retired with the CLI vertical.
    const p36Files = [
      resolve(ROOT, "src/agent/modelResolver.ts"),
      resolve(ROOT, "src/persistence/secrets.ts"),
      resolve(ROOT, "src/persistence/config.ts"),
    ];
    for (const filePath of p36Files) {
      const content = readFileSync(filePath, "utf-8");
      const violations = findChildProcessImports(filePath, content);
      assert.equal(
        violations.length,
        0,
        `child_process found in ${filePath} — violates no-bash boundary (G-P36.14): ${violations
          .map((v) => `${v.kind} of "${v.specifier}" at line ${v.line}`)
          .join("; ")}`,
      );
    }
    // T-CONTRACT.NO-BASH passes at Step 4a (invariant — none of these files had child_process) ✅
  });
});

// ─── T-CONTRACT.TOOLS ─────────────────────────────────────────────────────────

describe("tool counts: worker 54 / server 27 rebaselined (G-P36.14)", () => {
  it("T-CONTRACT.TOOLS: single-mode App registry — power 51 / consumer 49 (P-OPEN-SOURCE-SPLIT §10.2)", () => {
    // Given: makeAllTools called with fake deps under both tiers (server mode retired)
    // When:  count the tool registrations returned
    // Then:  power count === 51; consumer count === 49; the delta is telegram_notify + gh_issue
    const { dir, cleanup } = makeTmpDir();
    try {
      const session = makeFakeSession();
      const persistence = { memoryDbPath: join(dir, "memory.sqlite"), configPath: join(dir, "config.json") };
      process.env.FRONDOSE_TIER = "power";
      const powerKeys = Object.keys(makeAllTools(session, persistence, mockControl)).sort();
      assert.equal(
        powerKeys.length,
        51,
        `power tool count must be 51; got ${powerKeys.length}: ${JSON.stringify(powerKeys)}`,
      );
      assert.deepEqual(powerKeys, FROZEN_WORKER_TOOL_KEYS_P36, "power tool name set must match the frozen snapshot");
      process.env.FRONDOSE_TIER = "consumer";
      const consumerKeys = Object.keys(makeAllTools(session, persistence, mockControl)).sort();
      assert.equal(
        consumerKeys.length,
        49,
        `consumer tool count must be 49; got ${consumerKeys.length}: ${JSON.stringify(consumerKeys)}`,
      );
      const powerOnly = powerKeys.filter((name) => !consumerKeys.includes(name)).sort();
      assert.deepEqual(powerOnly, ["gh_issue", "telegram_notify"], "tier delta must be telegram_notify + gh_issue");
    } finally {
      process.env.FRONDOSE_TIER = "power";
      cleanup();
    }
  });
});
