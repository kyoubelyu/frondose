/**
 * P-SP-A mock tests — T-SP-A.FollowUp.1..3
 * schedule_follow_up + list_due_followups tools.
 *
 * Step 5: assertion bodies filled.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeSalesDatabase, insertLead, openSalesDatabase, setLeadFollowUp } from "../../src/persistence/salesDb.js";
import { makeListDueFollowupsTool } from "../../src/tools/sales/listDueFollowups.js";
import { makeScheduleFollowUpTool } from "../../src/tools/sales/scheduleFollowUp.js";
import { mkTestSalesDb, seedFreshCandidate } from "./_fixtures/salesDb.js";

describe("T-SP-A.FollowUp — schedule_follow_up + list_due_followups tools", () => {
  // ─── T-SP-A.FollowUp.1 ───────────────────────────────────────────────────────
  it("T-SP-A.FollowUp.1: schedule_follow_up sets leads.nextActionDueAt + appends timeline", async () => {
    // Given: leads row exists (seeded)
    // When:  schedule_follow_up({leadId, nextAction:'Re-engage in 3d', dueAt:<now+3d>}) invoked
    // Then:  leads.next_action='Re-engage in 3d'; leads.next_action_due_at equals supplied unix-ms;
    //        lead_timeline has 'follow_up_scheduled' event with matching leadId
    closeSalesDatabase(":memory:");
    const { db, leadId } = await mkTestSalesDb();

    const dueAt = Date.now() + 3 * 24 * 60 * 60 * 1000; // 3 days from now
    const tool = makeScheduleFollowUpTool(":memory:");
    const result = await (tool.execute as Function)({
      leadId,
      nextAction: "Re-engage in 3d",
      dueAt,
    });

    assert.ok(result.ok, "Tool must return ok:true");
    assert.strictEqual(result.data.leadId, leadId);
    assert.strictEqual(result.data.nextAction, "Re-engage in 3d");
    assert.strictEqual(result.data.dueAt, dueAt);

    const lead = db.prepare("SELECT next_action, next_action_due_at FROM leads WHERE id = ?").get(leadId) as {
      next_action: string;
      next_action_due_at: number;
    };
    assert.strictEqual(lead.next_action, "Re-engage in 3d");
    assert.strictEqual(lead.next_action_due_at, dueAt);

    // Timeline event
    const timelineRows = db
      .prepare("SELECT event_type FROM lead_timeline WHERE lead_id = ? AND event_type = 'follow_up_scheduled'")
      .all(leadId) as { event_type: string }[];
    assert.strictEqual(timelineRows.length, 1, "Must have 1 'follow_up_scheduled' timeline event");
  });

  // ─── T-SP-A.FollowUp.2 ───────────────────────────────────────────────────────
  it("T-SP-A.FollowUp.2: list_due_followups returns only leads with dueAt <= now, ordered ASC", async () => {
    // Given: 3 leads rows — A (dueAt=now-3600000), B (dueAt=now-1000), C (dueAt=now+10000)
    // When:  list_due_followups({limit:10}) invoked at current time
    // Then:  tool returns {ok:true, data:{leads:[A,B], count:2}} — only A and B;
    //        ordered by next_action_due_at ASC (A before B); C absent
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");

    const now = Date.now();
    const cA = seedFreshCandidate(db);
    const cB = seedFreshCandidate(db);
    const cC = seedFreshCandidate(db);

    const lA = insertLead(db, {
      candidateId: cA,
      personName: "Lead A",
      profileUrl: "https://www.linkedin.com/in/lead-a/",
      stage: "connected",
      ownerMode: "manual",
    });
    const lB = insertLead(db, {
      candidateId: cB,
      personName: "Lead B",
      profileUrl: "https://www.linkedin.com/in/lead-b/",
      stage: "connected",
      ownerMode: "manual",
    });
    const lC = insertLead(db, {
      candidateId: cC,
      personName: "Lead C",
      profileUrl: "https://www.linkedin.com/in/lead-c/",
      stage: "connected",
      ownerMode: "manual",
    });

    setLeadFollowUp(db, lA, "Follow up A", now - 3600000); // past
    setLeadFollowUp(db, lB, "Follow up B", now - 1000); // recent past
    setLeadFollowUp(db, lC, "Follow up C", now + 10000); // future

    const tool = makeListDueFollowupsTool(":memory:");
    const result = await (tool.execute as Function)({ limit: 10 });

    assert.ok(result.ok, "Tool must return ok:true");
    assert.strictEqual(result.data.count, 2, "Must return exactly 2 due leads (A and B)");
    assert.strictEqual(result.data.leads.length, 2);

    const returnedIds = result.data.leads.map((l: { id: string }) => l.id);
    assert.ok(returnedIds.includes(lA), "Lead A (oldest due) must be in results");
    assert.ok(returnedIds.includes(lB), "Lead B (recent past) must be in results");
    assert.ok(!returnedIds.includes(lC), "Lead C (future due) must NOT be in results");

    // Ordered ASC (A before B, since A has earlier dueAt)
    const aIdx = returnedIds.indexOf(lA);
    const bIdx = returnedIds.indexOf(lB);
    assert.ok(aIdx < bIdx, "Lead A must come before Lead B (older due date first)");
  });

  // ─── T-SP-A.FollowUp.3 ───────────────────────────────────────────────────────
  it("T-SP-A.FollowUp.3: list_due_followups respects limit — returns at most limit leads", async () => {
    // Given: 5 due leads (all dueAt <= now)
    // When:  list_due_followups({limit:2}) invoked
    // Then:  tool returns exactly 2 leads
    closeSalesDatabase(":memory:");
    const db = openSalesDatabase(":memory:");

    const past = Date.now() - 1000;
    for (let i = 0; i < 5; i++) {
      const cId = seedFreshCandidate(db);
      const lId = insertLead(db, {
        candidateId: cId,
        personName: `Lead ${i}`,
        profileUrl: `https://www.linkedin.com/in/lead-limit-${i}/`,
        stage: "connected",
        ownerMode: "manual",
      });
      setLeadFollowUp(db, lId, `Follow up ${i}`, past - i * 1000);
    }

    const tool = makeListDueFollowupsTool(":memory:");
    const result = await (tool.execute as Function)({ limit: 2 });

    assert.ok(result.ok, "Tool must return ok:true");
    assert.strictEqual(result.data.leads.length, 2, "Must return exactly 2 leads when limit=2");
    assert.strictEqual(result.data.count, 2);
  });
});
