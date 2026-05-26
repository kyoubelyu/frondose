/**
 * P-SP-A mock tests — T-SP-A.AutoRun.1..3
 * get_auto_run_state + record_auto_action tools.
 *
 * Step 5: assertion bodies filled.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeSalesDatabase, openSalesDatabase } from "../../src/persistence/salesDb.js";
import { makeGetAutoRunStateTool } from "../../src/tools/sales/getAutoRunState.js";
import { makeRecordAutoActionTool } from "../../src/tools/sales/recordAutoAction.js";
import { seedAutoRun } from "./_fixtures/salesDb.js";

describe("T-SP-A.AutoRun — get_auto_run_state + record_auto_action tools", () => {
  // ─── T-SP-A.AutoRun.1 ────────────────────────────────────────────────────────
  it("T-SP-A.AutoRun.1: get_auto_run_state when no active run returns {run:null, counters:{}}", async () => {
    // Given: empty auto_runs table (fresh :memory: DB)
    // When:  get_auto_run_state({}) invoked
    // Then:  tool returns {ok:true, data:{run:null, counters:{}}}
    closeSalesDatabase(":memory:");
    openSalesDatabase(":memory:");

    const tool = makeGetAutoRunStateTool(":memory:");
    const result = await (tool.execute as Function)({});

    assert.ok(result.ok, "Tool must return ok:true");
    assert.strictEqual(result.command, "get_auto_run_state");
    assert.strictEqual(result.data.run, null, "run must be null when no active auto run");
    assert.deepStrictEqual(result.data.counters, {}, "counters must be empty object");
  });

  // ─── T-SP-A.AutoRun.2 ────────────────────────────────────────────────────────
  it("T-SP-A.AutoRun.2: record_auto_action increments ledger; get_auto_run_state reflects counters", async () => {
    // Given: auto_runs row with status='running' (id=R1); empty auto_run_ledger
    // When:  record_auto_action({runId:R1, actionType:'connect_sent', leadId:'L1', result:'success'}) invoked twice
    // Then:  auto_run_ledger has 2 rows for runId=R1; each ts is populated;
    //        get_auto_run_state({}) returns {run:{id:R1, status:'running'}, counters:{connect_sent:2}}
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");
    const runId = seedAutoRun(db);

    const actionTool = makeRecordAutoActionTool(":memory:");

    const r1 = await (actionTool.execute as Function)({
      runId,
      actionType: "connect_sent",
      result: "success",
    });
    assert.ok(r1.ok, "First record_auto_action must return ok:true");
    assert.ok(r1.data.ledgerId, "Must return a ledgerId");
    assert.strictEqual(r1.data.runId, runId);

    const r2 = await (actionTool.execute as Function)({
      runId,
      actionType: "connect_sent",
      result: "success",
    });
    assert.ok(r2.ok, "Second record_auto_action must return ok:true");

    // Verify 2 ledger rows exist, each with ts set
    const ledgerRows = db
      .prepare("SELECT ts FROM auto_run_ledger WHERE run_id = ?")
      .all(runId) as { ts: number }[];
    assert.strictEqual(ledgerRows.length, 2, "Must have 2 ledger rows");
    for (const row of ledgerRows) {
      assert.ok(row.ts > 0, "Each ledger row must have ts populated");
    }

    // get_auto_run_state reflects counters
    const stateTool = makeGetAutoRunStateTool(":memory:");
    const stateResult = await (stateTool.execute as Function)({});

    assert.ok(stateResult.ok, "get_auto_run_state must return ok:true");
    assert.ok(stateResult.data.run, "run must not be null when active run exists");
    assert.strictEqual(stateResult.data.run.id, runId);
    assert.strictEqual(stateResult.data.run.status, "running");
    assert.strictEqual(
      stateResult.data.counters.connect_sent,
      2,
      "counters.connect_sent must be 2 after two ledger inserts",
    );
  });

  // ─── T-SP-A.AutoRun.3 ────────────────────────────────────────────────────────
  it("T-SP-A.AutoRun.3: record_auto_action rejects unknown runId", async () => {
    // Given: empty auto_runs table (no matching runId)
    // When:  record_auto_action({runId:'nonexistent', actionType:'connect_sent', result:'success'}) invoked
    // Then:  tool returns {ok:false, error:{kind:'not_found'}}; no ledger row inserted
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");

    const tool = makeRecordAutoActionTool(":memory:");
    const result = await (tool.execute as Function)({
      runId: "nonexistent-run-id",
      actionType: "connect_sent",
      result: "success",
    });

    assert.strictEqual(result.ok, false, "Must return ok:false for unknown runId");
    assert.strictEqual(result.error.kind, "not_found");

    const ledgerCount = db
      .prepare("SELECT COUNT(*) AS n FROM auto_run_ledger")
      .get() as { n: number };
    assert.strictEqual(ledgerCount.n, 0, "No ledger row must be inserted for unknown runId");
  });
});
