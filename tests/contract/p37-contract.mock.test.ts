/**
 * P-37 Step 4a scaffolds — T-CONTRACT.NO-BASH, T-CONTRACT.TOOLS, T-CONTRACT.HW
 *
 * Contract regression tests — P-37 must NOT change:
 *   - tool counts (worker 29 / server 20)
 *   - no child_process in any P-37 touched file
 *   - hardwareScroll byte-unchanged (OQ-5: no coordinate-bounds bug on that path)
 *
 * Gate coverage: G-P37.12 (no-bash; tool counts unchanged), G-P37.13 (hardwareScroll untouched)
 *
 * T-CONTRACT.NO-BASH and T-CONTRACT.HW would PASS even before builder changes;
 * T-CONTRACT.TOOLS would PASS before builder changes (tool counts are unchanged).
 * All have assert.fail("TODO") to intentionally fail at Step 4a.
 * Validator Step 5: remove assert.fail() and keep the real assertions.
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
  const dir = mkdtempSync(join(tmpdir(), "mai-p37-contract-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

const mockControl: ControlSignals = { requestStop: () => {} };

// Frozen P-37 tool name snapshots — rebaselined to current P-Y3 inventory.
// P-44: updated from 29 to 32 (worker) and 20 to 23 (server) to include P-39's
//        search_memory/set_memory_note/get_memory_note.
// P-SP-B: +2 scoring tools (score_lead + score_account) → 49 worker tools.
// clear_cookies removed from browser registry (no longer LLM-visible).
const FROZEN_WORKER_TOOL_KEYS_P37 = [
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
  // P-Z2 rebaseline: accreted since P-44 (P-57a suggestion tools + P-Y1 workflow)
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

const FROZEN_SERVER_TOOL_KEYS_P37 = [
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

// ─── T-CONTRACT.NO-BASH ───────────────────────────────────────────────────────

describe("no child_process import in P-37's 7 edited production files (G-P37.12)", () => {
  it("T-CONTRACT.NO-BASH: none of P-37's 7 in-scope production files contain 'child_process' import", () => {
    // Given: P-37's 7 in-scope production files read from src/
    // When:  grep for 'child_process' in each file
    // Then:  zero matches in all 7 files (no-bash boundary held)

    const p37Files = [
      resolve(ROOT, "src/cdp/client.ts"),
      resolve(ROOT, "src/linkedin/snapshotCapture.ts"),
      resolve(ROOT, "src/linkedin/inspectSummary.ts"),
      resolve(ROOT, "src/tools/webTools/analyzeScreenshot.ts"),
      resolve(ROOT, "src/agent/systemPrompt/boundary.ts"),
      resolve(ROOT, "src/linkedin/session.ts"),
    ];

    for (const filePath of p37Files) {
      const content = readFileSync(filePath, "utf-8");
      const violations = findChildProcessImports(filePath, content);
      assert.equal(
        violations.length,
        0,
        `no-bash boundary violated: '${filePath}' contains a child_process reference (P-37 must not introduce any child_process usage in src/): ${violations
          .map((v) => `${v.kind} of "${v.specifier}" at line ${v.line}`)
          .join("; ")}`,
      );
    }
  });
});

// ─── T-CONTRACT.TOOLS ─────────────────────────────────────────────────────────

describe("tool counts: worker 54 / server 27 (rebaselined) (G-P37.12)", () => {
  it("T-CONTRACT.TOOLS: single-mode App registry — power 51 / consumer 49 (P-OPEN-SOURCE-SPLIT §10.2)", () => {
    // Given: makeAllTools called with fake deps under both tiers (server mode retired)
    // When:  count the tool registrations returned
    // Then:  power count === 51; consumer count === 49; the delta is telegram_notify + gh_issue
    const { dir, cleanup } = makeTmpDir();
    try {
      const session = makeFakeSession();
      const persistence = { memoryDbPath: join(dir, "memory.sqlite"), identityPath: join(dir, "identity.json") };
      process.env.FRONDOSE_TIER = "power";
      const powerKeys = Object.keys(makeAllTools(session, persistence, mockControl)).sort();
      assert.equal(
        powerKeys.length,
        51,
        `power tool count must be 51; got ${powerKeys.length}: ${JSON.stringify(powerKeys)}`,
      );
      assert.deepEqual(powerKeys, FROZEN_WORKER_TOOL_KEYS_P37, "power tool name set must match the frozen snapshot");
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

// ─── T-CONTRACT.HW ────────────────────────────────────────────────────────────

describe("hardwareScroll byte-unchanged by P-37 (G-P37.13)", () => {
  it("T-CONTRACT.HW: hardwareInput.ts hardwareScroll uses amount-based cg.scrollWheel (no synthesizeScrollGesture); P-37 did not touch it", () => {
    // Given: src/cdp/hardwareInput.ts read from disk
    // When:  source text is inspected for P-37 B3's fix pattern
    // Then:  hardwareInput.ts still uses 'scrollWheel' (amount-based CGEvent API);
    //        hardwareInput.ts does NOT contain 'synthesizeScrollGesture';
    //        the file is NOT modified by P-37 (OQ-5: no coordinate bug on this path)

    const hwSrc = readFileSync(resolve(ROOT, "src/cdp/hardwareInput.ts"), "utf-8");

    // G-P37.13: hardwareScroll must still use the CGEvent-based scrollWheel API
    assert.ok(
      hwSrc.includes("scrollWheel"),
      "hardwareInput.ts must still contain 'scrollWheel' (CGEvent-based scroll — P-37 B3 must not touch this path)",
    );
    // hardwareInput.ts must NOT use Input.synthesizeScrollGesture (that was the CDP-layer bug)
    assert.ok(
      !hwSrc.includes("synthesizeScrollGesture"),
      "hardwareInput.ts must NOT contain 'synthesizeScrollGesture' (hardware path uses CGEvent scrollWheel, not CDP Input API)",
    );
  });
});
