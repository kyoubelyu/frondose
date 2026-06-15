/**
 * P-AUTO-15b Step 3 — Test Scaffold — G-A15b.7..7e (QS-7.c COALESCE upsert)
 *
 * Covers:
 *   G-A15b.7   — a 2nd upsert with new non-null evidence_summary UPDATES the existing row
 *   G-A15b.7a  — a 2nd upsert with NULL evidence_summary does NOT clobber existing (COALESCE preserves)
 *   G-A15b.7b  — first INSERT with supplied evidence stores that value
 *   G-A15b.7c  — first INSERT with undefined evidence stores NULL
 *   G-A15b.7d  — a 2nd upsert with EMPTY or WHITESPACE-ONLY evidence does NOT clobber existing
 *                (the MR-1 residual: EXISTING DB value SURVIVES blank re-record)
 *   G-A15b.7e  — first INSERT with EMPTY-string evidence stores NULL (blank-normalization on insert)
 *
 * Step-3 RED state (BEFORE builder Step 4):
 *   All assertions for COALESCE behavior FAIL because:
 *   (a) the SQL still only does `DO UPDATE SET last_seen_at = excluded.last_seen_at`
 *   (b) the TypeScript normalization (`trimmedEvidence?.trim()`) doesn't exist yet
 *   Scaffolds compile; runtime fails at the COALESCE assertion bodies.
 *
 * Design: calls upsertRawCandidate (src/persistence/sales/raw-candidates.ts) directly
 * against a temp-file sales DB. Queries the DB row to assert evidence_summary and last_seen_at.
 *
 * Run (mock only):
 *   node --import tsx --test --test-force-exit \
 *     tests/persistence/sales/raw-candidates-coalesce.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { closeSalesDatabase, openSalesDatabase } from "../../../src/persistence/salesDb.js";
import { upsertRawCandidate } from "../../../src/persistence/sales/raw-candidates.js";

// biome-ignore lint/suspicious/noExplicitAny: test DB rows
type AnyDb = any;

function tmpPath(label: string): string {
  return join(tmpdir(), `a15b-coalesce-${label}-${randomUUID()}.sqlite`);
}

/** Seed a raw_candidates row with the given evidence_summary, return candidateId. */
function seedCandidate(db: AnyDb, profileUrl: string, evidenceSummary: string | undefined): string {
  const result = upsertRawCandidate(db, {
    personName: "Test Person",
    profileUrl,
    source: "profile-nav",
    evidenceSummary,
  });
  return result.candidateId;
}

describe("G-A15b — QS-7.c: COALESCE upsert in raw_candidates (P-AUTO-15b MR-1)", () => {
  it("G-A15b.7: a 2nd upsert with new non-null evidence_summary UPDATES the existing DB value", async () => {
    // Given: a raw_candidates row with evidence_summary='headline-v1' already in DB
    // When:  upsertRawCandidate({profileUrl, evidenceSummary:'headline-v2'})
    // Then:  SELECT evidence_summary returns 'headline-v2' (COALESCE chose the non-null new value)
    const path = tmpPath("update");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const profileUrl = `https://www.linkedin.com/in/test-a15b-${randomUUID()}/`;
      seedCandidate(db, profileUrl, "headline-v1");

      // Wait 2ms so last_seen_at timestamp increments detectably
      await new Promise((r) => setTimeout(r, 2));
      const beforeTs = (
        db.prepare("SELECT last_seen_at FROM raw_candidates WHERE profile_url = ?").get(profileUrl) as {
          last_seen_at: number;
        }
      ).last_seen_at;

      upsertRawCandidate(db, { personName: "Test Person", profileUrl, source: "profile-nav", evidenceSummary: "headline-v2" });

      // TODO: Step-5 assertion fill — currently the SQL doesn't update evidence_summary
      const row = db.prepare("SELECT evidence_summary, last_seen_at FROM raw_candidates WHERE profile_url = ?").get(
        profileUrl,
      ) as { evidence_summary: string | null; last_seen_at: number };
      assert.equal(row.evidence_summary, "headline-v2", "G-A15b.7: 2nd upsert with new evidence must update evidence_summary");
      assert.ok(row.last_seen_at >= beforeTs, "G-A15b.7: last_seen_at must be refreshed on 2nd upsert");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("G-A15b.7a: a 2nd upsert with NULL evidence does NOT clobber the existing non-empty evidence_summary (COALESCE preserves existing)", async () => {
    // Given: a row with evidence_summary='headline-v1' in DB
    // When:  upsertRawCandidate({profileUrl, evidenceSummary: undefined}) — writes NULL after normalization
    // Then:  evidence_summary === 'headline-v1' (COALESCE chose existing over NULL);
    //        last_seen_at IS refreshed (that update still fires)
    const path = tmpPath("null-preserve");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const profileUrl = `https://www.linkedin.com/in/test-a15b-null-${randomUUID()}/`;
      seedCandidate(db, profileUrl, "headline-v1");

      await new Promise((r) => setTimeout(r, 2));
      const beforeTs = (
        db.prepare("SELECT last_seen_at FROM raw_candidates WHERE profile_url = ?").get(profileUrl) as {
          last_seen_at: number;
        }
      ).last_seen_at;

      upsertRawCandidate(db, { personName: "Test Person", profileUrl, source: "profile-nav", evidenceSummary: undefined });

      // TODO: Step-5 assertion fill — currently the SQL clobbers with NULL (no COALESCE)
      const row = db.prepare("SELECT evidence_summary, last_seen_at FROM raw_candidates WHERE profile_url = ?").get(
        profileUrl,
      ) as { evidence_summary: string | null; last_seen_at: number };
      assert.equal(
        row.evidence_summary,
        "headline-v1",
        "G-A15b.7a: NULL 2nd upsert must NOT clobber existing non-empty evidence_summary",
      );
      assert.ok(row.last_seen_at >= beforeTs, "G-A15b.7a: last_seen_at must be refreshed even when evidence not updated");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("G-A15b.7b: first INSERT with supplied evidence stores that value", async () => {
    // Given: empty raw_candidates table
    // When:  upsertRawCandidate({profileUrl, evidenceSummary:'v1'})
    // Then:  raw_candidates has 1 row with evidence_summary='v1'; inserted===true
    const path = tmpPath("first-insert");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const profileUrl = `https://www.linkedin.com/in/test-a15b-insert-${randomUUID()}/`;
      const { candidateId, inserted } = upsertRawCandidate(db, {
        personName: "Test Person",
        profileUrl,
        source: "profile-nav",
        evidenceSummary: "v1",
      });
      // TODO: Step-5 assertion fill
      assert.ok(candidateId, "G-A15b.7b: candidateId must be returned");
      assert.equal(inserted, true, "G-A15b.7b: inserted must be true on first INSERT");
      const row = db.prepare("SELECT evidence_summary FROM raw_candidates WHERE id = ?").get(candidateId) as
        | { evidence_summary: string | null }
        | undefined;
      assert.ok(row, "G-A15b.7b: raw_candidates row must exist");
      assert.equal(row?.evidence_summary, "v1", "G-A15b.7b: first INSERT must persist the supplied evidenceSummary");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("G-A15b.7c: first INSERT with undefined evidence stores NULL", async () => {
    // Given: empty raw_candidates table
    // When:  upsertRawCandidate({profileUrl, evidenceSummary:undefined})
    // Then:  evidence_summary IS NULL; inserted===true
    const path = tmpPath("first-insert-null");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const profileUrl = `https://www.linkedin.com/in/test-a15b-null-insert-${randomUUID()}/`;
      const { candidateId, inserted } = upsertRawCandidate(db, {
        personName: "Test Person",
        profileUrl,
        source: "profile-nav",
        evidenceSummary: undefined,
      });
      // TODO: Step-5 assertion fill
      assert.ok(candidateId, "G-A15b.7c: candidateId must be returned");
      assert.equal(inserted, true, "G-A15b.7c: inserted must be true on first INSERT");
      const row = db.prepare("SELECT evidence_summary FROM raw_candidates WHERE id = ?").get(candidateId) as
        | { evidence_summary: string | null }
        | undefined;
      assert.ok(row, "G-A15b.7c: raw_candidates row must exist");
      assert.equal(row?.evidence_summary, null, "G-A15b.7c: first INSERT with undefined evidence must store NULL");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("G-A15b.7d: BLANK or WHITESPACE-ONLY 2nd upsert does NOT clobber existing non-empty evidence_summary (MR-1 DB-survival assertion)", async () => {
    // Given: a row with evidence_summary='headline-v1' in DB
    // When:  (sub-case A) upsertRawCandidate({profileUrl, evidenceSummary:''})
    //        (sub-case B) upsertRawCandidate({profileUrl, evidenceSummary:'   '})
    // Then:  in BOTH sub-cases, evidence_summary === 'headline-v1' (COALESCE preserves existing);
    //        last_seen_at IS refreshed;
    //        the TypeScript normalize turns ''/'   ' → null → NULLIF('','')=NULL → COALESCE keeps existing.
    // This is the ORCHESTRATOR-THREADED MR-1 RESIDUAL behavior pin.
    const path = tmpPath("blank-preserve");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const profileUrlA = `https://www.linkedin.com/in/test-a15b-blank-a-${randomUUID()}/`;
      const profileUrlB = `https://www.linkedin.com/in/test-a15b-blank-b-${randomUUID()}/`;

      // Seed both rows with non-empty evidence
      seedCandidate(db, profileUrlA, "headline-v1");
      seedCandidate(db, profileUrlB, "headline-v1");

      await new Promise((r) => setTimeout(r, 2));

      // Sub-case A: empty string ''
      upsertRawCandidate(db, { personName: "Test Person", profileUrl: profileUrlA, source: "profile-nav", evidenceSummary: "" });

      // Sub-case B: whitespace-only '   '
      upsertRawCandidate(db, {
        personName: "Test Person",
        profileUrl: profileUrlB,
        source: "profile-nav",
        evidenceSummary: "   ",
      });

      // TODO: Step-5 assertion fill — currently '' would clobber (no normalization yet)
      const rowA = db.prepare("SELECT evidence_summary FROM raw_candidates WHERE profile_url = ?").get(profileUrlA) as {
        evidence_summary: string | null;
      };
      const rowB = db.prepare("SELECT evidence_summary FROM raw_candidates WHERE profile_url = ?").get(profileUrlB) as {
        evidence_summary: string | null;
      };

      assert.equal(
        rowA.evidence_summary,
        "headline-v1",
        "G-A15b.7d (sub-case A): empty-string 2nd upsert must NOT clobber existing evidence_summary",
      );
      assert.equal(
        rowB.evidence_summary,
        "headline-v1",
        "G-A15b.7d (sub-case B): whitespace-only 2nd upsert must NOT clobber existing evidence_summary",
      );
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("G-A15b.7e: first INSERT with EMPTY-string evidence stores NULL (blank-normalization on INSERT branch)", async () => {
    // Given: empty raw_candidates table
    // When:  upsertRawCandidate({profileUrl, evidenceSummary:''})
    // Then:  evidence_summary IS NULL (TypeScript normalize turns '' → null before SQL bind)
    //        This is the defense-in-depth check for the INSERT branch.
    const path = tmpPath("blank-insert");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const profileUrl = `https://www.linkedin.com/in/test-a15b-blank-insert-${randomUUID()}/`;
      const { candidateId, inserted } = upsertRawCandidate(db, {
        personName: "Test Person",
        profileUrl,
        source: "profile-nav",
        evidenceSummary: "",
      });
      // TODO: Step-5 assertion fill
      assert.ok(candidateId, "G-A15b.7e: candidateId must be returned");
      assert.equal(inserted, true, "G-A15b.7e: inserted must be true on first INSERT");
      const row = db.prepare("SELECT evidence_summary FROM raw_candidates WHERE id = ?").get(candidateId) as
        | { evidence_summary: string | null }
        | undefined;
      assert.ok(row, "G-A15b.7e: raw_candidates row must exist");
      assert.equal(
        row?.evidence_summary,
        null,
        "G-A15b.7e: first INSERT with empty-string evidence must store NULL (blank normalization)",
      );
    } finally {
      closeSalesDatabase(path);
    }
  });
});
