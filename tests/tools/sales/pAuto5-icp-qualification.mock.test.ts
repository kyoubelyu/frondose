/**
 * P-AUTO-5 Step 3 scaffold → Step 5 assertions filled.
 *
 * T-A5.Mig.1, T-A5.Mig.2      — schema migration: icp_qualification column + v3
 * T-A5.Persist.1               — persistence: score row + getLatestScoreByCandidate
 * T-A5.Band.1..6               — band validation: QUALIFICATION_BAND keyed lookup
 * T-A5.Required.1              — required param: Zod rejects missing qualification
 *
 * Gates covered:
 *   G-A5.1  (Mig.1, Mig.2)  — migration adds icp_qualification column, version=3
 *   G-A5.2  (Persist.1)     — column persisted + retrieved correctly
 *   G-A5.3  (Band.1..6)     — QUALIFICATION_BAND enforced per qualification
 *   G-A5.4  (Required.1)    — qualification is a required Zod param
 *
 * Run (mock only):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/tools/sales/pAuto5-icp-qualification.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { getLatestScoreByCandidate } from "../../../src/persistence/sales/scores.js";
import { closeSalesDatabase, openSalesDatabase } from "../../../src/persistence/salesDb.js";
import { makeScoreLeadTool } from "../../../src/tools/sales/scoreLead.js";
import { seedFreshCandidate } from "../../sales/_fixtures/salesDb.js";

// biome-ignore lint/suspicious/noExplicitAny: test reads raw DB rows
type AnyDb = any;

function colNames(db: AnyDb, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}
function schemaVersionMax(db: AnyDb): number {
  return (db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number }).v;
}

// ─── T-A5.Mig.1 ──────────────────────────────────────────────────────────────

describe("T-A5.Mig — sales DB schema v3 migration (icp_qualification column)", () => {
  it("T-A5.Mig.1: when a FRESH sales DB is opened, lead_scores has icp_qualification column and schema_version MAX = 3", () => {
    // Given: a brand-new temp file path. When: openSalesDatabase runs v1→v2→v3.
    // Then: lead_scores has icp_qualification; schema_version MAX = 3.
    const path = join(tmpdir(), `a5-mig1-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(path) as AnyDb;
    try {
      assert.ok(colNames(db, "lead_scores").includes("icp_qualification"), "fresh DB lead_scores must have icp_qualification");
      assert.equal(schemaVersionMax(db), 3, "fresh DB schema_version MAX must be 3");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("T-A5.Mig.2: a v2 DB (no icp_qualification) re-opened → applyV3 adds the column; pre-v3 rows NULL; version=3; re-open is a no-op", () => {
    // Given: a DB hand-built at v2 (lead_scores WITHOUT icp_qualification; schema_version max=2; one row).
    // When: openSalesDatabase runs the migration runner (current=2 → applyV3 only).
    // Then: the column exists; the pre-v3 row's icp_qualification IS NULL; version=3; a second open does not throw.
    const path = join(tmpdir(), `a5-mig2-${randomUUID()}.sqlite`);
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE lead_scores (
        id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, total_score INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (1);
      INSERT INTO schema_version (version) VALUES (2);
      INSERT INTO lead_scores (id, candidate_id, total_score, created_at) VALUES ('old-row', 'cand-x', 50, 1000);
    `);
    raw.close();

    const db = openSalesDatabase(path) as AnyDb;
    try {
      assert.ok(colNames(db, "lead_scores").includes("icp_qualification"), "applyV3 must add icp_qualification to the v2 DB");
      assert.equal(schemaVersionMax(db), 3, "schema_version MAX must be 3 after applyV3");
      const oldRow = db.prepare("SELECT icp_qualification AS q FROM lead_scores WHERE id = 'old-row'").get() as { q: string | null };
      assert.equal(oldRow.q, null, "pre-v3 row must have icp_qualification = NULL (additive nullable column)");
      // Idempotency: close + re-open → runner sees current=3, applies nothing, no throw.
      closeSalesDatabase(path);
      const db2 = openSalesDatabase(path) as AnyDb;
      assert.equal(schemaVersionMax(db2), 3, "re-open is a no-op; version stays 3 (idempotent)");
    } finally {
      closeSalesDatabase(path);
    }
  });
});

// ─── T-A5.Persist.1 ──────────────────────────────────────────────────────────

describe("T-A5.Persist — icp_qualification persisted and retrieved on the score row", () => {
  it("T-A5.Persist.1: score_lead(qualification='qualified', totalScore=70) → row icp_qualification='qualified'; getLatestScoreByCandidate returns it", async () => {
    const path = join(tmpdir(), `a5-persist1-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      // P-AUTO-15b MR-2 (Step 3, 2026-06-15): add evidenceJson so QS-5 gate passes (totalScore=70>=40).
      const result = await makeScoreLeadTool(path).execute({ candidateId, qualification: "qualified", totalScore: 70, confidence: 0.7, evidenceJson: '{"source":"a5-persist1-fixture"}' });
      assert.equal(result.ok, true, `score_lead must succeed; got ${JSON.stringify(result)}`);
      const row = db.prepare("SELECT icp_qualification AS q FROM lead_scores WHERE candidate_id = ?").get(candidateId) as { q: string };
      assert.equal(row.q, "qualified", "lead_scores.icp_qualification must be 'qualified'");
      const latest = getLatestScoreByCandidate(db, candidateId);
      assert.equal(latest?.icpQualification, "qualified", "getLatestScoreByCandidate must return icpQualification:'qualified'");
    } finally {
      closeSalesDatabase(path);
    }
  });
});

// ─── Band helpers ────────────────────────────────────────────────────────────

function scoreCount(db: AnyDb, candidateId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM lead_scores WHERE candidate_id = ?").get(candidateId) as { n: number }).n;
}
function candidateStatus(db: AnyDb, candidateId: string): string {
  return (db.prepare("SELECT status FROM raw_candidates WHERE id = ?").get(candidateId) as { status: string }).status;
}

// ─── T-A5.Band.1..6 ──────────────────────────────────────────────────────────

describe("T-A5.Band — QUALIFICATION_BAND totalScore-consistency validation", () => {
  it("T-A5.Band.1: qualified + totalScore=15 → fail(invalid_input); no row; candidate status unchanged", async () => {
    const path = join(tmpdir(), `a5-band1-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      const result = await makeScoreLeadTool(path).execute({ candidateId, qualification: "qualified", totalScore: 15, confidence: 0.5 });
      assert.equal(result.ok, false, "qualified+15 must be rejected (band contradiction)");
      assert.equal(result.error?.kind, "invalid_input", "rejection kind must be invalid_input");
      assert.equal(scoreCount(db, candidateId), 0, "no lead_scores row on contradiction");
      assert.notEqual(candidateStatus(db, candidateId), "scored", "candidate must NOT be marked scored");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("T-A5.Band.2: disqualified + totalScore=80 → fail(invalid_input); no row", async () => {
    const path = join(tmpdir(), `a5-band2-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      const result = await makeScoreLeadTool(path).execute({ candidateId, qualification: "disqualified", totalScore: 80, confidence: 0.3 });
      assert.equal(result.ok, false, "disqualified+80 must be rejected");
      assert.equal(result.error?.kind, "invalid_input");
      assert.equal(scoreCount(db, candidateId), 0, "no lead_scores row on contradiction");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("T-A5.Band.3: qualified + totalScore=60 (floor, inclusive) → SUCCEEDS", async () => {
    const path = join(tmpdir(), `a5-band3-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      // P-AUTO-15b MR-2 (Step 3, 2026-06-15): add evidenceJson so QS-5 gate passes (totalScore=60>=40).
      const result = await makeScoreLeadTool(path).execute({ candidateId, qualification: "qualified", totalScore: 60, confidence: 0.65, evidenceJson: '{"source":"a5-band3-fixture"}' });
      assert.equal(result.ok, true, `qualified+60 (floor) must succeed; got ${JSON.stringify(result)}`);
      assert.equal(scoreCount(db, candidateId), 1, "a lead_scores row must be written");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("T-A5.Band.4: partial_match + totalScore=50 → SUCCEEDS", async () => {
    const path = join(tmpdir(), `a5-band4a-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      // P-AUTO-15b MR-2 (Step 3, 2026-06-15): add evidenceJson so QS-5 gate passes (totalScore=50>=40).
      const result = await makeScoreLeadTool(path).execute({ candidateId, qualification: "partial_match", totalScore: 50, confidence: 0.5, evidenceJson: '{"source":"a5-band4-fixture"}' });
      assert.equal(result.ok, true, `partial_match+50 must succeed; got ${JSON.stringify(result)}`);
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("T-A5.Band.4 edge: partial_match + totalScore=60 → REJECTS (above ceiling 59)", async () => {
    const path = join(tmpdir(), `a5-band4b-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      const result = await makeScoreLeadTool(path).execute({ candidateId, qualification: "partial_match", totalScore: 60, confidence: 0.5 });
      assert.equal(result.ok, false, "partial_match+60 must be rejected (above 59)");
      assert.equal(result.error?.kind, "invalid_input");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("T-A5.Band.5: tracked + totalScore=39 (ceiling, inclusive) → SUCCEEDS", async () => {
    const path = join(tmpdir(), `a5-band5a-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      const result = await makeScoreLeadTool(path).execute({ candidateId, qualification: "tracked", totalScore: 39, confidence: 0.4 });
      assert.equal(result.ok, true, `tracked+39 (ceiling) must succeed; got ${JSON.stringify(result)}`);
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("T-A5.Band.5 edge: tracked + totalScore=40 → REJECTS (above ceiling 39)", async () => {
    const path = join(tmpdir(), `a5-band5b-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      const result = await makeScoreLeadTool(path).execute({ candidateId, qualification: "tracked", totalScore: 40, confidence: 0.4 });
      assert.equal(result.ok, false, "tracked+40 must be rejected (above 39)");
      assert.equal(result.error?.kind, "invalid_input");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("T-A5.Band.6: unknown + totalScore=95 → SUCCEEDS (no band constraint)", async () => {
    const path = join(tmpdir(), `a5-band6-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      // P-AUTO-15b MR-2 (Step 3, 2026-06-15): add evidenceJson so QS-5 gate passes (totalScore=95>=40).
      const result = await makeScoreLeadTool(path).execute({ candidateId, qualification: "unknown", totalScore: 95, confidence: 0.2, evidenceJson: '{"source":"a5-band6-fixture"}' });
      assert.equal(result.ok, true, `unknown+95 must succeed (no constraint); got ${JSON.stringify(result)}`);
    } finally {
      closeSalesDatabase(path);
    }
  });
});

// ─── T-A5.Required.1 ─────────────────────────────────────────────────────────

describe("T-A5.Required — qualification is a required Zod param", () => {
  it("T-A5.Required.1: score_lead.parameters.safeParse WITHOUT qualification → {success:false}, issue at path 'qualification'", () => {
    const tool = makeScoreLeadTool("/tmp/a5-required-zod-only.sqlite");
    const parseResult = tool.parameters.safeParse({ candidateId: "c1", totalScore: 70, confidence: 0.6 });
    assert.equal(parseResult.success, false, "qualification must be a required param");
    if (!parseResult.success) {
      const issues = parseResult.error.issues as Array<{ path: Array<string | number> }>;
      assert.ok(issues.some((i) => i.path[0] === "qualification"), "a validation issue must be at path 'qualification'");
    }
  });
});
