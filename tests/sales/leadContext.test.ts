/**
 * P-SP-A mock tests — T-SP-A.Context.1..4
 * get_lead_context + get_account_context tools.
 *
 * C4 fix (guardian CONCERN-4): Context.3 depends on the accounts seeder in
 * mkTestSalesDb() fixture — the seeder is now present, satisfying the gap.
 *
 * Step 5: assertion bodies filled.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  appendTimelineEvent,
  closeSalesDatabase,
  insertLead,
  openSalesDatabase,
} from "../../src/persistence/salesDb.js";
import { makeGetAccountContextTool } from "../../src/tools/sales/getAccountContext.js";
import { makeGetLeadContextTool } from "../../src/tools/sales/getLeadContext.js";
import { mkTestSalesDb, seedFreshCandidate } from "./_fixtures/salesDb.js";

describe("T-SP-A.Context — get_lead_context + get_account_context tools", () => {
  // ─── T-SP-A.Context.1 ────────────────────────────────────────────────────────
  it("T-SP-A.Context.1: get_lead_context returns 4-way join with latestScore + timeline + drafts", async () => {
    // Given: leads row + 2 lead_scores rows + 5 lead_timeline events + 2 message_drafts
    // When:  get_lead_context({leadId}) invoked
    // Then:  tool returns {ok:true, data:{lead, latestScore, timeline:[5 events DESC], drafts:[2]}};
    //        latestScore is the most recent by created_at
    closeSalesDatabase(":memory:");
    const { db, leadId, candidateId, scoreId } = await mkTestSalesDb();

    // Add a 2nd (older) score so we can verify 'latest' is correct
    const oldScoreId = randomUUID();
    db.prepare(`
      INSERT INTO lead_scores
        (id, candidate_id, lead_id, total_score, icp_fit, pain_hypothesis,
         buying_trigger, authority_level, suggested_opening_line, confidence,
         next_action, evidence_json, method_used, model, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(oldScoreId, candidateId, leadId, 65, "Medium", null, null, "Manager", null, 0.60, null, null, "Pain Chain", "deepseek", Date.now() - 10000);

    // Add 5 timeline events
    for (let i = 0; i < 5; i++) {
      appendTimelineEvent(db, { candidateId, leadId, eventType: "viewed" });
    }

    // Add 2 message drafts
    const now = Date.now();
    const d1 = randomUUID();
    const d2 = randomUUID();
    db.prepare("INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(d1, leadId, "connect_note", "Draft 1", "draft", "llm", null, now);
    db.prepare("INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(d2, leadId, "dm", "Draft 2", "draft", "user", null, now + 1);

    const tool = makeGetLeadContextTool(":memory:");
    const result = await (tool.execute as Function)({ leadId, timelineLimit: 50 });

    assert.ok(result.ok, "Tool must return ok:true");
    assert.strictEqual(result.command, "get_lead_context");

    // lead row returned
    assert.ok(result.data.lead, "data.lead must be present");
    assert.strictEqual(result.data.lead.id, leadId);

    // latestScore — must be the NEWEST score (totalScore=80, not the old 65)
    assert.ok(result.data.latestScore, "data.latestScore must be present");
    assert.strictEqual(
      result.data.latestScore.totalScore,
      80,
      "latestScore must be the most recent score (totalScore=80)",
    );
    assert.strictEqual(result.data.latestScore.id, scoreId);

    // timeline — 5 events
    assert.strictEqual(result.data.timeline.length, 5, "Must return 5 timeline events");

    // drafts — 2 drafts
    assert.strictEqual(result.data.drafts.length, 2, "Must return 2 message drafts");
  });

  // ─── T-SP-A.Context.2 ────────────────────────────────────────────────────────
  it("T-SP-A.Context.2: get_lead_context on unknown leadId returns not_found", async () => {
    // Given: empty leads table (or leadId that doesn't exist)
    // When:  get_lead_context({leadId:'nonexistent-id'}) invoked
    // Then:  tool returns {ok:false, error:{kind:'not_found'}}
    closeSalesDatabase(":memory:");
    openSalesDatabase(":memory:"); // fresh DB (no leads)

    const tool = makeGetLeadContextTool(":memory:");
    const result = await (tool.execute as Function)({ leadId: "nonexistent-id" });

    assert.strictEqual(result.ok, false, "Must return ok:false for unknown leadId");
    assert.strictEqual(result.error.kind, "not_found");
  });

  // ─── T-SP-A.Context.3 ────────────────────────────────────────────────────────
  it("T-SP-A.Context.3: get_account_context returns account + lead count + recent timeline (C4: accounts seeder)", async () => {
    // Given: accounts row (seeded by mkTestSalesDb — C4 fix) + 3 leads linked to it +
    //        7 lead_timeline events across those leads
    // When:  get_account_context({accountId}) invoked
    // Then:  tool returns {ok:true, data:{account, leadsCount:3, recentTimeline:[<=10 events]}}
    closeSalesDatabase(":memory:");
    const { db, leadId, candidateId, accountId } = await mkTestSalesDb();
    // Fixture: 1 lead linked to accountId already exists

    // Seed 2 more candidates + leads linked to same accountId
    const c2 = seedFreshCandidate(db);
    const l2 = insertLead(db, {
      candidateId: c2, personName: "Bob Context",
      profileUrl: "https://www.linkedin.com/in/bob-context/",
      stage: "qualified", ownerMode: "manual",
      accountId,
    });
    const c3 = seedFreshCandidate(db);
    const l3 = insertLead(db, {
      candidateId: c3, personName: "Carol Context",
      profileUrl: "https://www.linkedin.com/in/carol-context/",
      stage: "connect_sent", ownerMode: "magical",
      accountId,
    });

    // Seed 7 timeline events across the 3 leads (all with lead_id set so JOIN works)
    // lead 1: 3 events, lead 2: 2 events, lead 3: 2 events = 7 total
    for (let i = 0; i < 3; i++) {
      appendTimelineEvent(db, { candidateId, leadId, eventType: "viewed" });
    }
    for (let i = 0; i < 2; i++) {
      appendTimelineEvent(db, { candidateId: c2, leadId: l2, eventType: "viewed" });
    }
    for (let i = 0; i < 2; i++) {
      appendTimelineEvent(db, { candidateId: c3, leadId: l3, eventType: "viewed" });
    }

    const tool = makeGetAccountContextTool(":memory:");
    const result = await (tool.execute as Function)({ accountId, timelineLimit: 20 });

    assert.ok(result.ok, "Tool must return ok:true");
    assert.strictEqual(result.command, "get_account_context");
    assert.ok(result.data.account, "data.account must be present");
    assert.strictEqual(result.data.account.id, accountId);
    assert.strictEqual(result.data.leadsCount, 3, "leadsCount must be 3");
    assert.strictEqual(result.data.recentTimeline.length, 7, "recentTimeline must have 7 events");
  });

  // ─── T-SP-A.Context.4 ────────────────────────────────────────────────────────
  it("T-SP-A.Context.4: get_account_context on unknown accountId returns not_found", async () => {
    // Given: no accounts row with the queried id
    // When:  get_account_context({accountId:'nonexistent-id'}) invoked
    // Then:  tool returns {ok:false, error:{kind:'not_found'}}
    closeSalesDatabase(":memory:");
    openSalesDatabase(":memory:");

    const tool = makeGetAccountContextTool(":memory:");
    const result = await (tool.execute as Function)({ accountId: "nonexistent-id" });

    assert.strictEqual(result.ok, false, "Must return ok:false for unknown accountId");
    assert.strictEqual(result.error.kind, "not_found");
  });
});
