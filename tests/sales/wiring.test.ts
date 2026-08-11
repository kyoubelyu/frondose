/**
 * P-SP-A mock tests — T-SP-A.Wiring.1..3
 * makeAllTools registry: tool count, no server-mode registration, consumer tier.
 *
 * NIT-4 note (guardian): these tests must pass a truthy mock session for
 * browser/linkedin tools to register. With session=undefined the browser/linkedin
 * tools do NOT register, so the count drops from 47→35.
 *
 * A minimal mock session object is constructed below ({} as any) — tools capture
 * it in closures and only call methods at execute() time, not at construction.
 * So construction always succeeds regardless of session shape.
 *
 * Step 5: assertion bodies filled.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LinkedinSession } from "../../src/linkedin/types.js";
import { closeSalesDatabase } from "../../src/persistence/salesDb.js";
import { makeAllTools } from "../../src/tools/index.js";

/** Truthy mock session — browser/linkedin tools capture it in closures;
 *  methods are NOT called at construction time. */
const MOCK_SESSION = {} as unknown as LinkedinSession;

const PERSISTENCE = {
  memoryDbPath: ":memory:",
  configPath: "/nonexistent/config.json",
  salesDbPath: ":memory:",
};

const CONTROL = { abort: new AbortController() };

const SALES_TOOL_NAMES = [
  "end_auto_run",
  "get_account_context",
  "get_auto_run_state",
  "get_lead_context",
  "get_sales_report",
  "list_due_followups",
  "mark_message_sent",
  "record_raw_candidate",
  "promote_candidate_to_lead",
  "update_lead_stage",
  "record_lead_event",
  "save_message_draft",
  "schedule_follow_up",
  "record_auto_action",
  "score_account",
  "score_lead",
  "start_auto_run",
] as const;

describe("T-SP-A.Wiring — makeAllTools factory tool-count + server/worker/tier gating", () => {
  // ─── T-SP-A.Wiring.1 ─────────────────────────────────────────────────────────
  it("T-SP-A.Wiring.1: single-mode App power tier returns 51 tools including all 17 sales-kernel tools", async () => {
    // Given: makeAllTools called with a minimal mock session + :memory: salesDbPath + control + tier='power'
    // When:  Object.keys(tools) enumerated
    // Then:  length === 51 (P-OPEN-SOURCE-SPLIT: 54 − report_issue − query_lead_globally − publish_event);
    //        the 17 sales-kernel tool names all present;
    closeSalesDatabase(":memory:");

    const tools = makeAllTools(MOCK_SESSION, PERSISTENCE, CONTROL, undefined, {
      tier: "power",
    });
    const keys = Object.keys(tools);

    assert.strictEqual(
      keys.length,
      51,
      `App power tier must have 51 tools; got ${keys.length}: ${keys.sort().join(", ")}`,
    );

    for (const name of SALES_TOOL_NAMES) {
      assert.ok(keys.includes(name), `Sales kernel tool '${name}' must be present in the App registry`);
    }

    // Spot-check some pre-existing tools are still present
    for (const existing of [
      "echo",
      "remember",
      "inspect",
      "launch",
      "qualify_profile",
      "web_fetch",
      "telegram_notify",
      "gh_issue",
    ]) {
      assert.ok(keys.includes(existing), `Pre-existing App tool '${existing}' must still be present`);
    }
  });

  // ─── T-SP-A.Wiring.2/3 ─── RETIRED with the fleet server mode ─────────────
});
