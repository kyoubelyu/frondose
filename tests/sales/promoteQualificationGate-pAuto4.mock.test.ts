/**
 * P-AUTO-4 mock tests — T-A4.* (11 scaffolds)
 * promote_candidate_to_lead: qualification gate (score floor + disqualify + bypass).
 *
 * Step 3 scaffold: all assertion bodies are TODO. Tests intentionally fail in
 * red state because the production gate + bypassScoreGate param don't exist yet.
 *
 * Step 5: assertion bodies will be filled after builder Step 4 ships the gate.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { closeSalesDatabase, openSalesDatabase } from "../../src/persistence/salesDb.js";
import { makePromoteCandidateToLeadTool } from "../../src/tools/sales/promoteCandidateToLead.js";
import { seedAutoRun, seedFreshCandidate } from "./_fixtures/salesDb.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Insert a lead_scores row for a candidate and return the scoreId. */
function seedScore(
  // biome-ignore lint/suspicious/noExplicitAny: test helper uses DB directly
  db: any,
  candidateId: string,
  opts: { totalScore: number; nextAction?: string | null },
): string {
  const scoreId = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO lead_scores
      (id, candidate_id, lead_id, total_score, icp_fit, pain_hypothesis,
       buying_trigger, authority_level, suggested_opening_line, confidence,
       next_action, evidence_json, method_used, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scoreId,
    candidateId,
    null,
    opts.totalScore,
    "Moderate",
    "Pain hypothesis",
    "Trigger event",
    "Director",
    null,
    0.75,
    opts.nextAction !== undefined ? opts.nextAction : "Connect and intro",
    JSON.stringify({ source: "profile-inspect" }),
    "Pain Chain",
    "deepseek",
    now,
  );
  return scoreId;
}

// ─── describe block ────────────────────────────────────────────────────────────

describe("T-A4 — promote_candidate_to_lead qualification gate (P-AUTO-4)", () => {

  // ─── T-A4.Cold.1 ─────────────────────────────────────────────────────────────
  it("T-A4.Cold.1: when totalScore=35, bypassPersonaCheck:true (isolating the persona gate), and bypassScoreGate omitted, promote fails with below-floor reason; no lead inserted; status stays scored", async () => {
    // Given: candidate status='scored', lead_scores row totalScore=35 (cold band), bypassScoreGate omitted
    // When:  promote_candidate_to_lead({candidateId, ownerMode:'manual', bypassPersonaCheck:true}) —
    //        bypassPersonaCheck isolates the unrelated D-29 persona-vs-ICP gate (see
    //        docs/issue-test-debt-15-intake.md item 6); bypassScoreGate is the param under test, omitted
    // Then:  {ok:false, error:{kind:'invalid_input'}} with message naming the floor; NO leads row; candidate status='scored'
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");
    const candidateId = seedFreshCandidate(db, { status: "scored" });
    seedScore(db, candidateId, { totalScore: 35 });

    const tool = makePromoteCandidateToLeadTool(":memory:");
    const result = await (tool.execute as Function)({
      candidateId,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });

    // TODO: fill assertions at Step 5 after builder ships the gate
    assert.strictEqual(result.ok, false, "TODO: gate must reject cold candidate");
    assert.strictEqual(result.error.kind, "invalid_input", "TODO: kind must be invalid_input");
    assert.match(result.error.message, /floor|40|qualified/i, "TODO: message must name the floor");
    const leadCount = (db.prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n;
    assert.strictEqual(leadCount, 0, "TODO: no leads row must be inserted");
    const status = (db.prepare("SELECT status FROM raw_candidates WHERE id = ?").get(candidateId) as { status: string }).status;
    assert.strictEqual(status, "scored", "TODO: candidate status must remain 'scored'");
  });

  // ─── T-A4.Disqualify.1 ───────────────────────────────────────────────────────
  it("T-A4.Disqualify.1: when nextAction='disqualify' (even totalScore=90), bypassPersonaCheck:true (isolating the persona gate), and bypassScoreGate omitted, promote fails naming the disqualify reason specifically; no lead", async () => {
    // Given: candidate status='scored', lead_scores row totalScore=90 but nextAction='disqualify', bypassScoreGate omitted
    // When:  promote_candidate_to_lead({candidateId, ownerMode:'manual', bypassPersonaCheck:true}) —
    //        bypassPersonaCheck isolates the unrelated D-29 persona-vs-ICP gate (see
    //        docs/issue-test-debt-15-intake.md item 6 + reconciliation §3)
    // Then:  {ok:false, error:{kind:'invalid_input'}} whose message names the disqualify-nextAction
    //        reason specifically (not the persona-mismatch reason this test used to pass on before); NO leads row
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");
    const candidateId = seedFreshCandidate(db, { status: "scored" });
    seedScore(db, candidateId, { totalScore: 90, nextAction: "disqualify" });

    const tool = makePromoteCandidateToLeadTool(":memory:");
    const result = await (tool.execute as Function)({
      candidateId,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });

    assert.strictEqual(result.ok, false, "disqualify nextAction must be rejected");
    assert.strictEqual(result.error.kind, "invalid_input", "kind must be invalid_input");
    // Pins the SPECIFIC gate reason (promoteCandidateToLead.ts's why-string for the
    // nextAction==='disqualify' branch) — not the generic invalid_input kind alone, which the
    // earlier persona gate would also have satisfied before bypassPersonaCheck was added.
    assert.match(
      result.error.message,
      /nextAction='disqualify'/,
      "message must name the disqualify reason specifically, not a floor/persona mismatch",
    );
    const leadCount = (db.prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n;
    assert.strictEqual(leadCount, 0, "no leads row must be inserted");
  });

  // ─── T-A4.Null.1 ─────────────────────────────────────────────────────────────
  it("T-A4.Null.1: when candidate status='scored' but NO lead_scores row exists, bypassPersonaCheck:true (isolating the persona gate), and bypassScoreGate omitted, promote fails naming the missing-score reason specifically; no lead", async () => {
    // Given: candidate status='scored' but lead_scores table has NO row for this candidate
    //        (anomalous case — status set externally without score_lead; getLatestScoreByCandidate returns null)
    // When:  promote_candidate_to_lead({candidateId, ownerMode:'manual', bypassPersonaCheck:true}) —
    //        bypassPersonaCheck isolates the unrelated D-29 persona-vs-ICP gate (see
    //        docs/issue-test-debt-15-intake.md item 6 + reconciliation §3)
    // Then:  {ok:false, error:{kind:'invalid_input'}} whose message names the missing-qualifying-score
    //        reason specifically (not the persona-mismatch reason this test used to pass on before); NO leads row
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");
    // Seed candidate as 'scored' but intentionally omit any lead_scores row
    const candidateId = seedFreshCandidate(db, { status: "scored" });
    // No seedScore() call — score row is MISSING

    const tool = makePromoteCandidateToLeadTool(":memory:");
    const result = await (tool.execute as Function)({
      candidateId,
      ownerMode: "manual",
      bypassPersonaCheck: true,
    });

    assert.strictEqual(result.ok, false, "missing score row must be rejected");
    assert.strictEqual(result.error.kind, "invalid_input", "kind must be invalid_input");
    // Pins the SPECIFIC gate reason (promoteCandidateToLead.ts's why-string for the
    // score==null/totalScore==null branch) — not the generic invalid_input kind alone, which the
    // earlier persona gate would also have satisfied before bypassPersonaCheck was added.
    assert.match(
      result.error.message,
      /no qualifying score on record/,
      "message must name the missing-score reason specifically",
    );
    const leadCount = (db.prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n;
    assert.strictEqual(leadCount, 0, "no leads row must be inserted");
  });

  // ─── T-A4.NextActionNull.1 ───────────────────────────────────────────────────
  it("T-A4.NextActionNull.1: when totalScore=50 and nextAction=null, promote SUCCEEDS (null must not trip disqualify arm)", async () => {
    // Given: candidate status='scored', lead_scores row totalScore=50 nextAction=null
    // When:  promote_candidate_to_lead({candidateId, bypassPersonaCheck:true, ownerMode:'manual'})
    // Then:  {ok:true, data:{leadId, alreadyPromoted:false}}; leads row exists stage='qualified'
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");
    const candidateId = seedFreshCandidate(db, { status: "scored" });
    seedScore(db, candidateId, { totalScore: 50, nextAction: null });

    const tool = makePromoteCandidateToLeadTool(":memory:");
    const result = await (tool.execute as Function)({ candidateId, ownerMode: "manual", bypassPersonaCheck: true });

    // TODO: fill assertions at Step 5
    assert.ok(result.ok, "TODO: null nextAction must NOT trip disqualify arm; must succeed");
    assert.strictEqual(result.data.alreadyPromoted, false, "TODO: new lead must have alreadyPromoted=false");
    const lead = db.prepare("SELECT stage FROM leads WHERE id = ?").get(result.data.leadId) as { stage: string } | undefined;
    assert.ok(lead, "TODO: leads row must exist");
    assert.strictEqual(lead?.stage, "qualified", "TODO: lead stage must be 'qualified'");
  });

  // ─── T-A4.Warm.1 ─────────────────────────────────────────────────────────────
  it("T-A4.Warm.1: when totalScore=40 (boundary floor), promote SUCCEEDS; leads row stage='qualified' total_score=40", async () => {
    // Given: candidate status='scored', lead_scores row totalScore=40 (inclusive warm-band boundary)
    // When:  promote_candidate_to_lead({candidateId, bypassPersonaCheck:true, ownerMode:'manual'})
    // Then:  {ok:true}; leads row stage='qualified', total_score=40
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");
    const candidateId = seedFreshCandidate(db, { status: "scored" });
    seedScore(db, candidateId, { totalScore: 40 });

    const tool = makePromoteCandidateToLeadTool(":memory:");
    const result = await (tool.execute as Function)({ candidateId, ownerMode: "manual", bypassPersonaCheck: true });

    // TODO: fill assertions at Step 5
    assert.ok(result.ok, "TODO: totalScore=40 (floor, inclusive) must succeed");
    const lead = db.prepare("SELECT stage, total_score FROM leads WHERE id = ?").get(result.data.leadId) as { stage: string; total_score: number } | undefined;
    assert.ok(lead, "TODO: leads row must exist");
    assert.strictEqual(lead?.stage, "qualified", "TODO: stage must be 'qualified'");
    assert.strictEqual(lead?.total_score, 40, "TODO: total_score must be 40");
  });

  // ─── T-A4.Hot.1 ──────────────────────────────────────────────────────────────
  it("T-A4.Hot.1: when totalScore=60, promote SUCCEEDS", async () => {
    // Given: candidate status='scored', lead_scores row totalScore=60 (hot band)
    // When:  promote_candidate_to_lead({candidateId, bypassPersonaCheck:true, ownerMode:'manual'})
    // Then:  {ok:true}; leads row exists
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");
    const candidateId = seedFreshCandidate(db, { status: "scored" });
    seedScore(db, candidateId, { totalScore: 60 });

    const tool = makePromoteCandidateToLeadTool(":memory:");
    const result = await (tool.execute as Function)({ candidateId, ownerMode: "manual", bypassPersonaCheck: true });

    // TODO: fill assertions at Step 5
    assert.ok(result.ok, "TODO: totalScore=60 must succeed");
    const leadCount = (db.prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n;
    assert.strictEqual(leadCount, 1, "TODO: exactly 1 leads row must be inserted");
  });

  // ─── T-A4.BypassManual.1 ─────────────────────────────────────────────────────
  it("T-A4.BypassManual.1: when totalScore=35 (cold), NO running auto_runs row, and bypassScoreGate=true, promote SUCCEEDS", async () => {
    // Given: candidate status='scored', totalScore=35 (cold), no auto_runs row with status='running',
    //        bypassScoreGate=true (operator override)
    // When:  promote_candidate_to_lead({candidateId, bypassScoreGate:true, bypassPersonaCheck:true, ownerMode:'manual'})
    // Then:  {ok:true, data:{leadId, alreadyPromoted:false}}; leads row exists
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");
    const candidateId = seedFreshCandidate(db, { status: "scored" });
    seedScore(db, candidateId, { totalScore: 35 });
    // Verify no running auto_run row (empty table — bypass is permitted)

    const tool = makePromoteCandidateToLeadTool(":memory:");
    const result = await (tool.execute as Function)({
      candidateId,
      ownerMode: "manual",
      bypassPersonaCheck: true,
      bypassScoreGate: true,
    });

    // TODO: fill assertions at Step 5
    assert.ok(result.ok, "TODO: bypassScoreGate=true with no active auto_run must succeed");
    assert.strictEqual(result.data.alreadyPromoted, false, "TODO: alreadyPromoted must be false");
    const leadCount = (db.prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n;
    assert.strictEqual(leadCount, 1, "TODO: leads row must be inserted on bypass");
  });

  // ─── T-A4.BypassAutoBlocked.1 ────────────────────────────────────────────────
  it("T-A4.BypassAutoBlocked.1: when totalScore=35 (cold) and a running auto_runs row exists, bypassScoreGate=true STILL FAILS; ownerMode='manual' also cannot dodge the DB signal", async () => {
    // Given: candidate status='scored', totalScore=35 (cold), a running auto_runs row (DB-authoritative signal),
    //        bypassScoreGate=true supplied
    // When:  promote_candidate_to_lead({candidateId, bypassScoreGate:true, ownerMode:'auto'}) → FAILS
    //        AND promote_candidate_to_lead({candidateId, bypassScoreGate:true, ownerMode:'manual'}) → ALSO FAILS
    //        (ownerMode is metadata-only; the DB auto_runs row is the trusted signal regardless)
    // Then:  both calls return {ok:false}; no leads row
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");
    const candidateId = seedFreshCandidate(db, { status: "scored" });
    seedScore(db, candidateId, { totalScore: 35 });
    // Seed a RUNNING auto_runs row — this is the DB-authoritative Auto signal
    seedAutoRun(db);

    const tool = makePromoteCandidateToLeadTool(":memory:");

    // First call: honest ownerMode='auto' with bypassScoreGate=true
    const resultAuto = await (tool.execute as Function)({
      candidateId,
      ownerMode: "auto",
      bypassPersonaCheck: true,
      bypassScoreGate: true,
    });

    // TODO: fill assertions at Step 5
    assert.strictEqual(resultAuto.ok, false, "TODO: bypassScoreGate=true during active auto_run must be rejected");
    assert.strictEqual(resultAuto.error.kind, "invalid_input", "TODO: kind must be invalid_input");

    // Second call: spoofed ownerMode='manual' with bypassScoreGate=true — must ALSO fail
    const resultManual = await (tool.execute as Function)({
      candidateId,
      ownerMode: "manual",
      bypassPersonaCheck: true,
      bypassScoreGate: true,
    });

    // TODO: fill assertions at Step 5
    assert.strictEqual(resultManual.ok, false, "TODO: spoofed ownerMode='manual' must not dodge DB-authoritative auto_runs signal");
    const leadCount = (db.prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n;
    assert.strictEqual(leadCount, 0, "TODO: no leads row must be inserted when auto_run is active");
  });

  // ─── T-A4.Floor.1 ────────────────────────────────────────────────────────────
  it("T-A4.Floor.1: PROMOTE_FLOOR=40 is inclusive — totalScore=39 fails, totalScore=40 succeeds", async () => {
    // Given: two candidates; one totalScore=39, one totalScore=40; no bypass; no running auto_run
    // When:  promote_candidate_to_lead({candidateId, bypassPersonaCheck:true}) for each
    // Then:  score=39 → {ok:false}; score=40 → {ok:true} — proves floor is 40 and the < comparison is strict
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");
    const candidateId39 = seedFreshCandidate(db, { status: "scored" });
    seedScore(db, candidateId39, { totalScore: 39 });
    const candidateId40 = seedFreshCandidate(db, { status: "scored" });
    seedScore(db, candidateId40, { totalScore: 40 });

    const tool = makePromoteCandidateToLeadTool(":memory:");

    const result39 = await (tool.execute as Function)({ candidateId: candidateId39, ownerMode: "manual", bypassPersonaCheck: true });
    const result40 = await (tool.execute as Function)({ candidateId: candidateId40, ownerMode: "manual", bypassPersonaCheck: true });

    // TODO: fill assertions at Step 5
    assert.strictEqual(result39.ok, false, "TODO: totalScore=39 must fail (strictly below floor 40)");
    assert.ok(result40.ok, "TODO: totalScore=40 must succeed (floor is inclusive)");
  });

  // ─── T-A4.Idempotent.1 ───────────────────────────────────────────────────────
  it("T-A4.Idempotent.1: second promote on already-promoted candidate returns existing leadId with alreadyPromoted=true; gate does not re-run", async () => {
    // Given: candidate already promoted (status='promoted', leads row exists) with totalScore=80
    // When:  promote_candidate_to_lead({candidateId}) called again
    // Then:  {ok:true, data:{leadId:<same as first>, alreadyPromoted:true}}; still exactly 1 leads row;
    //        gate does not re-run (idempotency return is BEFORE the score gate)
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");
    // Promote once (totalScore=80 — above floor)
    const candidateId = seedFreshCandidate(db, { status: "scored" });
    seedScore(db, candidateId, { totalScore: 80 });

    const tool = makePromoteCandidateToLeadTool(":memory:");
    const first = await (tool.execute as Function)({ candidateId, ownerMode: "manual", bypassPersonaCheck: true });

    // TODO: fill assertions at Step 5 (first call precondition — expect it to pass post-gate-impl)
    assert.ok(first.ok, "TODO: first promote must succeed (precondition)");
    const firstLeadId = first.data.leadId;

    // Second call — idempotency
    const second = await (tool.execute as Function)({ candidateId, ownerMode: "manual", bypassPersonaCheck: true });

    // TODO: fill assertions at Step 5
    assert.ok(second.ok, "TODO: second promote must return ok:true (idempotent)");
    assert.strictEqual(second.data.alreadyPromoted, true, "TODO: alreadyPromoted must be true on second call");
    assert.strictEqual(second.data.leadId, firstLeadId, "TODO: leadId must match the first call's leadId");
    const leadCount = (db.prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n;
    assert.strictEqual(leadCount, 1, "TODO: still exactly 1 leads row (no duplicate)");
  });

  // ─── T-A4.Default.1 ──────────────────────────────────────────────────────────
  it("T-A4.Default.1: when bypassScoreGate is omitted on a cold candidate, gate is enforced (fails)", async () => {
    // Given: candidate status='scored', totalScore=35 (cold), bypassScoreGate param NOT supplied at all
    // When:  promote_candidate_to_lead({candidateId, ownerMode:'manual'}) — no bypassScoreGate key
    // Then:  {ok:false} — proves default is gate-on (bypassScoreGate defaults to false/undefined)
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");
    const candidateId = seedFreshCandidate(db, { status: "scored" });
    seedScore(db, candidateId, { totalScore: 35 });

    const tool = makePromoteCandidateToLeadTool(":memory:");
    // Intentionally omit bypassScoreGate
    const result = await (tool.execute as Function)({ candidateId, ownerMode: "manual", bypassPersonaCheck: true });

    // TODO: fill assertions at Step 5
    assert.strictEqual(result.ok, false, "TODO: omitted bypassScoreGate must default to gate-enforced (false)");
    const leadCount = (db.prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number }).n;
    assert.strictEqual(leadCount, 0, "TODO: no leads row when gate is enforced");
  });

});
