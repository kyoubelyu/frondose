/**
 * P-SP-A mock tests — T-SP-A.Promote.1..3
 * promote_candidate_to_lead tool: happy path, status guard, idempotency.
 *
 * Step 5: assertion bodies filled.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { closeSalesDatabase, openSalesDatabase } from "../../src/persistence/salesDb.js";
import { makePromoteCandidateToLeadTool } from "../../src/tools/sales/promoteCandidateToLead.js";
import { mkTestSalesDb, seedFreshCandidate } from "./_fixtures/salesDb.js";

describe("T-SP-A.Promote — promote_candidate_to_lead tool", () => {
  // ─── T-SP-A.Promote.1 ────────────────────────────────────────────────────────
  it("T-SP-A.Promote.1: happy path — promotes scored candidate to qualified lead", async () => {
    // Given: raw_candidates row with status='scored'; matching lead_scores row totalScore=80
    // When:  promote_candidate_to_lead({candidateId, ownerMode:'manual'}) invoked
    // Then:  leads row exists (stage='qualified', totalScore=80 from latest score, ownerMode='manual');
    //        raw_candidates.status='promoted'; lead_timeline has 'promoted_to_lead' event;
    //        tool returns {ok:true, data:{leadId, candidateId, alreadyPromoted:false}}
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");

    // Seed a candidate at status='scored'
    const candidateId = seedFreshCandidate(db, { status: "scored" });

    // Seed a lead_scores row with totalScore=80
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
      80,
      "Strong",
      "Lacks pipeline visibility",
      "Hiring surge",
      "VP",
      null,
      0.85,
      "Connect and intro",
      JSON.stringify({ source: "profile-inspect" }),
      "Pain Chain",
      "deepseek",
      now,
    );

    const tool = makePromoteCandidateToLeadTool(":memory:");
    const result = await (tool.execute as Function)({ candidateId, ownerMode: "manual" });

    assert.ok(result.ok, "Tool must return ok:true for successful promotion");
    assert.strictEqual(result.command, "promote_candidate_to_lead");
    assert.ok(result.data.leadId, "Must return a leadId");
    assert.strictEqual(result.data.candidateId, candidateId);
    assert.strictEqual(result.data.alreadyPromoted, false);

    // Verify leads row
    const lead = db.prepare("SELECT * FROM leads WHERE id = ?").get(result.data.leadId) as {
      stage: string;
      total_score: number;
      owner_mode: string;
      candidate_id: string;
    };
    assert.ok(lead, "leads row must exist");
    assert.strictEqual(lead.stage, "qualified");
    assert.strictEqual(lead.total_score, 80, "totalScore must be 80 from latest score");
    assert.strictEqual(lead.owner_mode, "manual");
    assert.strictEqual(lead.candidate_id, candidateId);

    // Verify candidate status updated to 'promoted'
    const candidate = db.prepare("SELECT status FROM raw_candidates WHERE id = ?").get(candidateId) as {
      status: string;
    };
    assert.strictEqual(candidate.status, "promoted");

    // Verify timeline event
    const timeline = db
      .prepare("SELECT event_type FROM lead_timeline WHERE candidate_id = ? AND lead_id = ?")
      .all(candidateId, result.data.leadId) as { event_type: string }[];
    assert.ok(
      timeline.some((t) => t.event_type === "promoted_to_lead"),
      "lead_timeline must have a 'promoted_to_lead' event",
    );
  });

  // ─── T-SP-A.Promote.2 ────────────────────────────────────────────────────────
  it("T-SP-A.Promote.2: rejected when candidate status != scored", async () => {
    // Given: raw_candidates row with status='new' (never scored)
    // When:  promote_candidate_to_lead({candidateId}) invoked
    // Then:  tool returns {ok:false, error:{kind:'invalid_input', message: includes 'status'}};
    //        no leads row created; candidate status unchanged
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");

    // Seed candidate with default status='new'
    const candidateId = seedFreshCandidate(db);

    const tool = makePromoteCandidateToLeadTool(":memory:");
    const result = await (tool.execute as Function)({ candidateId });

    assert.strictEqual(result.ok, false, "Must return ok:false for unscored candidate");
    assert.strictEqual(result.error.kind, "invalid_input");
    assert.match(result.error.message, /status/i, "Error message must mention 'status'");

    // No leads row created
    const leadCount = db.prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number };
    assert.strictEqual(leadCount.n, 0, "No leads row must be created for invalid promotion");

    // Candidate status unchanged
    const candidate = db.prepare("SELECT status FROM raw_candidates WHERE id = ?").get(candidateId) as {
      status: string;
    };
    assert.strictEqual(candidate.status, "new", "Candidate status must remain 'new'");
  });

  // ─── T-SP-A.Promote.3 ────────────────────────────────────────────────────────
  it("T-SP-A.Promote.3: idempotent — second promote call returns existing leadId without new timeline event", async () => {
    // Given: candidate already promoted (status='promoted'), leads row exists
    // When:  promote_candidate_to_lead({candidateId}) invoked again
    // Then:  no new leads row inserted; tool returns {ok:true, data:{leadId:<existing>, alreadyPromoted:true}};
    //        no new 'promoted_to_lead' timeline event appended
    closeSalesDatabase(":memory:");
    const { db, candidateId, leadId } = await mkTestSalesDb();
    // Fixture: candidateId has status='promoted', leadId exists

    const timelineBefore = db
      .prepare("SELECT COUNT(*) AS n FROM lead_timeline WHERE event_type='promoted_to_lead'")
      .get() as { n: number };

    const tool = makePromoteCandidateToLeadTool(":memory:");
    const result = await (tool.execute as Function)({ candidateId });

    assert.ok(result.ok, "Must return ok:true for idempotent promote");
    assert.strictEqual(result.data.alreadyPromoted, true, "alreadyPromoted must be true");
    assert.strictEqual(result.data.leadId, leadId, "leadId must match existing lead");
    assert.strictEqual(result.data.candidateId, candidateId);

    // No new leads row
    const leadCount = db.prepare("SELECT COUNT(*) AS n FROM leads").get() as { n: number };
    assert.strictEqual(leadCount.n, 1, "Still must have exactly 1 leads row (no duplicate)");

    // No new timeline event
    const timelineAfter = db
      .prepare("SELECT COUNT(*) AS n FROM lead_timeline WHERE event_type='promoted_to_lead'")
      .get() as { n: number };
    assert.strictEqual(
      timelineAfter.n,
      timelineBefore.n,
      "No new promoted_to_lead timeline event must be appended for idempotent call",
    );
  });
});
