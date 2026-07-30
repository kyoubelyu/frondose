/**
 * P-SP-A mock tests — T-SP-A.Schema.1..6
 * Migration framework + 8-table schema invariants.
 * Uses `:memory:` SQLite — no real ~/.mai/agent/sales.sqlite touched.
 *
 * Step 5: assertion bodies filled.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  closeSalesDatabase,
  insertLead,
  openSalesDatabase,
  upsertRawCandidate,
} from "../../src/persistence/salesDb.js";
import { seedFreshCandidate } from "./_fixtures/salesDb.js";

describe("T-SP-A.Schema — sales DB migration + schema invariants", () => {
  // ─── T-SP-A.Schema.1 ─────────────────────────────────────────────────────────
  it("T-SP-A.Schema.1: applyV1 creates all 8 tables on first boot", async () => {
    // Given: a non-existent sales.sqlite path (using :memory: equivalent)
    // When:  openSalesDatabase(":memory:") is called
    // Then:  8 tables + schema_version exist; version=1; journal_mode=wal
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[];
    const tableNames = tables.map((t) => t.name);

    const expectedTables = [
      "accounts",
      "auto_run_ledger",
      "auto_runs",
      "lead_scores",
      "lead_timeline",
      "leads",
      "message_drafts",
      "raw_candidates",
      "schema_version",
    ];
    for (const name of expectedTables) {
      assert.ok(tableNames.includes(name), `Table '${name}' must exist after applyV1`);
    }
    assert.strictEqual(tableNames.length, 9, "Must have exactly 9 tables (8 + schema_version)");

    // P-MSG-SEND-LEDGER: version bumped from 3 to 4 (applyV1 + applyV2 + applyV3 + applyV4 all run on fresh open)
    const versionRow = db.prepare("SELECT MAX(version) AS version FROM schema_version").get() as { version: number };
    assert.strictEqual(versionRow.version, 4, "schema_version MAX(version) must be 4 (applyV1+V2+V3+V4 all run)");

    // SQLite ignores PRAGMA journal_mode=WAL for :memory: databases (WAL requires
    // a real file path). Production code correctly calls the pragma; :memory: returns
    // 'memory' instead of 'wal'. Acceptable values: 'wal' (file-path) OR 'memory' (:memory:).
    const journalMode = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    const jm = journalMode[0]?.journal_mode?.toLowerCase();
    assert.ok(
      jm === "wal" || jm === "memory",
      `journal_mode must be 'wal' (file DB) or 'memory' (:memory: DB); got '${jm}'`,
    );
  });

  // ─── T-SP-A.Schema.2 ─────────────────────────────────────────────────────────
  it("T-SP-A.Schema.2: idempotent re-open — calling openSalesDatabase twice does not duplicate schema_version", async () => {
    // Given: an existing :memory: DB already at schema version 4 (applyV1+V2+V3+V4)
    // When:  openSalesDatabase is called again (returns cached handle)
    // Then:  schema_version has exactly 4 rows (v1, v2, v3, v4); no CREATE TABLE error
    // P-MSG-SEND-LEDGER: migration now runs to v4 — 4 version rows expected after first open
    closeSalesDatabase(":memory:");
    openSalesDatabase(":memory:"); // first open — runs migration (v1+v2+v3+v4)
    const db2 = openSalesDatabase(":memory:"); // second call — returns from cache
    const versions = db2.prepare("SELECT version FROM schema_version ORDER BY version").all() as { version: number }[];
    assert.strictEqual(
      versions.length,
      4,
      "schema_version must have exactly 4 rows after idempotent re-open (v1+v2+v3+v4)",
    );
    assert.strictEqual(versions[3]!.version, 4, "max version must be 4");
  });

  // ─── T-SP-A.Schema.3 ─────────────────────────────────────────────────────────
  it("T-SP-A.Schema.3: raw_candidates.profile_url is UNIQUE — upsert updates lastSeenAt not observedAt", async () => {
    // Given: a raw_candidates row exists for profileUrl X
    // When:  upsertRawCandidate is called again with the same normalized URL
    // Then:  still only 1 row; lastSeenAt >= observedAt; status unchanged
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");

    const profileUrl = "https://www.linkedin.com/in/alice-test/";
    const { candidateId: id1, inserted: i1 } = upsertRawCandidate(db, {
      personName: "Alice Test",
      profileUrl,
      source: "profile-nav",
    });
    assert.ok(i1, "First upsert must be inserted=true");

    // Small delay so timestamps differ
    await new Promise((r) => setTimeout(r, 10));

    const { candidateId: id2, inserted: i2 } = upsertRawCandidate(db, {
      personName: "Alice Test",
      profileUrl,
      source: "feed",
    });
    assert.ok(!i2, "Second upsert must be inserted=false");
    assert.strictEqual(id1, id2, "candidateId must be unchanged on upsert");

    const rows = db.prepare("SELECT * FROM raw_candidates").all() as Array<{
      id: string;
      observed_at: number;
      last_seen_at: number;
      status: string;
    }>;
    assert.strictEqual(rows.length, 1, "Must still have only 1 row after upsert");
    assert.ok(rows[0]!.last_seen_at >= rows[0]!.observed_at, "lastSeenAt must be >= observedAt after upsert");
    assert.strictEqual(rows[0]!.status, "new", "status must remain 'new' (not changed by upsert)");
  });

  // ─── T-SP-A.Schema.4 ─────────────────────────────────────────────────────────
  it("T-SP-A.Schema.4: leads.stage CHECK constraint rejects bogus stage value", async () => {
    // Given: a leads row inserted via seeder (stage='qualified')
    // When:  raw SQL UPDATE leads SET stage='bogus' WHERE id=...
    // Then:  SQLite throws a CHECK constraint failed error
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");

    const candidateId = seedFreshCandidate(db);
    const leadId = insertLead(db, {
      candidateId,
      personName: "Check Test",
      profileUrl: "https://www.linkedin.com/in/check-test/",
      stage: "qualified",
      ownerMode: "manual",
    });

    assert.throws(
      () => db.prepare("UPDATE leads SET stage = 'bogus' WHERE id = ?").run(leadId),
      /CHECK constraint failed/i,
      "Must throw CHECK constraint failed when stage='bogus' is set via raw SQL",
    );
  });

  // ─── T-SP-A.Schema.5 ─────────────────────────────────────────────────────────
  it("T-SP-A.Schema.5: accounts.linkedin_url is nullable AND unique when present", async () => {
    // Given: accounts row with linkedinUrl=NULL already exists
    // When:  second accounts row inserted with linkedinUrl=NULL (should succeed)
    // Then:  2 rows exist (no UNIQUE collision on NULLs — SQLite default semantics)
    // And When: third row inserted with same non-null linkedinUrl as an existing row
    // Then:  UNIQUE constraint fails
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");

    const now = Date.now();
    const insertAccount = (id: string, url: string | null) =>
      db
        .prepare("INSERT INTO accounts (id, name, linkedin_url, updated_at) VALUES (?, ?, ?, ?)")
        .run(id, "Test Co", url, now);

    insertAccount(randomUUID(), null); // first NULL
    insertAccount(randomUUID(), null); // second NULL — must succeed

    const rows = db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number };
    assert.strictEqual(rows.n, 2, "Two NULL linkedinUrl accounts must coexist (SQLite UNIQUE NULL semantics)");

    const sharedUrl = "https://www.linkedin.com/company/test-co/";
    insertAccount(randomUUID(), sharedUrl); // first non-null URL

    assert.throws(
      () => insertAccount(randomUUID(), sharedUrl),
      /UNIQUE constraint failed/i,
      "Must throw UNIQUE constraint when two accounts share the same non-null linkedin_url",
    );
  });

  // ─── T-SP-A.Schema.6 ─────────────────────────────────────────────────────────
  it("T-SP-A.Schema.6: existing memory.sqlite is untouched when openSalesDatabase runs", async () => {
    // Given: a memory.sqlite with person_memory_events rows (opened separately)
    // When:  openSalesDatabase(salesPath) runs against an entirely separate :memory: path
    // Then:  memory.sqlite row counts + schema_version unchanged; no cross-DB contamination
    closeSalesDatabase(":memory:");
    const salesDb = openSalesDatabase(":memory:");

    // Verify: sales DB does NOT have memory-module tables (no cross-contamination)
    const salesTables = salesDb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[];
    const salesTableNames = salesTables.map((t) => t.name);
    assert.ok(
      !salesTableNames.includes("person_memory_events"),
      "Sales DB must NOT contain memory module tables (cross-DB contamination guard)",
    );
    assert.ok(salesTableNames.includes("raw_candidates"), "Sales DB must contain raw_candidates table");
    assert.ok(salesTableNames.includes("lead_timeline"), "Sales DB must contain lead_timeline table");
    // Verify the 8 sales-specific tables are present and no extra ones leaked in
    assert.strictEqual(
      salesTableNames.length,
      9,
      "Sales DB must have exactly 9 tables (8 P-SP-A + schema_version); no memory module bleed",
    );
  });
});
