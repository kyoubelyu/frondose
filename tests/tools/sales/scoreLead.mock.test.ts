/**
 * P-SP-B Step 5 — T-SP-B.Lead.1..5: score_lead tool.
 *
 * FILLED at Step 5. All 5 assertion bodies filled with real assertions.
 * Test isolation: each it() uses a unique OS temp path so salesDb singleton
 * instances don't bleed between tests.
 *
 * Gates covered: score_lead happy path (atomic write), FK pre-check, nullable
 * fields (thin-evidence path), Zod range/int validation, leadId FK.
 *
 * Run (mock only):
 *   node --import tsx --test --test-force-exit \
 *     tests/tools/sales/scoreLead.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { closeSalesDatabase, insertLead, openSalesDatabase } from "../../../src/persistence/salesDb.js";
import { seedFreshCandidate } from "../../sales/_fixtures/salesDb.js";

// Gate-on-builder: makeScoreLeadTool from src/tools/sales/scoreLead.js (NEW in P-SP-B).
// biome-ignore lint/suspicious/noExplicitAny: pre-builder stub
let makeScoreLeadTool: (salesDbPath: string) => any;
try {
  // biome-ignore lint/suspicious/noExplicitAny: pre-builder stub
  const mod = (await import("../../../src/tools/sales/scoreLead.js")) as any;
  makeScoreLeadTool = mod.makeScoreLeadTool;
} catch {
  // Shouldn't happen post-P-SP-B but guard is kept for documentation.
  makeScoreLeadTool = (_path: string) => null;
}

describe("T-SP-B.Lead — score_lead tool", () => {
  // ─── T-SP-B.Lead.1 — happy path (atomic write) ───────────────────────────────

  it("T-SP-B.Lead.1: when score_lead runs with a valid candidateId, lead_scores row + lead_timeline.scored event + raw_candidates UPDATE are written atomically", async () => {
    // Given: sales DB (:memory: path unique per test) with 1 raw_candidates row (status='new')
    // When:  score_lead.execute called with all score fields + candidateId + totalScore=78
    // Then:  lead_scores has 1 new row with those values; lead_timeline has a 'scored' event
    //        with metadata.scoreId === lead_scores.id; raw_candidates.status='scored' +
    //        latest_score_id=scoreId (ONE atomic txn); envelope = {ok:true, data:{scoreId,candidateId,totalScore}}

    const path = join(tmpdir(), `sp-b-lead-1-${randomUUID()}.sqlite`);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture db handle
    const db = openSalesDatabase(path) as any;
    try {
      const candidateId = seedFreshCandidate(db);

      const tool = makeScoreLeadTool(path);
      const result = await tool.execute({
        candidateId,
        // P-AUTO-5: qualification required; totalScore:78 is in qualified band [60,100]
        qualification: "qualified",
        totalScore: 78,
        confidence: 0.75,
        icpFit: "VP Sales, EMEA match",
        painHypothesis: "scaling outbound without headcount",
        buyingTrigger: "recent job change",
        authorityLevel: "economic buyer (VP)",
        suggestedOpeningLine: "Noticed your move to Acme — congrats.",
        nextAction: "connect_now",
        evidenceJson: '{"connections":"500+"}',
        methodUsed: "solution_selling",
        leadId: null,
      });

      // Envelope checks
      assert.equal(result.ok, true, "execute must return ok:true envelope");
      assert.equal(result.command, "score_lead", "command field must be 'score_lead'");
      assert.equal(result.data.candidateId, candidateId, "data.candidateId must match input");
      assert.equal(result.data.totalScore, 78, "data.totalScore must match input");
      assert.ok(result.data.scoreId, "data.scoreId must be a non-empty UUID");

      // DB: lead_scores row
      const scoreRow = db.prepare("SELECT * FROM lead_scores WHERE id = ?").get(result.data.scoreId);
      assert.ok(scoreRow, "lead_scores row must exist after score_lead");
      assert.equal(scoreRow.total_score, 78, "lead_scores.total_score must be 78");
      assert.equal(scoreRow.confidence, 0.75, "lead_scores.confidence must be 0.75");
      assert.equal(scoreRow.candidate_id, candidateId, "lead_scores.candidate_id must match");
      assert.equal(scoreRow.method_used, "solution_selling", "lead_scores.method_used must match");
      assert.equal(scoreRow.model, "agent", "lead_scores.model must be 'agent' (Option B)");
      assert.ok(scoreRow.created_at > 0, "lead_scores.created_at must be a non-zero unix timestamp");
      assert.equal(scoreRow.lead_id, null, "lead_scores.lead_id must be null when leadId not supplied");

      // DB: lead_timeline.scored event
      const tlRow = db
        .prepare("SELECT * FROM lead_timeline WHERE candidate_id = ? AND event_type = 'scored'")
        .get(candidateId);
      assert.ok(tlRow, "lead_timeline must have a 'scored' event for this candidate");
      assert.equal(tlRow.event_type, "scored");
      const tlMeta = JSON.parse(tlRow.metadata);
      assert.equal(tlMeta.scoreId, result.data.scoreId, "timeline metadata.scoreId must match lead_scores.id");
      assert.equal(tlMeta.totalScore, 78, "timeline metadata.totalScore must be 78");

      // DB: raw_candidates status + latest_score_id (atomic txn confirmation)
      const candRow = db
        .prepare("SELECT status, latest_score_id FROM raw_candidates WHERE id = ?")
        .get(candidateId);
      assert.equal(candRow.status, "scored", "raw_candidates.status must be 'scored' after score_lead");
      assert.equal(
        candRow.latest_score_id,
        result.data.scoreId,
        "raw_candidates.latest_score_id must point at new lead_scores.id",
      );
    } finally {
      closeSalesDatabase(path);
    }
  });

  // ─── T-SP-B.Lead.2 — FK pre-check ────────────────────────────────────────────

  it("T-SP-B.Lead.2: when candidateId is not in raw_candidates, returns fail envelope and writes NO rows", async () => {
    // Given: empty raw_candidates table (fresh DB); candidateId='nonexistent-id'
    // When:  score_lead.execute called with candidateId='nonexistent-id'
    // Then:  {ok:false, error:{kind:"invalid_input", message: matches /candidateId.*record_raw_candidate first/i}};
    //        lead_scores count = 0; lead_timeline count = 0 (no rows written on FK failure)

    const path = join(tmpdir(), `sp-b-lead-2-${randomUUID()}.sqlite`);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture db handle
    const db = openSalesDatabase(path) as any;
    try {
      const tool = makeScoreLeadTool(path);
      const result = await tool.execute({
        candidateId: "nonexistent-id",
        // P-AUTO-5: qualification required; totalScore:50 is in partial_match band [40,59]
        qualification: "partial_match",
        totalScore: 50,
        confidence: 0.5,
      });

      // Envelope: fail with invalid_input
      assert.equal(result.ok, false, "FK failure must return ok:false");
      assert.equal(result.error.kind, "invalid_input", "error.kind must be 'invalid_input'");
      assert.ok(
        /nonexistent-id/i.test(result.error.message),
        `error.message must mention the candidateId; got: ${result.error.message}`,
      );
      assert.ok(
        /record_raw_candidate/i.test(result.error.message),
        `error.message must mention record_raw_candidate (remediation hint); got: ${result.error.message}`,
      );

      // DB: nothing written (atomic rollback on FK pre-check failure)
      const scoreCount = db.prepare("SELECT COUNT(*) as cnt FROM lead_scores").get().cnt;
      assert.equal(scoreCount, 0, "lead_scores must be empty after FK pre-check failure");
      const tlCount = db.prepare("SELECT COUNT(*) as cnt FROM lead_timeline").get().cnt;
      assert.equal(tlCount, 0, "lead_timeline must be empty after FK pre-check failure");
    } finally {
      closeSalesDatabase(path);
    }
  });

  // ─── T-SP-B.Lead.3 — thin-evidence path (nullable narrative fields) ───────────

  it("T-SP-B.Lead.3: when score_lead is called with all nullable narrative fields null, row is inserted with nulls preserved and scored event is written", async () => {
    // Given: raw_candidates row id=c1 (status='new'); all narrative fields omitted/null
    // When:  score_lead.execute called with totalScore=30, confidence=0.25, nextAction='research_more',
    //        all nullable narrative fields null, leadId=null
    // Then:  lead_scores row inserted (total_score=30, confidence=0.25, nullable cols=SQL NULL);
    //        lead_timeline has a 'scored' event (even on thin-evidence path);
    //        envelope = {ok:true, data:{scoreId, candidateId, totalScore:30}}
    //
    // P-AUTO-15b MR-2 (Step 3, 2026-06-15): totalScore lowered from 42→30 (tracked band) so the test
    // remains a valid "thin-evidence nullable-fields" test without being blocked by the new QS-5 gate
    // (which fires at totalScore>=40 when evidenceJson=null). The test INTENT is unchanged — it verifies
    // nullable columns are persisted correctly, not the qualified-band gate behavior.

    const path = join(tmpdir(), `sp-b-lead-3-${randomUUID()}.sqlite`);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture db handle
    const db = openSalesDatabase(path) as any;
    try {
      const candidateId = seedFreshCandidate(db);

      const tool = makeScoreLeadTool(path);
      const result = await tool.execute({
        candidateId,
        // P-AUTO-5: qualification required; totalScore:30 is in tracked band [0,39]
        qualification: "tracked",
        totalScore: 30,
        confidence: 0.25,
        nextAction: "research_more",
        icpFit: null,
        painHypothesis: null,
        buyingTrigger: null,
        authorityLevel: null,
        suggestedOpeningLine: null,
        evidenceJson: null,
        methodUsed: null,
        leadId: null,
      });

      assert.equal(result.ok, true, "thin-evidence score must return ok:true");
      assert.equal(result.data.totalScore, 30, "data.totalScore must be 30");

      // Nullable cols must be SQL NULL
      const row = db.prepare("SELECT * FROM lead_scores WHERE id = ?").get(result.data.scoreId);
      assert.ok(row, "lead_scores row must exist");
      assert.equal(row.total_score, 30);
      assert.equal(row.confidence, 0.25);
      assert.equal(row.icp_fit, null, "icp_fit must be SQL NULL (thin-evidence)");
      assert.equal(row.pain_hypothesis, null, "pain_hypothesis must be SQL NULL");
      assert.equal(row.buying_trigger, null, "buying_trigger must be SQL NULL");
      assert.equal(row.authority_level, null, "authority_level must be SQL NULL");
      assert.equal(row.suggested_opening_line, null, "suggested_opening_line must be SQL NULL");
      assert.equal(row.evidence_json, null, "evidence_json must be SQL NULL");
      assert.equal(row.method_used, null, "method_used must be SQL NULL");

      // Timeline event must be written even on thin-evidence path (scoring still happened)
      const tlRow = db
        .prepare("SELECT * FROM lead_timeline WHERE candidate_id = ? AND event_type = 'scored'")
        .get(candidateId);
      assert.ok(tlRow, "lead_timeline.scored event must be written even on thin-evidence path");
    } finally {
      closeSalesDatabase(path);
    }
  });

  // ─── T-SP-B.Lead.4 — Zod range validation ────────────────────────────────────

  it("T-SP-B.Lead.4: when totalScore is a decimal (0.85) or out-of-range (150), Zod rejects with a clear range error naming 0..100 INTEGER", async () => {
    // Given: score_lead Zod schema (accessed via makeScoreLeadTool(path).parameters)
    // When:  tool.parameters.safeParse called with totalScore=150 OR totalScore=0.85
    // Then:  {success:false}; issues array has at least 1 issue with path[0]==="totalScore"
    //        (no DB write in either case — Zod gate precedes execute body)

    // Use any path — Zod safeParse never touches the DB
    const tool = makeScoreLeadTool(join(tmpdir(), "sp-b-lead-4-zod-only.sqlite"));

    // Case A: totalScore=150 (> max 100)
    const resultOver = tool.parameters.safeParse({
      candidateId: "c1",
      totalScore: 150,
      confidence: 0.5,
    });
    assert.equal(resultOver.success, false, "totalScore=150 must fail Zod (max 100)");
    assert.ok(
      resultOver.error.issues.some(
        (i: { path: (string | number)[] }) => i.path[0] === "totalScore",
      ),
      `Zod error must reference totalScore path for value 150; issues: ${JSON.stringify(resultOver.error.issues)}`,
    );

    // Case B: totalScore=0.85 (decimal — violates .int() constraint)
    const resultDecimal = tool.parameters.safeParse({
      candidateId: "c1",
      totalScore: 0.85,
      confidence: 0.5,
    });
    assert.equal(resultDecimal.success, false, "totalScore=0.85 (decimal) must fail Zod (.int() constraint)");
    assert.ok(
      resultDecimal.error.issues.some(
        (i: { path: (string | number)[] }) => i.path[0] === "totalScore",
      ),
      `Zod error must reference totalScore path for decimal 0.85; issues: ${JSON.stringify(resultDecimal.error.issues)}`,
    );
  });

  // ─── T-SP-B.Lead.5 — leadId FK populated ─────────────────────────────────────

  it("T-SP-B.Lead.5: when leadId is supplied, the new lead_scores row has lead_id=leadId (FK populated)", async () => {
    // Given: raw_candidates row id=c1 + leads row id=L1 referencing c1
    // When:  score_lead.execute called with candidateId=c1, leadId=L1, totalScore=80
    // Then:  new lead_scores row has lead_id=L1 set (FK populated when supplied)

    const path = join(tmpdir(), `sp-b-lead-5-${randomUUID()}.sqlite`);
    // biome-ignore lint/suspicious/noExplicitAny: test fixture db handle
    const db = openSalesDatabase(path) as any;
    try {
      const candidateId = seedFreshCandidate(db);
      // Insert a leads row referencing this candidate
      const leadId = insertLead(db, {
        candidateId,
        personName: "Bob Fixture",
        profileUrl: `https://www.linkedin.com/in/bob-fixture-lead5/`,
        stage: "scored",
        ownerMode: "manual",
      });

      const tool = makeScoreLeadTool(path);
      const result = await tool.execute({
        candidateId,
        leadId,
        // P-AUTO-5: qualification required; totalScore:80 is in qualified band [60,100]
        qualification: "qualified",
        totalScore: 80,
        confidence: 0.8,
        // P-AUTO-15b MR-2 (Step 3, 2026-06-15): add evidenceJson so the QS-5 gate (totalScore>=40
        // requires evidenceJson) passes. The test intent is leadId FK, not thin-evidence behavior.
        evidenceJson: '{"source":"lead5-fixture","role":"test"}',
      });

      assert.equal(result.ok, true, "execute must return ok:true envelope");

      // DB: lead_id FK populated in lead_scores row
      const row = db.prepare("SELECT lead_id FROM lead_scores WHERE id = ?").get(result.data.scoreId);
      assert.ok(row, "lead_scores row must exist");
      assert.equal(row.lead_id, leadId, "lead_scores.lead_id must match the supplied leadId");
    } finally {
      closeSalesDatabase(path);
    }
  });
});
