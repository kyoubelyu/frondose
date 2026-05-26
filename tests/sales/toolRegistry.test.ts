/**
 * P-SP-A mock tests — T-SP-A.Registry.1..3
 * makeSalesTools factory: tool count, no double-registration, worker-only.
 *
 * These tests verify the sales/index.ts factory in isolation (not makeAllTools).
 * They are complementary to T-SP-A.Wiring which tests the full makeAllTools path.
 *
 * Step 5: assertion bodies filled.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeSalesDatabase } from "../../src/persistence/salesDb.js";
import { makeSalesTools } from "../../src/tools/sales/index.js";

const EXPECTED_TOOL_NAMES = [
  "record_raw_candidate",
  "promote_candidate_to_lead",
  "update_lead_stage",
  "record_lead_event",
  "save_message_draft",
  "mark_message_sent",
  "schedule_follow_up",
  "list_due_followups",
  "get_lead_context",
  "get_account_context",
  "get_auto_run_state",
  "record_auto_action",
] as const;

describe("T-SP-A.Registry — makeSalesTools factory wiring", () => {
  // ─── T-SP-A.Registry.1 ───────────────────────────────────────────────────────
  it("T-SP-A.Registry.1: makeSalesTools returns exactly 12 tools with correct names", async () => {
    // Given: makeSalesTools(':memory:') called
    // When:  Object.keys(toolSet) enumerated
    // Then:  length === 12; all 12 tool names present verbatim:
    //        record_raw_candidate, promote_candidate_to_lead, update_lead_stage,
    //        record_lead_event, save_message_draft, mark_message_sent,
    //        schedule_follow_up, list_due_followups, get_lead_context,
    //        get_account_context, get_auto_run_state, record_auto_action
    closeSalesDatabase(":memory:");
    const toolSet = makeSalesTools(":memory:");
    const keys = Object.keys(toolSet);

    assert.strictEqual(keys.length, 12, "makeSalesTools must return exactly 12 tools");

    for (const name of EXPECTED_TOOL_NAMES) {
      assert.ok(
        keys.includes(name),
        `Tool '${name}' must be present in makeSalesTools output`,
      );
    }
  });

  // ─── T-SP-A.Registry.2 ───────────────────────────────────────────────────────
  it("T-SP-A.Registry.2: makeSalesTools called twice with same path returns distinct ToolSet objects (no mutation)", async () => {
    // Given: makeSalesTools(':memory:') called twice
    // When:  both ToolSet objects enumerated
    // Then:  both have 12 keys; Object.is(set1, set2) === false (distinct objects);
    //        no shared mutable state between them
    closeSalesDatabase(":memory:");
    const set1 = makeSalesTools(":memory:");
    const set2 = makeSalesTools(":memory:");

    assert.strictEqual(Object.keys(set1).length, 12, "set1 must have 12 keys");
    assert.strictEqual(Object.keys(set2).length, 12, "set2 must have 12 keys");
    assert.ok(!Object.is(set1, set2), "Two makeSalesTools() calls must return distinct objects");

    // Verify keys match between both sets (same inventory)
    const keys1 = Object.keys(set1).sort();
    const keys2 = Object.keys(set2).sort();
    assert.deepStrictEqual(keys1, keys2, "Both ToolSet objects must have identical tool names");
  });

  // ─── T-SP-A.Registry.3 ───────────────────────────────────────────────────────
  it("T-SP-A.Registry.3: each tool in makeSalesTools has a .description and .parameters property (Vercel tool shape)", async () => {
    // Given: makeSalesTools(':memory:') called
    // When:  each tool entry in the ToolSet inspected
    // Then:  every tool has typeof description === 'string' && description.length > 0;
    //        every tool has a parameters property (Zod schema object)
    closeSalesDatabase(":memory:");
    const toolSet = makeSalesTools(":memory:");

    for (const [name, tool] of Object.entries(toolSet)) {
      const t = tool as { description?: unknown; parameters?: unknown };
      assert.strictEqual(
        typeof t.description,
        "string",
        `Tool '${name}' must have a string description`,
      );
      assert.ok(
        (t.description as string).length > 0,
        `Tool '${name}' description must be non-empty`,
      );
      assert.ok(
        t.parameters !== undefined && t.parameters !== null,
        `Tool '${name}' must have a parameters property (Zod schema)`,
      );
    }
  });
});
