/**
 * P-AUTO-13 Step 3 — Test Scaffold — T-A13.RAA.1..2 (G-A13.6)
 *
 * Covers:
 *   G-A13.6 — recordAutoAction Zod schema accepts result:'skipped' unchanged
 *   (regression guard — phase does NOT modify recordAutoAction; this scaffold
 *   ensures a future refactor cannot drop 'skipped' from the enum and break
 *   the M6 ledger contract).
 *
 * Since P-AUTO-13 does NOT change recordAutoAction.ts, these tests should
 * PASS at Step 3 (confirming the pre-existing 'skipped' support) and remain
 * passing at Step 5. They are intentionally regression guards, not new-behavior
 * scaffolds.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/sales/recordAutoAction-pAuto13.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution
type AnyFn = (...args: any[]) => any;

let makeRecordAutoActionTool: AnyFn | null = null;
let openSalesDatabase: AnyFn | null = null;
let insertAutoRun: AnyFn | null = null;

before(async () => {
  const toolMod = await import("../../../src/tools/sales/recordAutoAction.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  makeRecordAutoActionTool = (toolMod as any)?.makeRecordAutoActionTool ?? null;

  const dbMod = await import("../../../src/persistence/salesDb.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  openSalesDatabase = (dbMod as any)?.openSalesDatabase ?? null;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  insertAutoRun = (dbMod as any)?.insertAutoRun ?? null;
});

function makeTmpPath(): string {
  return join(tmpdir(), `recordAutoAction-pAuto13-${randomUUID()}.sqlite`);
}

describe("T-A13.RAA — record_auto_action Zod schema accepts result:'skipped' (G-A13.6, P-AUTO-13 regression guard)", () => {

  // ─── T-A13.RAA.1 ─────────────────────────────────────────────────────────
  it("T-A13.RAA.1: record_auto_action({actionType:'connect_sent', result:'skipped'}) parses and returns ok:true with ledgerId", async () => {
    // Given: a running auto_run R; record_auto_action tool available
    // When:  tool.execute({runId:R, actionType:'connect_sent', result:'skipped'}) called
    // Then:  Zod parse succeeds; appendAutoLedger is called; envelope is ok:true with data.ledgerId + data.runId
    //        (Phase does NOT modify recordAutoAction — this confirms pre-existing 'skipped' support)

    assert.ok(makeRecordAutoActionTool !== null, "T-A13.RAA.1: makeRecordAutoActionTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-A13.RAA.1: openSalesDatabase must be importable");
    assert.ok(insertAutoRun !== null, "T-A13.RAA.1: insertAutoRun must be importable");

    const tmpPath = makeTmpPath();
    const db = openSalesDatabase!(tmpPath);
    const runRow = insertAutoRun!(db, { maxDurationMinutes: 30, maxConnects: 5 });

    const tool = makeRecordAutoActionTool!(tmpPath);
    const result = await tool.execute({
      runId: runRow.id,
      actionType: "connect_sent",
      result: "skipped",
    });

    assert.ok(result.ok === true, `T-A13.RAA.1: result:'skipped' must parse and return ok:true; got: ${JSON.stringify(result)}`);
    assert.ok(result.data?.ledgerId, "T-A13.RAA.1: must return data.ledgerId");
    assert.strictEqual(result.data?.runId, runRow.id, "T-A13.RAA.1: must return data.runId matching the seeded runId");

    // Verify the ledger row was written with result='skipped'
    const row = db
      .prepare("SELECT result FROM auto_run_ledger WHERE id = ?")
      .get(result.data.ledgerId) as { result: string } | undefined;
    assert.ok(row !== undefined, "T-A13.RAA.1: a ledger row must be inserted");
    assert.strictEqual(row?.result, "skipped", "T-A13.RAA.1: ledger row must have result='skipped'");
  });

  // ─── T-A13.RAA.2 ─────────────────────────────────────────────────────────
  it("T-A13.RAA.2: record_auto_action rejects result:'invalid_result_type' with Zod parse failure (schema boundary confirmed)", async () => {
    // Given: a running auto_run R
    // When:  tool.execute({runId:R, actionType:'connect_sent', result:'invalid_result_type'}) called
    // Then:  Zod parse fails → tool returns ok:false with error.kind='invalid_input'; no ledger row inserted

    assert.ok(makeRecordAutoActionTool !== null, "T-A13.RAA.2: makeRecordAutoActionTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-A13.RAA.2: openSalesDatabase must be importable");
    assert.ok(insertAutoRun !== null, "T-A13.RAA.2: insertAutoRun must be importable");

    const tmpPath = makeTmpPath();
    const db = openSalesDatabase!(tmpPath);
    const runRow = insertAutoRun!(db, { maxDurationMinutes: 30, maxConnects: 5 });

    const tool = makeRecordAutoActionTool!(tmpPath);
    const result = await tool.execute({
      runId: runRow.id,
      actionType: "connect_sent",
      // biome-ignore lint/suspicious/noExplicitAny: intentional invalid payload for schema rejection test
      result: "invalid_result_type" as any,
    });

    assert.ok(result.ok === false, `T-A13.RAA.2: invalid result type must return ok:false; got: ${JSON.stringify(result)}`);

    // No ledger row should have been inserted
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM auto_run_ledger WHERE run_id = ?")
      .get(runRow.id) as { n: number };
    assert.strictEqual(count.n, 0, "T-A13.RAA.2: no ledger row must be inserted for an invalid result type");
  });
});
