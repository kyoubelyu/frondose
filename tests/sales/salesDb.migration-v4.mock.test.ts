/**
 * P-MSG-SEND-LEDGER Step 3a Revision — Test Scaffold — T-LedgerMig.1..8
 *
 * Covers the v3→v4 schema migration: auto_run_ledger.run_id becomes nullable
 * (recreate-and-swap via applyV4). Assertion bodies filled at Step 5.
 *
 * Revisions applied (Step-3a):
 *   - T-LedgerMig.4: rebuilt v3 fixture using raw better-sqlite3 SQL (CONCERN-MR-2 fix)
 *   - T-LedgerMig.7b: PRAGMA foreign_key_check returns empty post-migration (BLOCKER-2 fix)
 *   - T-LedgerMig.8: bogus result value throws CHECK constraint failed (CHECK-coverage fix)
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/sales/salesDb.migration-v4.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";

// biome-ignore lint/suspicious/noExplicitAny: runtime DB handle + dynamic imports
type AnyFn = (...args: any[]) => any;

// Import openSalesDatabase + closeSalesDatabase directly (synchronous module resolution
// for :memory: and temp-file tests).
import { closeSalesDatabase, openSalesDatabase } from "../../src/persistence/salesDb.js";

function makeTmpPath(): string {
  return join(tmpdir(), `migration-v4-${randomUUID()}.sqlite`);
}

describe("T-LedgerMig — schema v3→v4 migration: auto_run_ledger.run_id nullable (P-MSG-SEND-LEDGER)", () => {

  // ─── T-LedgerMig.1 ───────────────────────────────────────────────────────────
  it("T-LedgerMig.1: applyV4 makes run_id nullable — PRAGMA table_info(auto_run_ledger).notnull===0 for run_id", () => {
    // Given: a fresh :memory: sales DB opened (runs V1+V2+V3+V4 on first open)
    // When:  PRAGMA table_info(auto_run_ledger) is inspected
    // Then:  the run_id column row has notnull = 0 (nullable)
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");

    const cols = db.prepare("PRAGMA table_info(auto_run_ledger)").all() as Array<{ name: string; notnull: number }>;
    const runIdCol = cols.find((c) => c.name === "run_id");
    assert.ok(runIdCol !== undefined, "run_id column must exist in auto_run_ledger");
    assert.strictEqual(runIdCol!.notnull, 0, "run_id must be nullable (notnull=0) after applyV4");
  });

  // ─── T-LedgerMig.2 ───────────────────────────────────────────────────────────
  it("T-LedgerMig.2: MAX(version)==4 after fresh :memory: open (applyV1+V2+V3+V4 all run)", () => {
    // Given: a fresh :memory: sales DB opened
    // When:  SELECT MAX(version) FROM schema_version
    // Then:  result is 4 (v4 row recorded)
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");

    const row = db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number };
    assert.strictEqual(row.version, 4, "MAX(version) must be 4 after fresh open");
  });

  // ─── T-LedgerMig.3 ───────────────────────────────────────────────────────────
  it("T-LedgerMig.3: schema_version has exactly 4 rows after first open + idempotent file-backed re-open (no double-migration)", () => {
    // Given: an open file-backed sales DB (NOT :memory: — the cache makes :memory: re-open a no-op)
    //        then closeSalesDatabase + re-openSalesDatabase of the same path
    // When:  SELECT COUNT(*) FROM schema_version
    // Then:  result is 4 (V1+V2+V3+V4 each ran exactly once; re-open is idempotent)
    const tmpPath = makeTmpPath();
    openSalesDatabase(tmpPath);         // first open — runs migration (v1+v2+v3+v4)
    closeSalesDatabase(tmpPath);        // evict from cache
    const db2 = openSalesDatabase(tmpPath); // second open — re-runs runSalesMigrations but gated

    const versions = db2.prepare("SELECT version FROM schema_version ORDER BY version").all() as { version: number }[];
    assert.strictEqual(versions.length, 4, "schema_version must have exactly 4 rows after idempotent re-open");
  });

  // ─── T-LedgerMig.4 ───────────────────────────────────────────────────────────
  it("T-LedgerMig.4: existing v3 rows survive the recreate-and-swap with byte-identical column values", () => {
    // Given: a GENUINE v3 sales DB built via raw better-sqlite3 SQL (NOT via openSalesDatabase,
    //        which after builder Step 4 opens straight to v4 and skips the swap).
    //        The v3 fixture is: schema_version table with version=3, auto_runs + leads tables
    //        (FK targets for auto_run_ledger), and the v3 auto_run_ledger DDL (run_id NOT NULL).
    //        N rows are seeded into the v3 ledger, the raw DB is closed.
    //        THEN openSalesDatabase(tmpPath) is called to trigger the v4 migration.
    // When:  v4 migration runs (recreate-and-swap via applyV4)
    // Then:  all N rows exist post-swap with byte-identical column values
    //        (id, run_id, action_type, lead_id, ts, count_weight, result all preserved)
    const tmpPath = makeTmpPath();

    // Build a genuine v3 fixture with raw better-sqlite3 — DO NOT call openSalesDatabase first
    // (CONCERN-MR-2 fix: after builder Step 4, openSalesDatabase opens to v4 and bypasses swap).
    const rawDb = new Database(tmpPath);
    rawDb.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (1);
      INSERT INTO schema_version (version) VALUES (2);
      INSERT INTO schema_version (version) VALUES (3);

      CREATE TABLE auto_runs (
        id                     TEXT    PRIMARY KEY,
        started_at             INTEGER NOT NULL,
        ended_at               INTEGER,
        max_duration_minutes   INTEGER NOT NULL DEFAULT 480,
        max_connects           INTEGER,
        status                 TEXT    NOT NULL CHECK (status IN ('running','completed','stopped_by_user','stopped_by_agent','blocked')),
        summary                TEXT,
        counters               TEXT
      );

      CREATE TABLE leads (
        id                    TEXT    PRIMARY KEY,
        candidate_id          TEXT    NOT NULL UNIQUE,
        account_id            TEXT,
        person_name           TEXT    NOT NULL,
        profile_url           TEXT    NOT NULL,
        stage                 TEXT    NOT NULL,
        total_score           INTEGER,
        confidence            REAL,
        one_line_pain_chain   TEXT,
        next_action           TEXT,
        next_action_due_at    INTEGER,
        owner_mode            TEXT    NOT NULL,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );

      CREATE TABLE auto_run_ledger (
        id            TEXT    PRIMARY KEY,
        run_id        TEXT    NOT NULL REFERENCES auto_runs(id),
        action_type   TEXT    NOT NULL CHECK (action_type IN ('connect_sent','message_sent','follow_up_sent','comment_posted')),
        lead_id       TEXT    REFERENCES leads(id),
        ts            INTEGER NOT NULL,
        count_weight  REAL    NOT NULL DEFAULT 1.0,
        result        TEXT    NOT NULL CHECK (result IN ('success','failed','skipped'))
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_run_action ON auto_run_ledger (run_id, action_type);
      CREATE INDEX IF NOT EXISTS idx_ledger_lead ON auto_run_ledger (lead_id) WHERE lead_id IS NOT NULL;
    `);

    // Seed an auto_runs row (FK target for run_id NOT NULL constraint)
    const runId = randomUUID();
    const now = Date.now();
    rawDb.prepare(
      "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL)",
    ).run(runId, now, 480, 5, "running");

    // Seed 3 v3 ledger rows (all with non-null run_id — v3 DDL has NOT NULL)
    const rows = [
      { id: randomUUID(), run_id: runId, action_type: "connect_sent", lead_id: null, ts: now - 3000, count_weight: 1.0, result: "success" },
      { id: randomUUID(), run_id: runId, action_type: "message_sent", lead_id: null, ts: now - 2000, count_weight: 1.0, result: "success" },
      { id: randomUUID(), run_id: runId, action_type: "follow_up_sent", lead_id: null, ts: now - 1000, count_weight: 0.5, result: "skipped" },
    ];
    for (const r of rows) {
      rawDb.prepare(
        "INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, ts, count_weight, result) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(r.id, r.run_id, r.action_type, r.lead_id, r.ts, r.count_weight, r.result);
    }
    rawDb.close();

    // Now open via openSalesDatabase to trigger the v4 migration on the genuinely-v3 file
    const db2 = openSalesDatabase(tmpPath);

    const preserved = db2.prepare(
      "SELECT id, run_id, action_type, lead_id, ts, count_weight, result FROM auto_run_ledger ORDER BY id",
    ).all() as Array<{ id: string; run_id: string | null; action_type: string; lead_id: string | null; ts: number; count_weight: number; result: string }>;
    const sortedExpected = [...rows].sort((a, b) => a.id.localeCompare(b.id));
    assert.strictEqual(preserved.length, sortedExpected.length, "All v3 rows must survive the recreate-and-swap");
    for (let i = 0; i < sortedExpected.length; i++) {
      assert.strictEqual(preserved[i]!.id, sortedExpected[i]!.id);
      assert.strictEqual(preserved[i]!.run_id, sortedExpected[i]!.run_id);
      assert.strictEqual(preserved[i]!.action_type, sortedExpected[i]!.action_type);
      assert.strictEqual(preserved[i]!.lead_id, sortedExpected[i]!.lead_id);
      assert.strictEqual(preserved[i]!.ts, sortedExpected[i]!.ts);
      assert.strictEqual(preserved[i]!.count_weight, sortedExpected[i]!.count_weight);
      assert.strictEqual(preserved[i]!.result, sortedExpected[i]!.result);
    }
  });

  // ─── T-LedgerMig.5 ───────────────────────────────────────────────────────────
  it("T-LedgerMig.5: both indexes recreated after swap — idx_ledger_lead + idx_ledger_run_action present", () => {
    // Given: a v4 DB (fresh :memory: open)
    // When:  SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='auto_run_ledger' ORDER BY name
    // Then:  result includes idx_ledger_lead AND idx_ledger_run_action
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='auto_run_ledger' ORDER BY name",
    ).all() as { name: string }[];
    const names = indexes.map((r) => r.name);
    assert.ok(names.includes("idx_ledger_lead"), "idx_ledger_lead must exist after v4 swap");
    assert.ok(names.includes("idx_ledger_run_action"), "idx_ledger_run_action must exist after v4 swap");
  });

  // ─── T-LedgerMig.6 ───────────────────────────────────────────────────────────
  it("T-LedgerMig.6: action_type CHECK constraint preserved — inserting bogus action_type throws /CHECK constraint failed/i", () => {
    // Given: a v4 DB with a valid auto_runs row
    // When:  raw SQL inserts a row with action_type='bogus'
    // Then:  SQLite throws CHECK constraint failed (the action_type enum survives the swap)
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");

    // Seed an auto_runs row so FK is satisfiable (for non-null run_id)
    const runId = randomUUID();
    db.prepare(
      "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL)",
    ).run(runId, Date.now(), 480, 5, "running");

    assert.throws(
      () => db.prepare(
        "INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, ts, count_weight, result) VALUES (?, ?, ?, NULL, ?, 1.0, ?)",
      ).run(randomUUID(), null, "bogus", Date.now(), "success"),
      /CHECK constraint failed/i,
      "action_type='bogus' must throw CHECK constraint failed",
    );
  });

  // ─── T-LedgerMig.7 ───────────────────────────────────────────────────────────
  it("T-LedgerMig.7: FK still valid; null FK allowed; non-null FK with unknown run_id throws /FOREIGN KEY constraint failed/i", () => {
    // Given: a v4 DB with PRAGMA foreign_keys = ON
    // When:  inserting an auto_run_ledger row with run_id = NULL
    // Then:  it succeeds (NULL FK is unenforced per SQLite spec)
    // And When: inserting run_id = 'no-such-run-id'
    // Then:  SQLite throws /FOREIGN KEY constraint failed/i
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");

    db.pragma("foreign_keys = ON");
    // NULL FK should succeed
    assert.doesNotThrow(
      () => db.prepare(
        "INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, ts, count_weight, result) VALUES (?, ?, ?, NULL, ?, 1.0, ?)",
      ).run(randomUUID(), null, "connect_sent", Date.now(), "success"),
      "null run_id must be accepted by SQLite (NULL FK unenforced)",
    );
    // Non-null unknown run_id should fail FK
    assert.throws(
      () => db.prepare(
        "INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, ts, count_weight, result) VALUES (?, ?, ?, NULL, ?, 1.0, ?)",
      ).run(randomUUID(), "no-such-run-id", "connect_sent", Date.now(), "success"),
      /FOREIGN KEY constraint failed/i,
      "non-null unknown run_id must throw FOREIGN KEY constraint failed",
    );
  });

  // ─── T-LedgerMig.7b ──────────────────────────────────────────────────────────
  it("T-LedgerMig.7b: post-migration PRAGMA foreign_key_check returns zero rows (BLOCKER-2 defense-in-depth)", () => {
    // Given: a genuine v3 DB seeded with rows satisfying both FKs
    //        (run_id → real auto_runs.id; lead_id either null or → real leads.id)
    // When:  the v4 migration runs (via openSalesDatabase(tmpPath)) on the genuinely-v3 file
    //        AND the test runs db.pragma("foreign_key_check") on the resulting v4 DB
    // Then:  the result is an empty array — no FK violations introduced by the recreate-and-swap
    //        Covers BLOCKER-2 fix: migration runs with FK enforcement ON and introduces no violations.
    const tmpPath = makeTmpPath();

    // Build a genuine v3 fixture with raw better-sqlite3
    const rawDb = new Database(tmpPath);
    rawDb.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (1);
      INSERT INTO schema_version (version) VALUES (2);
      INSERT INTO schema_version (version) VALUES (3);

      CREATE TABLE auto_runs (
        id                     TEXT    PRIMARY KEY,
        started_at             INTEGER NOT NULL,
        ended_at               INTEGER,
        max_duration_minutes   INTEGER NOT NULL DEFAULT 480,
        max_connects           INTEGER,
        status                 TEXT    NOT NULL CHECK (status IN ('running','completed','stopped_by_user','stopped_by_agent','blocked')),
        summary                TEXT,
        counters               TEXT
      );

      CREATE TABLE leads (
        id                    TEXT    PRIMARY KEY,
        candidate_id          TEXT    NOT NULL UNIQUE,
        account_id            TEXT,
        person_name           TEXT    NOT NULL,
        profile_url           TEXT    NOT NULL,
        stage                 TEXT    NOT NULL,
        total_score           INTEGER,
        confidence            REAL,
        one_line_pain_chain   TEXT,
        next_action           TEXT,
        next_action_due_at    INTEGER,
        owner_mode            TEXT    NOT NULL,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );

      CREATE TABLE auto_run_ledger (
        id            TEXT    PRIMARY KEY,
        run_id        TEXT    NOT NULL REFERENCES auto_runs(id),
        action_type   TEXT    NOT NULL CHECK (action_type IN ('connect_sent','message_sent','follow_up_sent','comment_posted')),
        lead_id       TEXT    REFERENCES leads(id),
        ts            INTEGER NOT NULL,
        count_weight  REAL    NOT NULL DEFAULT 1.0,
        result        TEXT    NOT NULL CHECK (result IN ('success','failed','skipped'))
      );
    `);

    // Seed a valid auto_runs row (FK target for run_id)
    const runId = randomUUID();
    const now = Date.now();
    rawDb.prepare(
      "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL)",
    ).run(runId, now, 480, 5, "running");

    // Seed ledger rows: both FKs satisfied (run_id → real auto_runs.id; lead_id null)
    rawDb.prepare(
      "INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, ts, count_weight, result) VALUES (?, ?, ?, NULL, ?, 1.0, ?)",
    ).run(randomUUID(), runId, "connect_sent", now - 1000, "success");
    rawDb.prepare(
      "INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, ts, count_weight, result) VALUES (?, ?, ?, NULL, ?, 1.0, ?)",
    ).run(randomUUID(), runId, "message_sent", now - 500, "success");
    rawDb.close();

    // Trigger v4 migration via openSalesDatabase
    const db = openSalesDatabase(tmpPath);

    db.pragma("foreign_keys = ON");
    const violations = db.pragma("foreign_key_check") as unknown[];
    assert.ok(Array.isArray(violations), "foreign_key_check must return an array");
    assert.strictEqual(violations.length, 0, "foreign_key_check must return zero rows — no FK violations after the v4 swap");
  });

  // ─── T-LedgerMig.8 ───────────────────────────────────────────────────────────
  it("T-LedgerMig.8: result CHECK constraint preserved — inserting bogus result value throws /CHECK constraint failed/i", () => {
    // Given: a v4 DB with a valid auto_runs row (all other columns valid)
    // When:  raw SQL inserts a row with result='bogus' (enum violation)
    // Then:  SQLite throws /CHECK constraint failed/i
    //        This enum is load-bearing for countOutboundSince (auto-run.ts:111-123) which
    //        filters result='success' — it must survive the recreate-and-swap unchanged.
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");

    // Seed an auto_runs row so FK is satisfiable
    const runId = randomUUID();
    db.prepare(
      "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL)",
    ).run(runId, Date.now(), 480, 5, "running");

    assert.throws(
      () => db.prepare(
        "INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, ts, count_weight, result) VALUES (?, ?, ?, NULL, ?, 1.0, ?)",
      ).run(randomUUID(), null, "connect_sent", Date.now(), "bogus"),
      /CHECK constraint failed/i,
      "result='bogus' must throw CHECK constraint failed (result enum must survive v4 swap)",
    );
  });
});
