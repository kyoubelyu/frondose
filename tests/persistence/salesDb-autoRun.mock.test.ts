/**
 * P-SP-E Step 5 — T-E.DB.1..4 (G-PSPE.1..3) — assertions filled.
 * auto_runs DB helpers: insertAutoRun / updateAutoRunStatus / endAutoRun
 *
 * Step 5: assertions filled against Sketch A in salesDb.ts.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/persistence/salesDb-autoRun.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution
type AnyFn = (...args: any[]) => any;

let insertAutoRun: AnyFn;
let updateAutoRunStatus: AnyFn;
let endAutoRun: AnyFn;
let getAutoRun: AnyFn;
let openSalesDatabase: AnyFn;

before(async () => {
  const mod = await import("../../src/persistence/salesDb.js").catch(() => null);
  openSalesDatabase = mod?.openSalesDatabase ?? null;
  insertAutoRun = mod?.insertAutoRun ?? null;
  updateAutoRunStatus = mod?.updateAutoRunStatus ?? null;
  endAutoRun = mod?.endAutoRun ?? null;
  getAutoRun = mod?.getAutoRun ?? null;
});

// Unique per-run path to avoid cross-test cache collisions
function makeTmpPath(): string {
  return join(tmpdir(), `salesDb-autoRun-test-${randomUUID()}.sqlite`);
}

describe("T-E.DB — auto_runs DB helpers (P-SP-E Sketch A)", () => {
  // ─── T-E.DB.1 ────────────────────────────────────────────────────────────────
  it("T-E.DB.1: insertAutoRun({maxDurationMinutes:30, maxConnects:5}) returns AutoRunRow with status='running' and caps preserved", async () => {
    // Given: empty in-memory sales.sqlite; openSalesDatabase + insertAutoRun available
    // When:  insertAutoRun(db, {maxDurationMinutes:30, maxConnects:5}) called
    // Then:  returned row has status='running', started_at≈now, ended_at=null,
    //        maxDurationMinutes=30, maxConnects=5
    const db = openSalesDatabase(makeTmpPath());
    const before = Date.now();
    const row = insertAutoRun(db, { maxDurationMinutes: 30, maxConnects: 5 });
    const after = Date.now();

    assert.equal(row.status, "running", "T-E.DB.1: status must be 'running'");
    assert.equal(row.maxDurationMinutes, 30, "T-E.DB.1: maxDurationMinutes must be 30");
    assert.equal(row.maxConnects, 5, "T-E.DB.1: maxConnects must be 5");
    assert.equal(row.endedAt, null, "T-E.DB.1: endedAt must be null (not yet ended)");
    assert.ok(typeof row.id === "string" && row.id.length > 0, "T-E.DB.1: id must be a non-empty string UUID");
    assert.ok(row.startedAt >= before && row.startedAt <= after, "T-E.DB.1: startedAt must be ≈ Date.now()");
  });

  // ─── T-E.DB.2 ────────────────────────────────────────────────────────────────
  // [P-AUTO-1+2 REVISED] Old assertion: maxConnects=null for omitted caps.
  // New assertion: maxConnects=5 (DEFAULT_AUTO_RUN_MAX_CONNECTS) for omitted caps.
  // Explicit null must still be preserved as opt-out (see T-A2.Def.4 in startAutoRunDefault).
  it("T-E.DB.2: insertAutoRun({}) (no caps) returns row with maxDurationMinutes=480 + maxConnects=5 (DEFAULT, not null)", async () => {
    // Given: empty in-memory sales.sqlite
    // When:  insertAutoRun(db, {}) called with no cap arguments (undefined ≠ explicit null)
    // Then:  returned row has maxDurationMinutes=480 AND maxConnects=5 (DEFAULT_AUTO_RUN_MAX_CONNECTS)
    //        NOTE: this assertion REPLACES the old "null" assertion — null was wrong for omitted caps.
    const db = openSalesDatabase(makeTmpPath());
    const row = insertAutoRun(db, {});

    assert.equal(row.maxDurationMinutes, 480, "T-E.DB.2: default maxDurationMinutes must be 480 (8 hours)");
    assert.equal(row.maxConnects, 5, "T-E.DB.2: omitted maxConnects must default to 5 (DEFAULT_AUTO_RUN_MAX_CONNECTS), not null");
    assert.equal(row.status, "running", "T-E.DB.2: status must be 'running'");
  });

  // ─── T-E.DB.3 ────────────────────────────────────────────────────────────────
  it("T-E.DB.3: updateAutoRunStatus(db, id, 'blocked') mutates row; getAutoRun reads it back", async () => {
    // Given: one auto_runs row inserted with status='running'
    // When:  updateAutoRunStatus(db, id, "blocked") called
    // Then:  getAutoRun(db, id).status === 'blocked' (mutation persisted)
    const db = openSalesDatabase(makeTmpPath());
    const row = insertAutoRun(db, { maxDurationMinutes: 30 });
    assert.equal(row.status, "running", "T-E.DB.3: pre-condition: row should start as running");

    updateAutoRunStatus(db, row.id, "blocked");

    const updated = getAutoRun(db, row.id);
    assert.ok(updated !== null, "T-E.DB.3: getAutoRun must return non-null for known id");
    assert.equal(updated.status, "blocked", "T-E.DB.3: status must be updated to 'blocked'");
    assert.equal(updated.id, row.id, "T-E.DB.3: id must match the original row");
  });

  // ─── T-E.DB.4 ────────────────────────────────────────────────────────────────
  it("T-E.DB.4: endAutoRun sets status+ended_at+summary+counters; subsequent call on same id is a no-op (idempotent)", async () => {
    // Given: one running auto_runs row
    // When:  endAutoRun(db, id, {status:'completed', summary:'All processed', counters:{connect_sent:3}}) called
    // Then:  row has status='completed', ended_at≈now, summary set, counters JSON set;
    //        second endAutoRun call on same id returns {alreadyEnded:true} without mutating ended_at
    const db = openSalesDatabase(makeTmpPath());
    const row = insertAutoRun(db, { maxDurationMinutes: 30, maxConnects: 5 });

    const beforeEnd = Date.now();
    const result1 = endAutoRun(db, row.id, {
      status: "completed",
      summary: "All processed",
      counters: { connect_sent: 3 },
    });
    const afterEnd = Date.now();

    assert.equal(result1.alreadyEnded, false, "T-E.DB.4: first endAutoRun must have alreadyEnded=false");

    const ended = getAutoRun(db, row.id);
    assert.ok(ended !== null, "T-E.DB.4: getAutoRun must find the row");
    assert.equal(ended.status, "completed", "T-E.DB.4: status must be 'completed'");
    assert.ok(
      ended.endedAt !== null && ended.endedAt >= beforeEnd && ended.endedAt <= afterEnd,
      "T-E.DB.4: endedAt must be ≈ now",
    );

    const endedAtT1 = ended.endedAt;

    // Second call — should be idempotent
    const result2 = endAutoRun(db, row.id, {
      status: "stopped_by_agent",
      summary: "Different summary",
      counters: null,
    });

    assert.equal(result2.alreadyEnded, true, "T-E.DB.4: second endAutoRun must have alreadyEnded=true");

    const afterSecond = getAutoRun(db, row.id);
    assert.ok(afterSecond !== null, "T-E.DB.4: row must still exist after second call");
    assert.equal(afterSecond.endedAt, endedAtT1, "T-E.DB.4: endedAt must NOT be mutated by second call");
    assert.equal(afterSecond.status, "completed", "T-E.DB.4: status must NOT be mutated by second call");
  });
});
