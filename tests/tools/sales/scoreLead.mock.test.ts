/**
 * P-SP-B Step 4a scaffolds — T-SP-B.Lead.1..5: score_lead tool.
 *
 * All assertion bodies are TODO stubs that intentionally fail pre-builder (Step 4a).
 * Pre-builder failures:
 *   (a) Dynamic import of makeScoreLeadTool from src/tools/sales/scoreLead.js fails
 *       (file does not exist until P-SP-A + P-SP-B code is committed).
 *   (b) Even if the import resolves, the assertions below immediately fail via
 *       assert.ok(false, "T-SP-B.Lead.N TODO …").
 *
 * Gates covered: score_lead happy path, FK pre-check, nullable fields, Zod range,
 * leadId FK — all §4 T-SP-B.Lead.* behaviors.
 *
 * Fixture: uses P-SP-A's mkTestSalesDb() (:memory: DB via openSalesDatabase) +
 * seedFreshCandidate(). The fixture itself has a dynamic import of openSalesDatabase
 * which also fails pre-P-SP-A commit (expected).
 *
 * Run (mock only, after P-SP-A + P-SP-B code ships):
 *   node --import tsx --test --test-force-exit \
 *     tests/tools/sales/scoreLead.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkTestSalesDb, seedFreshCandidate } from "../../sales/_fixtures/salesDb.js";

// Gate-on-builder: makeScoreLeadTool from src/tools/sales/scoreLead.js (NEW in P-SP-B).
// biome-ignore lint/suspicious/noExplicitAny: pre-builder stub
let makeScoreLeadTool: (salesDbPath: string) => any;
try {
  // biome-ignore lint/suspicious/noExplicitAny: pre-builder stub
  const mod = (await import("../../../src/tools/sales/scoreLead.js")) as any;
  makeScoreLeadTool = mod.makeScoreLeadTool;
} catch {
  // src/tools/sales/scoreLead.ts not built yet (pre-builder Step 4b). Tests will
  // fail at the assert.ok(false, "TODO") line below — that is expected.
  makeScoreLeadTool = (_path: string) => null;
}

describe("T-SP-B.Lead — score_lead tool", () => {
  // ─── T-SP-B.Lead.1 — happy path (atomic write) ───────────────────────────────

  it("T-SP-B.Lead.1: when score_lead runs with a valid candidateId, lead_scores row + lead_timeline.scored event + raw_candidates UPDATE are written atomically", async () => {
    // Given: sales DB (:memory:) with 1 raw_candidates row id=c1 (status='new')
    // When:  score_lead execute called with all 9 fields + candidateId=c1 + totalScore=78
    // Then:  lead_scores has 1 new row with all those values + id set + created_at non-null;
    //        lead_timeline has a 'scored' event with metadata.scoreId === lead_scores.id;
    //        raw_candidates.status='scored' + latest_score_id=scoreId (ONE atomic txn)
    void (await mkTestSalesDb()); // pre-run fixture to surface import errors early
    assert.ok(
      false,
      "T-SP-B.Lead.1 TODO: fill at Step 5 — FAILS pre-builder: scoreLead.ts not shipped yet",
    );
  });

  // ─── T-SP-B.Lead.2 — FK pre-check ────────────────────────────────────────────

  it("T-SP-B.Lead.2: when candidateId is not in raw_candidates, returns fail envelope and writes NO rows", async () => {
    // Given: empty raw_candidates table (fresh :memory: DB)
    // When:  score_lead execute called with candidateId='nonexistent'
    // Then:  return {ok:false, error:{kind:"invalid_input", message:/candidateId.*record_raw_candidate first/i}};
    //        lead_scores count = 0; lead_timeline count = 0 (no rows written)
    assert.ok(
      false,
      "T-SP-B.Lead.2 TODO: fill at Step 5 — FAILS pre-builder: scoreLead.ts not shipped yet",
    );
  });

  // ─── T-SP-B.Lead.3 — thin-evidence path (nullable narrative fields) ───────────

  it("T-SP-B.Lead.3: when score_lead is called with all nullable narrative fields null, row is inserted with nulls preserved and scored event is written", async () => {
    // Given: raw_candidates row id=c1 (status='new'); all narrative fields omitted/null
    // When:  score_lead execute called with totalScore=42, confidence=0.25, nextAction='research_more',
    //        icpFit=null, painHypothesis=null, buyingTrigger=null, authorityLevel=null,
    //        suggestedOpeningLine=null, evidenceJson=null, methodUsed=null, leadId=null
    // Then:  lead_scores row inserted (total_score=42, confidence=0.25, all nullable cols = SQL NULL);
    //        lead_timeline has a 'scored' event (even on thin-evidence path);
    //        return {ok:true, data:{scoreId, candidateId:c1, totalScore:42}}
    assert.ok(
      false,
      "T-SP-B.Lead.3 TODO: fill at Step 5 — FAILS pre-builder: scoreLead.ts not shipped yet",
    );
  });

  // ─── T-SP-B.Lead.4 — Zod range validation ────────────────────────────────────

  it("T-SP-B.Lead.4: when totalScore is a decimal (0.85) or out-of-range (150), Zod rejects with a clear range error naming 0..100 INTEGER", async () => {
    // Given: score_lead Zod schema (scoreLeadParams)
    // When:  tool execute called with totalScore=0.85 (decimal) OR totalScore=150 (>100)
    // Then:  Zod parseAsync / parse throws with message naming the 0..100 INTEGER constraint;
    //        no rows written to DB in either case
    assert.ok(
      false,
      "T-SP-B.Lead.4 TODO: fill at Step 5 — FAILS pre-builder: scoreLead.ts not shipped yet",
    );
  });

  // ─── T-SP-B.Lead.5 — leadId FK populated ─────────────────────────────────────

  it("T-SP-B.Lead.5: when leadId is supplied, the new lead_scores row has lead_id=leadId (FK populated)", async () => {
    // Given: raw_candidates row id=c1 + leads row id=L1 referencing c1
    // When:  score_lead execute called with candidateId=c1, leadId=L1, totalScore=80
    // Then:  new lead_scores row has lead_id='L1' set (FK populated when supplied)
    assert.ok(
      false,
      "T-SP-B.Lead.5 TODO: fill at Step 5 — FAILS pre-builder: scoreLead.ts not shipped yet",
    );
  });
});

// Suppress TS 'unused import' for pre-builder stubs
void makeScoreLeadTool;
void seedFreshCandidate;
