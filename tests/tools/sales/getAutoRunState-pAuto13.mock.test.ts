/**
 * P-AUTO-13 Step 3 — Test Scaffold — T-A13.State.1..4 (G-A13.7 advisory path)
 *
 * Covers:
 *   G-A13.7 (advisory path) — getAutoRunState.connectsRemaining uses success-only
 *   count (countSuccessfulConnects) so skipped/failed connect_sent rows do NOT
 *   decrement the operator's connect budget.
 *
 * Companion to tests/persistence/sales/countSuccessfulConnects-pAuto13.mock.test.ts
 * (which tests the raw DB helper) and the G-A9.6 update in getAutoRunState.test.ts
 * (which tests the semantic change to the existing mixed-row test).
 *
 * Invariant pinned here: countSuccessfulConnects-based connectsRemaining matches
 * the serve.ts hard-gate's connectSentCount at all times (P-AUTO-9 invariant preserved,
 * now success-filtered on both sides per P-AUTO-13 §4a).
 *
 * Step-3 compile note:
 *   Before builder Step 4, getAutoRunState still uses countAutoLedgerByAction (all-rows)
 *   for connectsRemaining. Tests T-A13.State.1..3 (the mixed-row cases) will FAIL at
 *   Step 3 because the current code returns connectsRemaining === 0 for Case A (all 3
 *   rows counted), not 2 (1 success only). T-A13.State.4 (all-success case) may PASS
 *   because the current and new formulas agree when all rows are success.
 *   All tests compile and reach the assertion — intentional Step-3 red-state.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/sales/getAutoRunState-pAuto13.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution before builder Step 4
type AnyFn = (...args: any[]) => any;

function makeTmpPath(): string {
  return join(tmpdir(), `getAutoRunState-pAuto13-${randomUUID()}.sqlite`);
}

/**
 * Seed a running auto_runs row in a fresh DB. Returns { db, runId }.
 */
// biome-ignore lint/suspicious/noExplicitAny: test DB handle
async function seedRunningAutoRun(
  tmpPath: string,
  maxConnects: number | null = 3,
): Promise<{ db: any; runId: string }> {
  const { openSalesDatabase } = (await import("../../../src/persistence/salesDb.js")) as any;
  const db = openSalesDatabase(tmpPath);
  const runId = randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, now, null, 480, maxConnects, "running", null, null);
  return { db, runId };
}

/**
 * Insert a connect_sent row with a given result for the given run.
 */
// biome-ignore lint/suspicious/noExplicitAny: test DB handle
function insertConnectRow(db: any, runId: string, result: string): void {
  db.prepare(
    "INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, result, ts) VALUES (?, ?, 'connect_sent', NULL, ?, ?)",
  ).run(randomUUID(), runId, result, Date.now());
}

describe("T-A13.State — getAutoRunState connectsRemaining: success-only filter (G-A13.7, P-AUTO-13)", () => {

  // ─── T-A13.State.1 — Case A: 1 success + 2 skipped ───────────────────────
  it("T-A13.State.1: Case A (1 success + 2 skipped rows, maxConnects=3) → connectsRemaining===2, counters.connect_sent===3", async () => {
    // Given: auto_run R with maxConnects=3;
    //        auto_run_ledger: 1 connect_sent/success + 2 connect_sent/skipped
    // When:  makeGetAutoRunStateTool(tmpPath).execute({}) called
    // Then:  result.data.connectsRemaining === 2 (only 1 success counts)
    //        AND result.data.counters.connect_sent === 3 (all-rows view preserved for summary)
    //        FAIL at Step 3: pre-P-AUTO-13 code returns connectsRemaining===0 (all-rows formula)

    const tmpPath = makeTmpPath();
    const { db, runId } = await seedRunningAutoRun(tmpPath, 3);
    insertConnectRow(db, runId, "success");
    insertConnectRow(db, runId, "skipped");
    insertConnectRow(db, runId, "skipped");

    const mod = await import("../../../src/tools/sales/getAutoRunState.js").catch(() => null);
    const makeGetAutoRunStateTool: AnyFn = (mod as any)?.makeGetAutoRunStateTool ?? null;
    if (!makeGetAutoRunStateTool) {
      assert.ok(false, "T-A13.State.1: makeGetAutoRunStateTool not exported — builder Step 4 not done");
      return;
    }
    const tool = makeGetAutoRunStateTool(tmpPath);
    const result = await tool.execute({});

    assert.ok(result.ok === true, `T-A13.State.1: ok must be true; got: ${JSON.stringify(result)}`);

    // TODO (assertion body — filled at Step 5):
    // assert.strictEqual(result.data.connectsRemaining, 2, "1 success → connectsRemaining = maxConnects - 1 = 2");
    // assert.strictEqual(result.data.counters.connect_sent, 3, "all-rows view still shows 3 for the summary");

    assert.strictEqual(
      result.data.connectsRemaining,
      2,
      `T-A13.State.1: connectsRemaining must be 2 (maxConnects=3, 1 success); got ${result.data.connectsRemaining}`,
    );
    assert.strictEqual(
      result.data.counters.connect_sent,
      3,
      `T-A13.State.1: counters.connect_sent (all-rows) must be 3; got ${result.data.counters.connect_sent}`,
    );
  });

  // ─── T-A13.State.2 — Case B: 0 success + 3 failed ────────────────────────
  it("T-A13.State.2: Case B (0 success + 3 failed rows, maxConnects=3) → connectsRemaining===3, counters.connect_sent===3", async () => {
    // Given: auto_run R with maxConnects=3; ledger: 3 connect_sent/failed rows
    // When:  makeGetAutoRunStateTool(tmpPath).execute({}) called
    // Then:  result.data.connectsRemaining === 3 (no success rows consume budget)
    //        AND result.data.counters.connect_sent === 3 (all-rows view)
    //        FAIL at Step 3: current code returns connectsRemaining===0

    const tmpPath = makeTmpPath();
    const { db, runId } = await seedRunningAutoRun(tmpPath, 3);
    insertConnectRow(db, runId, "failed");
    insertConnectRow(db, runId, "failed");
    insertConnectRow(db, runId, "failed");

    const mod = await import("../../../src/tools/sales/getAutoRunState.js").catch(() => null);
    const makeGetAutoRunStateTool: AnyFn = (mod as any)?.makeGetAutoRunStateTool ?? null;
    if (!makeGetAutoRunStateTool) {
      assert.ok(false, "T-A13.State.2: makeGetAutoRunStateTool not exported — builder Step 4 not done");
      return;
    }
    const tool = makeGetAutoRunStateTool(tmpPath);
    const result = await tool.execute({});

    assert.ok(result.ok === true, `T-A13.State.2: ok must be true; got: ${JSON.stringify(result)}`);

    // TODO (assertion body — filled at Step 5):
    // assert.strictEqual(result.data.connectsRemaining, 3, "0 success → budget fully intact");
    // assert.strictEqual(result.data.counters.connect_sent, 3, "all-rows summary still shows 3");

    assert.strictEqual(
      result.data.connectsRemaining,
      3,
      `T-A13.State.2: connectsRemaining must be 3 (no success rows); got ${result.data.connectsRemaining}`,
    );
    assert.strictEqual(
      result.data.counters.connect_sent,
      3,
      `T-A13.State.2: counters.connect_sent (all-rows) must be 3; got ${result.data.counters.connect_sent}`,
    );
  });

  // ─── T-A13.State.3 — Case C: 3 success rows (cap exhausted) ───────────────
  it("T-A13.State.3: Case C (3 success rows, maxConnects=3) → connectsRemaining===0, counters.connect_sent===3", async () => {
    // Given: auto_run R with maxConnects=3; ledger: 3 connect_sent/success rows
    // When:  makeGetAutoRunStateTool(tmpPath).execute({}) called
    // Then:  result.data.connectsRemaining === 0 (cap exhausted — all 3 were real sends)
    //        AND result.data.counters.connect_sent === 3
    //        This case should PASS at Step 3 and Step 5 (all-rows = success-only when all are success)

    const tmpPath = makeTmpPath();
    const { db, runId } = await seedRunningAutoRun(tmpPath, 3);
    insertConnectRow(db, runId, "success");
    insertConnectRow(db, runId, "success");
    insertConnectRow(db, runId, "success");

    const mod = await import("../../../src/tools/sales/getAutoRunState.js").catch(() => null);
    const makeGetAutoRunStateTool: AnyFn = (mod as any)?.makeGetAutoRunStateTool ?? null;
    if (!makeGetAutoRunStateTool) {
      assert.ok(false, "T-A13.State.3: makeGetAutoRunStateTool not exported — builder Step 4 not done");
      return;
    }
    const tool = makeGetAutoRunStateTool(tmpPath);
    const result = await tool.execute({});

    assert.ok(result.ok === true, `T-A13.State.3: ok must be true; got: ${JSON.stringify(result)}`);

    // TODO (assertion body — filled at Step 5):
    // assert.strictEqual(result.data.connectsRemaining, 0);
    // assert.strictEqual(result.data.counters.connect_sent, 3);

    assert.strictEqual(
      result.data.connectsRemaining,
      0,
      `T-A13.State.3: connectsRemaining must be 0 (3 success, maxConnects=3); got ${result.data.connectsRemaining}`,
    );
    assert.strictEqual(
      result.data.counters.connect_sent,
      3,
      `T-A13.State.3: counters.connect_sent must be 3; got ${result.data.counters.connect_sent}`,
    );
  });

  // ─── T-A13.State.4 — invariant: advisory matches hard gate ─────────────────
  it("T-A13.State.4: connectsRemaining in the advisory (getAutoRunState) matches the hard gate's truth (P-AUTO-9 invariant preserved)", async () => {
    // Given: auto_run R with maxConnects=5; ledger: 1 success + 2 skipped + 1 failed
    // When:  makeGetAutoRunStateTool(tmpPath).execute({}) and countSuccessfulConnects(db, R) called
    // Then:  result.data.connectsRemaining === maxConnects - countSuccessfulConnects(db, R)
    //        i.e. === 5 - 1 === 4 in both cases
    //        Pins the P-AUTO-9 "advisory === hard gate truth" invariant now that both sides
    //        use the success filter.
    //        FAIL at Step 3: current code has connectsRemaining = maxConnects - all-rows-count = 5 - 4 = 1

    const tmpPath = makeTmpPath();
    const { db, runId } = await seedRunningAutoRun(tmpPath, 5);
    insertConnectRow(db, runId, "success");
    insertConnectRow(db, runId, "skipped");
    insertConnectRow(db, runId, "skipped");
    insertConnectRow(db, runId, "failed");

    const mod = await import("../../../src/tools/sales/getAutoRunState.js").catch(() => null);
    const makeGetAutoRunStateTool: AnyFn = (mod as any)?.makeGetAutoRunStateTool ?? null;
    if (!makeGetAutoRunStateTool) {
      assert.ok(false, "T-A13.State.4: makeGetAutoRunStateTool not exported — builder Step 4 not done");
      return;
    }
    const tool = makeGetAutoRunStateTool(tmpPath);
    const result = await tool.execute({});

    const dbMod = await import("../../../src/persistence/salesDb.js").catch(() => null);
    const countSuccessfulConnects: AnyFn | null = (dbMod as any)?.countSuccessfulConnects ?? null;

    assert.ok(result.ok === true, `T-A13.State.4: ok must be true; got: ${JSON.stringify(result)}`);

    // TODO (assertion body — filled at Step 5):
    // const successCount = countSuccessfulConnects!(db, runId); // 1
    // assert.strictEqual(result.data.connectsRemaining, 5 - successCount); // 4
    // assert.strictEqual(result.data.counters.connect_sent, 4); // all-rows view

    assert.strictEqual(
      result.data.connectsRemaining,
      4,
      `T-A13.State.4: connectsRemaining must be 4 (maxConnects=5, 1 success); got ${result.data.connectsRemaining}`,
    );
    assert.strictEqual(
      result.data.counters.connect_sent,
      4,
      `T-A13.State.4: counters.connect_sent (all-rows) must be 4; got ${result.data.counters.connect_sent}`,
    );

    // Confirm advisory === hard gate's truth via the raw helper
    if (countSuccessfulConnects) {
      const successCount = countSuccessfulConnects(db, runId);
      assert.strictEqual(
        result.data.connectsRemaining,
        5 - successCount,
        `T-A13.State.4: connectsRemaining must equal maxConnects - countSuccessfulConnects; got connectsRemaining=${result.data.connectsRemaining}, successCount=${successCount}`,
      );
    }
  });
});
