/**
 * P-AUTO-15b Step 3 — Test Scaffold — G-A15b.1..3d (QS-5 gate + QS-6 clamp)
 *
 * Covers:
 *   G-A15b.1   — QS-5: qualified band (totalScore>=40) requires evidenceJson present
 *   G-A15b.1a  — QS-5: evidenceJson must be valid JSON (not malformed)
 *   G-A15b.1b  — QS-5: evidenceJson must parse to non-scalar (object/array, not number)
 *   G-A15b.1c  — QS-5 happy path: totalScore>=40 with valid evidenceJson succeeds
 *   G-A15b.2   — QS-5 scope: cold/below-40 path keeps evidenceJson optional (null allowed)
 *   G-A15b.2a  — QS-5 boundary: totalScore exactly 40 fires the gate
 *   G-A15b.3   — QS-6: both signals absent clamps confidence to <= 0.4 (persisted)
 *   G-A15b.3a  — QS-6 OR-logic: only evidenceJson present skips the clamp
 *   G-A15b.3b  — QS-6 OR-logic: only buyingTrigger present skips the clamp
 *   G-A15b.3c  — QS-6 direction: clamp does not LIFT confidence below 0.4
 *   G-A15b.3d  — QS-5/QS-6 interaction: qualified+evidenceJson bypasses clamp branch
 *
 * Step-3 RED state (BEFORE builder Step 4):
 *   All assertion bodies will FAIL because the QS-5 gate + QS-6 clamp don't exist yet.
 *   The scaffold COMPILES and RUNS; the gate/clamp assertions are TODO bodies that fail.
 *
 * Run (mock only):
 *   node --import tsx --test --test-force-exit \
 *     tests/tools/sales/scoreLead-pAuto15b.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { closeSalesDatabase, openSalesDatabase } from "../../../src/persistence/salesDb.js";
import { makeScoreLeadTool } from "../../../src/tools/sales/scoreLead.js";
import { seedFreshCandidate } from "../../sales/_fixtures/salesDb.js";

// biome-ignore lint/suspicious/noExplicitAny: test DB rows
type AnyDb = any;

function tmpPath(label: string): string {
  return join(tmpdir(), `a15b-score-${label}-${randomUUID()}.sqlite`);
}

// ─── QS-5 gate ─────────────────────────────────────────────────────────────

describe("G-A15b — QS-5: qualified band evidenceJson gate (score_lead)", () => {
  it("G-A15b.1: when totalScore=50 (>=40) and evidenceJson=null, score_lead fails invalid_input citing evidenceJson", async () => {
    // Given: a fresh raw_candidates row (status='new')
    // When:  score_lead({totalScore:50, qualification:'partial_match', evidenceJson:null})
    // Then:  {ok:false, error:{kind:'invalid_input', message:/evidenceJson/i}}; no lead_scores row; status stays 'new'
    const path = tmpPath("qs5-null");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      const result = await makeScoreLeadTool(path).execute({
        candidateId,
        qualification: "partial_match",
        totalScore: 50,
        confidence: 0.6,
        evidenceJson: null,
      });
      // TODO: Step-4 makes this gate fire; assertion bodies filled at Step 5
      assert.equal(result.ok, false, "G-A15b.1: totalScore>=40 with evidenceJson=null must fail");
      const errorMsg: string = result.error?.message ?? result.error?.reason ?? "";
      assert.ok(/evidenceJson/i.test(errorMsg), `G-A15b.1: error must mention evidenceJson; got: ${errorMsg}`);
      const scoreCount = (db.prepare("SELECT COUNT(*) AS n FROM lead_scores").get() as { n: number }).n;
      assert.equal(scoreCount, 0, "G-A15b.1: no lead_scores row must be written on gate failure");
      const cand = db.prepare("SELECT status FROM raw_candidates WHERE id = ?").get(candidateId) as { status: string };
      assert.notEqual(cand.status, "scored", "G-A15b.1: raw_candidates.status must not advance to scored");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("G-A15b.1a: when totalScore=50 and evidenceJson='not-json{{' (malformed), score_lead fails citing parse/JSON", async () => {
    // Given: a fresh candidate
    // When:  score_lead({totalScore:50, ..., evidenceJson:'not-json{{'})
    // Then:  {ok:false, error.message mentions 'JSON' or 'parse' or 'valid'}; no lead_scores row
    const path = tmpPath("qs5-malformed");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      const result = await makeScoreLeadTool(path).execute({
        candidateId,
        qualification: "partial_match",
        totalScore: 50,
        confidence: 0.6,
        evidenceJson: "not-json{{",
      });
      // TODO: Step-5 assertion fill
      assert.equal(result.ok, false, "G-A15b.1a: malformed evidenceJson must fail");
      const errorMsg: string = result.error?.message ?? result.error?.reason ?? "";
      assert.ok(
        /json|parse|valid/i.test(errorMsg),
        `G-A15b.1a: error must mention JSON/parse/valid; got: ${errorMsg}`,
      );
      const scoreCount = (db.prepare("SELECT COUNT(*) AS n FROM lead_scores").get() as { n: number }).n;
      assert.equal(scoreCount, 0, "G-A15b.1a: no lead_scores row on malformed JSON");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("G-A15b.1b: when totalScore=50 and evidenceJson='42' (scalar, not object/array), score_lead fails", async () => {
    // Given: a fresh candidate
    // When:  score_lead({totalScore:50, ..., evidenceJson:'42'}) — parses to number scalar
    // Then:  {ok:false, error.message mentions object/array requirement}; no lead_scores row
    const path = tmpPath("qs5-scalar");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      const result = await makeScoreLeadTool(path).execute({
        candidateId,
        qualification: "partial_match",
        totalScore: 50,
        confidence: 0.6,
        evidenceJson: "42",
      });
      // TODO: Step-5 assertion fill
      assert.equal(result.ok, false, "G-A15b.1b: scalar evidenceJson must fail (not object/array)");
      const scoreCount = (db.prepare("SELECT COUNT(*) AS n FROM lead_scores").get() as { n: number }).n;
      assert.equal(scoreCount, 0, "G-A15b.1b: no lead_scores row on scalar JSON");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("G-A15b.1c: when totalScore=78 and evidenceJson is valid JSON object, score_lead succeeds and evidence_json persisted", async () => {
    // Given: a fresh candidate
    // When:  score_lead({totalScore:78, qualification:'qualified', evidenceJson:'{"role":"VP Sales",...}'})
    // Then:  {ok:true, data:{scoreId,...}}; lead_scores row written; evidence_json column = input string
    const path = tmpPath("qs5-happy");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      const evidenceJson = '{"role":"VP Sales","headline":"hiring SDRs"}';
      const result = await makeScoreLeadTool(path).execute({
        candidateId,
        qualification: "qualified",
        totalScore: 78,
        confidence: 0.8,
        evidenceJson,
        buyingTrigger: "recent job change",
      });
      // TODO: Step-5 assertion fill
      assert.equal(result.ok, true, `G-A15b.1c: qualified+valid evidenceJson must succeed; got ${JSON.stringify(result)}`);
      assert.ok(result.data?.scoreId, "G-A15b.1c: data.scoreId must be present");
      const row = db.prepare("SELECT evidence_json FROM lead_scores WHERE id = ?").get(result.data?.scoreId) as
        | { evidence_json: string }
        | undefined;
      assert.ok(row, "G-A15b.1c: lead_scores row must exist");
      assert.equal(row?.evidence_json, evidenceJson, "G-A15b.1c: evidence_json column must contain the input string");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("G-A15b.2: when totalScore=30 (<40) and evidenceJson=null, score_lead succeeds (gate only fires >=40)", async () => {
    // Given: a fresh candidate
    // When:  score_lead({totalScore:30, qualification:'tracked', confidence:0.3, evidenceJson:null})
    // Then:  {ok:true}; lead_scores row written with evidence_json=NULL
    const path = tmpPath("qs5-below40");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      const result = await makeScoreLeadTool(path).execute({
        candidateId,
        qualification: "tracked",
        totalScore: 30,
        confidence: 0.3,
        evidenceJson: null,
      });
      // TODO: Step-5 assertion fill
      assert.equal(result.ok, true, `G-A15b.2: cold score below 40 must succeed; got ${JSON.stringify(result)}`);
      const row = db.prepare("SELECT evidence_json FROM lead_scores WHERE candidate_id = ?").get(candidateId) as
        | { evidence_json: string | null }
        | undefined;
      assert.ok(row, "G-A15b.2: lead_scores row must exist");
      assert.equal(row?.evidence_json, null, "G-A15b.2: evidence_json must be NULL for below-40 path");
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("G-A15b.2a: when totalScore=40 (exactly boundary) and evidenceJson=null, the QS-5 gate fires (>=40 is inclusive)", async () => {
    // Given: a fresh candidate
    // When:  score_lead({totalScore:40, qualification:'partial_match', evidenceJson:null})
    // Then:  {ok:false} — boundary is inclusive; 40 >= 40 fires the gate
    const path = tmpPath("qs5-boundary40");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      const result = await makeScoreLeadTool(path).execute({
        candidateId,
        qualification: "partial_match",
        totalScore: 40,
        confidence: 0.5,
        evidenceJson: null,
      });
      // TODO: Step-5 assertion fill
      assert.equal(result.ok, false, "G-A15b.2a: totalScore=40 with no evidenceJson must fail (>= boundary)");
    } finally {
      closeSalesDatabase(path);
    }
  });
});

// ─── QS-6 clamp ─────────────────────────────────────────────────────────────

describe("G-A15b — QS-6: confidence thinness clamp (score_lead)", () => {
  it("G-A15b.3: when evidenceJson=null AND buyingTrigger=null, confidence is clamped to <=0.4 in the persisted row AND timeline event", async () => {
    // Given: a fresh candidate; score_lead with both signals absent
    // When:  {totalScore:20, qualification:'tracked', confidence:0.9, evidenceJson:null, buyingTrigger:null}
    // Then:  {ok:true}; lead_scores.confidence === 0.4 (NOT 0.9); timeline metadata.confidence === 0.4
    const path = tmpPath("qs6-clamp");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      const result = await makeScoreLeadTool(path).execute({
        candidateId,
        qualification: "tracked",
        totalScore: 20,
        confidence: 0.9,
        evidenceJson: null,
        buyingTrigger: null,
      });
      // TODO: Step-5 assertion fill
      assert.equal(result.ok, true, `G-A15b.3: thin score must succeed; got ${JSON.stringify(result)}`);
      const row = db.prepare("SELECT confidence FROM lead_scores WHERE candidate_id = ?").get(candidateId) as
        | { confidence: number }
        | undefined;
      assert.ok(row, "G-A15b.3: lead_scores row must exist");
      assert.ok(
        (row?.confidence ?? 99) <= 0.4,
        `G-A15b.3: confidence must be clamped to <=0.4; got ${row?.confidence}`,
      );
      // Timeline metadata must also reflect clamped value
      const tlRow = db
        .prepare("SELECT metadata FROM lead_timeline WHERE candidate_id = ? AND event_type = 'scored'")
        .get(candidateId) as { metadata: string } | undefined;
      assert.ok(tlRow, "G-A15b.3: scored timeline event must exist");
      const meta = JSON.parse(tlRow?.metadata ?? "{}") as { confidence?: number };
      assert.ok(
        (meta.confidence ?? 99) <= 0.4,
        `G-A15b.3: timeline metadata.confidence must be <=0.4; got ${meta.confidence}`,
      );
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("G-A15b.3a: when only evidenceJson is present (not null), confidence is NOT clamped", async () => {
    // Given: a fresh candidate
    // When:  {totalScore:20, qualification:'tracked', confidence:0.7, evidenceJson:'{"role":"X"}', buyingTrigger:null}
    // Then:  lead_scores.confidence === 0.7 (clamp skipped because evidenceJson present)
    const path = tmpPath("qs6-ev-present");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      const result = await makeScoreLeadTool(path).execute({
        candidateId,
        qualification: "tracked",
        totalScore: 20,
        confidence: 0.7,
        evidenceJson: '{"role":"X"}',
        buyingTrigger: null,
      });
      // TODO: Step-5 assertion fill
      assert.equal(result.ok, true, `G-A15b.3a: evidenceJson present must succeed; got ${JSON.stringify(result)}`);
      const row = db.prepare("SELECT confidence FROM lead_scores WHERE candidate_id = ?").get(candidateId) as
        | { confidence: number }
        | undefined;
      assert.ok(row, "G-A15b.3a: lead_scores row must exist");
      assert.ok(
        (row?.confidence ?? 0) > 0.4,
        `G-A15b.3a: confidence must NOT be clamped; expected 0.7, got ${row?.confidence}`,
      );
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("G-A15b.3b: when only buyingTrigger is present (not null), confidence is NOT clamped", async () => {
    // Given: a fresh candidate
    // When:  {totalScore:20, qualification:'tracked', confidence:0.7, evidenceJson:null, buyingTrigger:'fund raise'}
    // Then:  lead_scores.confidence === 0.7 (clamp skipped because buyingTrigger present)
    const path = tmpPath("qs6-bt-present");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      const result = await makeScoreLeadTool(path).execute({
        candidateId,
        qualification: "tracked",
        totalScore: 20,
        confidence: 0.7,
        evidenceJson: null,
        buyingTrigger: "fund raise",
      });
      // TODO: Step-5 assertion fill
      assert.equal(result.ok, true, `G-A15b.3b: buyingTrigger present must succeed; got ${JSON.stringify(result)}`);
      const row = db.prepare("SELECT confidence FROM lead_scores WHERE candidate_id = ?").get(candidateId) as
        | { confidence: number }
        | undefined;
      assert.ok(row, "G-A15b.3b: lead_scores row must exist");
      assert.ok(
        (row?.confidence ?? 0) > 0.4,
        `G-A15b.3b: confidence must NOT be clamped; expected 0.7, got ${row?.confidence}`,
      );
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("G-A15b.3c: when confidence is already below 0.4 and both signals absent, clamp does NOT lift it (Math.min direction)", async () => {
    // Given: a fresh candidate
    // When:  {totalScore:20, qualification:'tracked', confidence:0.2, evidenceJson:null, buyingTrigger:null}
    // Then:  lead_scores.confidence === 0.2 (Math.min(0.2, 0.4) = 0.2; clamp doesn't raise)
    const path = tmpPath("qs6-noLift");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      const result = await makeScoreLeadTool(path).execute({
        candidateId,
        qualification: "tracked",
        totalScore: 20,
        confidence: 0.2,
        evidenceJson: null,
        buyingTrigger: null,
      });
      // TODO: Step-5 assertion fill
      assert.equal(result.ok, true, `G-A15b.3c: low-confidence thin score must succeed; got ${JSON.stringify(result)}`);
      const row = db.prepare("SELECT confidence FROM lead_scores WHERE candidate_id = ?").get(candidateId) as
        | { confidence: number }
        | undefined;
      assert.ok(row, "G-A15b.3c: lead_scores row must exist");
      // Math.min(0.2, 0.4) = 0.2 — clamp must not raise below-0.4 values
      assert.ok(
        Math.abs((row?.confidence ?? 0) - 0.2) < 0.001,
        `G-A15b.3c: confidence must stay at 0.2 (not lifted to 0.4); got ${row?.confidence}`,
      );
    } finally {
      closeSalesDatabase(path);
    }
  });

  it("G-A15b.3d: QS-5/QS-6 interaction — qualified+evidenceJson passes QS-5 AND evidenceJson presence skips QS-6 clamp, confidence=0.9 persisted", async () => {
    // Given: a fresh candidate
    // When:  {totalScore:60, qualification:'qualified', confidence:0.9, evidenceJson:'{"role":"VP"}', buyingTrigger:null}
    // Then:  QS-5 passes (evidenceJson present+parseable+object); QS-6 clamp does NOT fire (evidenceJsonPresent);
    //        lead_scores.confidence === 0.9 (unchanged by clamp)
    const path = tmpPath("qs56-interaction");
    const db = openSalesDatabase(path) as AnyDb;
    try {
      const candidateId = seedFreshCandidate(db);
      const result = await makeScoreLeadTool(path).execute({
        candidateId,
        qualification: "qualified",
        totalScore: 60,
        confidence: 0.9,
        evidenceJson: '{"role":"VP"}',
        buyingTrigger: null,
      });
      // TODO: Step-5 assertion fill
      assert.equal(result.ok, true, `G-A15b.3d: qualified+evidenceJson must succeed; got ${JSON.stringify(result)}`);
      const row = db.prepare("SELECT confidence FROM lead_scores WHERE candidate_id = ?").get(candidateId) as
        | { confidence: number }
        | undefined;
      assert.ok(row, "G-A15b.3d: lead_scores row must exist");
      assert.ok(
        Math.abs((row?.confidence ?? 0) - 0.9) < 0.001,
        `G-A15b.3d: confidence must be 0.9 (QS-6 clamp unreachable when evidenceJson present); got ${row?.confidence}`,
      );
    } finally {
      closeSalesDatabase(path);
    }
  });
});
