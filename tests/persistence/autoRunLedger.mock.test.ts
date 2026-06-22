/**
 * P-MSG-SEND-LEDGER Step 2 — Test Scaffold — T-LedgerNull.1..4
 *
 * Covers appendAutoLedger(runId=null) acceptance and the cross-run vs per-run
 * counting semantics of null-run rows. Assertion bodies filled at Step 5.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/persistence/autoRunLedger.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: dynamic imports before builder Step 4
type AnyFn = (...args: any[]) => any;

let openSalesDatabase: AnyFn;
let appendAutoLedger: AnyFn;
let countSuccessfulConnects: AnyFn;
let countOutboundSince: AnyFn;
let lastOutboundAt: AnyFn;

before(async () => {
  const salesMod = await import("../../src/persistence/salesDb.js");
  openSalesDatabase = salesMod.openSalesDatabase;
  appendAutoLedger = salesMod.appendAutoLedger;
  countSuccessfulConnects = salesMod.countSuccessfulConnects;
  countOutboundSince = salesMod.countOutboundSince;
  lastOutboundAt = salesMod.lastOutboundAt;
});

function makeTmpPath(): string {
  return join(tmpdir(), `autoRunLedger-null-${randomUUID()}.sqlite`);
}

describe("T-LedgerNull — appendAutoLedger(runId=null) + per-run vs cross-run counting (P-MSG-SEND-LEDGER)", () => {

  // ─── T-LedgerNull.1 ───────────────────────────────────────────────────────────
  it("T-LedgerNull.1: runId=null insert succeeds — appendAutoLedger returns a uuid; run_id IS NULL in DB", () => {
    // Given: a v4 DB (fresh file-backed DB, openSalesDatabase runs migrations including v4)
    // When:  appendAutoLedger(db, {runId: null, actionType: "connect_sent", result: "success"})
    // Then:  the function returns a uuid (non-empty string)
    //        AND SELECT run_id FROM auto_run_ledger WHERE id = <returned id> returns null
    const db = openSalesDatabase(makeTmpPath());

    const returnedId = appendAutoLedger(db, { runId: null, actionType: "connect_sent", result: "success" });
    assert.ok(typeof returnedId === "string" && returnedId.length > 0, "appendAutoLedger must return a uuid");
    const row = db.prepare("SELECT run_id FROM auto_run_ledger WHERE id = ?").get(returnedId) as { run_id: string | null } | undefined;
    assert.ok(row !== undefined, "ledger row must exist with the returned id");
    assert.strictEqual(row!.run_id, null, "run_id must be null for a Manual/null-run ledger row");
  });

  // ─── T-LedgerNull.2 ───────────────────────────────────────────────────────────
  it("T-LedgerNull.2: null-run rows do NOT count toward per-run cap — countSuccessfulConnects(db, 'R1') excludes run_id=NULL rows", () => {
    // Given: a v4 DB with one auto_run_ledger row (run_id='R1', action_type='connect_sent', result='success')
    //        AND one row (run_id=NULL, action_type='connect_sent', result='success')
    // When:  countSuccessfulConnects(db, 'R1')
    // Then:  result is 1 (the null-run row is excluded by the existing run_id = ? filter;
    //        SQLite's NULL = 'R1' is never true → null rows categorically excluded)
    //        Covers the no-per-run-cap-regression gate.
    const db = openSalesDatabase(makeTmpPath());
    const r1 = randomUUID();
    const now = Date.now();

    // Seed an auto_runs row for R1 (FK requirement for non-null run_id)
    db.prepare(
      "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL)",
    ).run(r1, now, 480, 5, "running");

    // Insert R1 row (non-null run_id) using appendAutoLedger
    appendAutoLedger(db, { runId: r1, actionType: "connect_sent", result: "success" });

    // Insert null-run row using appendAutoLedger (v4 allows null runId)
    appendAutoLedger(db, { runId: null, actionType: "connect_sent", result: "success" });

    const count = countSuccessfulConnects(db, r1);
    assert.strictEqual(count, 1, "countSuccessfulConnects must return 1 — null-run row excluded by WHERE run_id = ?");
  });

  // ─── T-LedgerNull.3 ───────────────────────────────────────────────────────────
  it("T-LedgerNull.3: null-run rows DO count toward cross-run daily total — countOutboundSince includes run_id=NULL rows", () => {
    // Given: a v4 DB with one row (run_id=NULL, action_type='message_sent', result='success', ts=now)
    //        AND one row (run_id='R1', action_type='connect_sent', result='success', ts=now)
    // When:  countOutboundSince(db, now - 1)
    // Then:  result is 2 (global query has no run_id filter; both rows counted)
    //        Covers "Manual activity still contributes to the daily total Auto reads"
    const db = openSalesDatabase(makeTmpPath());
    const r1 = randomUUID();
    const now = Date.now();

    // Seed an auto_runs row for R1
    db.prepare(
      "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL)",
    ).run(r1, now, 480, 5, "running");

    // Insert null-run row (message_sent) using appendAutoLedger
    appendAutoLedger(db, { runId: null, actionType: "message_sent", result: "success" });

    // Insert R1 row (connect_sent)
    appendAutoLedger(db, { runId: r1, actionType: "connect_sent", result: "success" });

    const count = countOutboundSince(db, now - 2000);
    assert.strictEqual(count, 2, "countOutboundSince must return 2 — null-run row included (no run_id filter)");
  });

  // ─── T-LedgerNull.4 ───────────────────────────────────────────────────────────
  it("T-LedgerNull.4: null-run rows DO count for cooldown — lastOutboundAt includes run_id=NULL rows", () => {
    // Given: a v4 DB with one R1 row (run_id=R1, ts=now-1000, the OLDER row)
    //        AND one null-run row (run_id=NULL, ts=now-500, the NEWER row)
    // When:  lastOutboundAt(db)
    // Then:  result equals ts2 (the null-run row's ts) — the null-run row is included in the MAX scan
    //        Covers "Manual sends pace Auto's cooldown"
    //        Assertion is load-bearing: if lastOutboundAt filtered out null-run rows it would
    //        return ts1 (the R1 row's ts), causing this test to fail.
    const db = openSalesDatabase(makeTmpPath());
    const r1 = randomUUID();
    const now = Date.now();

    // Seed an auto_runs row for R1
    db.prepare(
      "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL)",
    ).run(r1, now, 480, 5, "running");

    const ts1 = now - 1000; // R1 row (older — non-null run_id)
    const ts2 = now - 500;  // null-run row (MOST RECENT — run_id IS NULL)

    // Insert R1 row (connect_sent) with specific ts via raw SQL
    db.prepare(
      "INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, ts, count_weight, result) VALUES (?, ?, ?, NULL, ?, 1.0, ?)",
    ).run(randomUUID(), r1, "connect_sent", ts1, "success");

    // Insert null-run row (message_sent) with specific ts via raw SQL to control timestamp
    db.prepare(
      "INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, ts, count_weight, result) VALUES (?, ?, ?, NULL, ?, 1.0, ?)",
    ).run(randomUUID(), null, "message_sent", ts2, "success");

    const last = lastOutboundAt(db);
    // Primary assertion: must return the null-run row's ts (the true MAX)
    assert.strictEqual(last, ts2, "lastOutboundAt must return ts2 (the null-run row's ts, which is the max)");
    // Confirm the null-run row is the one returned, not the R1 row
    assert.notEqual(last, ts1, "lastOutboundAt must NOT return ts1 (the R1 row's ts) — proves null-run row is included");
  });
});
