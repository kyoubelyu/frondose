/**
 * P-AUTO-13 Step 3 — Test Scaffold — T-A13.Count.1..5 (G-A13.7 persistence side)
 *
 * Covers:
 *   G-A13.7 (persistence helper) — countSuccessfulConnects(db, runId) counts ONLY
 *   connect_sent rows with result='success'; skipped and failed rows are NOT counted.
 *
 * Design: seeds an in-process temp-file sales DB with known ledger mixes,
 * then calls the new helper. Uses the same openSalesDatabase + prep pattern
 * as tests/persistence/salesDb-autoRun.mock.test.ts.
 *
 * Step-3 compile note:
 *   countSuccessfulConnects does NOT exist until builder Step 4. The `before()`
 *   block imports it with a fallback to null; if null, each test fails immediately
 *   at the assert.ok(countSuccessfulConnects !== null) check — intentional Step-3
 *   red-state behavior (compilation succeeds; runtime fails at the first assertion).
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/persistence/sales/countSuccessfulConnects-pAuto13.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution before builder Step 4
type AnyFn = (...args: any[]) => any;

let countSuccessfulConnects: AnyFn | null = null;
let openSalesDatabase: AnyFn | null = null;

before(async () => {
  const dbMod = await import("../../../src/persistence/salesDb.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  countSuccessfulConnects = (dbMod as any)?.countSuccessfulConnects ?? null;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  openSalesDatabase = (dbMod as any)?.openSalesDatabase ?? null;
});

function makeTmpPath(): string {
  return join(tmpdir(), `countSuccessfulConnects-pAuto13-${randomUUID()}.sqlite`);
}

/** Seed a running auto_run row and return { db, runId }. */
// biome-ignore lint/suspicious/noExplicitAny: test DB handle
function seedRunWithAutoRun(tmpPath: string, maxConnects = 3): { db: any; runId: string } {
  const db = openSalesDatabase!(tmpPath);
  const runId = randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, now, null, 480, maxConnects, "running", null, null);
  return { db, runId };
}

/** Insert a connect_sent ledger row with the given result. */
// biome-ignore lint/suspicious/noExplicitAny: test DB handle
function insertConnectRow(db: any, runId: string, result: string): void {
  db.prepare(
    "INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, result, ts) VALUES (?, ?, 'connect_sent', NULL, ?, ?)",
  ).run(randomUUID(), runId, result, Date.now());
}

describe("T-A13.Count — countSuccessfulConnects(db, runId): success-only filter (G-A13.7 persistence, P-AUTO-13)", () => {

  // ─── T-A13.Count.1 — Case A: 1 success + 2 skipped ───────────────────────
  it("T-A13.Count.1: 1 success + 2 skipped rows → countSuccessfulConnects returns 1 (skipped rows not counted)", async () => {
    // Given: auto_run R, maxConnects=3;
    //        ledger: 1 connect_sent/success + 2 connect_sent/skipped
    // When:  countSuccessfulConnects(db, R) called
    // Then:  returns 1 (only the success row counts; skipped rows are ignored)

    assert.ok(countSuccessfulConnects !== null, "T-A13.Count.1: countSuccessfulConnects must be exported (not yet at Step 3)");
    assert.ok(openSalesDatabase !== null, "T-A13.Count.1: openSalesDatabase must be importable");

    const tmpPath = makeTmpPath();
    const { db, runId } = seedRunWithAutoRun(tmpPath, 3);
    insertConnectRow(db, runId, "success");
    insertConnectRow(db, runId, "skipped");
    insertConnectRow(db, runId, "skipped");

    // TODO (assertion body — filled at Step 5):
    // const count = countSuccessfulConnects!(db, runId);
    // assert.strictEqual(count, 1, "only 1 success row → count must be 1");

    const count = countSuccessfulConnects!(db, runId);
    assert.strictEqual(
      count,
      1,
      `T-A13.Count.1: 1 success + 2 skipped → countSuccessfulConnects must return 1; got ${count}`,
    );
  });

  // ─── T-A13.Count.2 — Case B: 0 success + 3 failed ────────────────────────
  it("T-A13.Count.2: 0 success rows + 3 failed rows → countSuccessfulConnects returns 0 (failed rows not counted)", async () => {
    // Given: auto_run R; ledger: 3 connect_sent/failed rows, 0 connect_sent/success
    // When:  countSuccessfulConnects(db, R) called
    // Then:  returns 0 (no success rows; failed rows never consume connect budget)

    assert.ok(countSuccessfulConnects !== null, "T-A13.Count.2: countSuccessfulConnects must be exported");
    assert.ok(openSalesDatabase !== null, "T-A13.Count.2: openSalesDatabase must be importable");

    const tmpPath = makeTmpPath();
    const { db, runId } = seedRunWithAutoRun(tmpPath, 3);
    insertConnectRow(db, runId, "failed");
    insertConnectRow(db, runId, "failed");
    insertConnectRow(db, runId, "failed");

    // TODO (assertion body — filled at Step 5):
    // const count = countSuccessfulConnects!(db, runId);
    // assert.strictEqual(count, 0);

    const count = countSuccessfulConnects!(db, runId);
    assert.strictEqual(
      count,
      0,
      `T-A13.Count.2: 3 failed rows → countSuccessfulConnects must return 0; got ${count}`,
    );
  });

  // ─── T-A13.Count.3 — Case C: 3 success rows ───────────────────────────────
  it("T-A13.Count.3: 3 success rows → countSuccessfulConnects returns 3 (cap exhausted)", async () => {
    // Given: auto_run R, maxConnects=3; ledger: 3 connect_sent/success rows
    // When:  countSuccessfulConnects(db, R) called
    // Then:  returns 3 (all 3 rows are success; cap is now exhausted)

    assert.ok(countSuccessfulConnects !== null, "T-A13.Count.3: countSuccessfulConnects must be exported");
    assert.ok(openSalesDatabase !== null, "T-A13.Count.3: openSalesDatabase must be importable");

    const tmpPath = makeTmpPath();
    const { db, runId } = seedRunWithAutoRun(tmpPath, 3);
    insertConnectRow(db, runId, "success");
    insertConnectRow(db, runId, "success");
    insertConnectRow(db, runId, "success");

    // TODO (assertion body — filled at Step 5):
    // const count = countSuccessfulConnects!(db, runId);
    // assert.strictEqual(count, 3);

    const count = countSuccessfulConnects!(db, runId);
    assert.strictEqual(
      count,
      3,
      `T-A13.Count.3: 3 success rows → countSuccessfulConnects must return 3; got ${count}`,
    );
  });

  // ─── T-A13.Count.4 — mixed all result types ────────────────────────────────
  it("T-A13.Count.4: 2 success + 1 failed + 2 skipped rows → countSuccessfulConnects returns 2", async () => {
    // Given: auto_run R; ledger: 2 success + 1 failed + 2 skipped connect_sent rows
    // When:  countSuccessfulConnects(db, R) called
    // Then:  returns 2 (only success rows count)

    assert.ok(countSuccessfulConnects !== null, "T-A13.Count.4: countSuccessfulConnects must be exported");
    assert.ok(openSalesDatabase !== null, "T-A13.Count.4: openSalesDatabase must be importable");

    const tmpPath = makeTmpPath();
    const { db, runId } = seedRunWithAutoRun(tmpPath, 5);
    insertConnectRow(db, runId, "success");
    insertConnectRow(db, runId, "success");
    insertConnectRow(db, runId, "failed");
    insertConnectRow(db, runId, "skipped");
    insertConnectRow(db, runId, "skipped");

    // TODO (assertion body — filled at Step 5):
    // const count = countSuccessfulConnects!(db, runId);
    // assert.strictEqual(count, 2);

    const count = countSuccessfulConnects!(db, runId);
    assert.strictEqual(
      count,
      2,
      `T-A13.Count.4: 2 success + others → countSuccessfulConnects must return 2; got ${count}`,
    );
  });

  // ─── T-A13.Count.5 — run isolation ─────────────────────────────────────────
  it("T-A13.Count.5: rows for a different run_id are NOT counted (run isolation)", async () => {
    // Given: two runs R1 and R2; R1 has 3 success rows; R2 has 0 rows
    // When:  countSuccessfulConnects(db, R2.id) called
    // Then:  returns 0 (R1's rows do not bleed into R2's count)

    assert.ok(countSuccessfulConnects !== null, "T-A13.Count.5: countSuccessfulConnects must be exported");
    assert.ok(openSalesDatabase !== null, "T-A13.Count.5: openSalesDatabase must be importable");

    // Share one DB to test cross-run isolation
    const tmpPath = makeTmpPath();
    const { db, runId: r1Id } = seedRunWithAutoRun(tmpPath, 3);

    // Insert a second run in the same DB
    const r2Id = randomUUID();
    db.prepare(
      "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(r2Id, Date.now() + 1, null, 480, 3, "running", null, null);

    // R1 has 3 success rows; R2 has 0
    insertConnectRow(db, r1Id, "success");
    insertConnectRow(db, r1Id, "success");
    insertConnectRow(db, r1Id, "success");

    // TODO (assertion body — filled at Step 5):
    // assert.strictEqual(countSuccessfulConnects!(db, r2Id), 0, "R2 must not count R1's rows");
    // assert.strictEqual(countSuccessfulConnects!(db, r1Id), 3, "R1 count still correct");

    const r2Count = countSuccessfulConnects!(db, r2Id);
    const r1Count = countSuccessfulConnects!(db, r1Id);
    assert.strictEqual(
      r2Count,
      0,
      `T-A13.Count.5: R2 must return 0 (R1's rows must not bleed into R2); got ${r2Count}`,
    );
    assert.strictEqual(
      r1Count,
      3,
      `T-A13.Count.5: R1 must still return 3; got ${r1Count}`,
    );
  });
});
