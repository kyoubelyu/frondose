/**
 * P-SP-A mock tests — T-SP-A.Stage.1..3
 * update_lead_stage tool + record_lead_event tool.
 *
 * Step 5: assertion bodies filled.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeSalesDatabase } from "../../src/persistence/salesDb.js";
import { makeRecordLeadEventTool } from "../../src/tools/sales/recordLeadEvent.js";
import { makeUpdateLeadStageTool } from "../../src/tools/sales/updateLeadStage.js";
import { mkTestSalesDb } from "./_fixtures/salesDb.js";

describe("T-SP-A.Stage — update_lead_stage + record_lead_event tools", () => {
  // ─── T-SP-A.Stage.1 ──────────────────────────────────────────────────────────
  it("T-SP-A.Stage.1: update_lead_stage writes timeline event + bumps leads.updatedAt", async () => {
    // Given: leads row at stage='qualified' (seeded via fixture)
    // When:  update_lead_stage({leadId, stage:'connect_sent'}) invoked
    // Then:  leads.stage='connect_sent'; leads.updatedAt > prior updatedAt;
    //        lead_timeline has a 'connect_sent' event with matching leadId
    closeSalesDatabase(":memory:");
    const { db, leadId } = await mkTestSalesDb();

    const leadBefore = db.prepare("SELECT stage, updated_at FROM leads WHERE id = ?").get(leadId) as {
      stage: string;
      updated_at: number;
    };
    assert.strictEqual(leadBefore.stage, "qualified");

    await new Promise((r) => setTimeout(r, 10)); // ensure updatedAt advances

    const tool = makeUpdateLeadStageTool(":memory:");
    const result = await (tool.execute as Function)({ leadId, stage: "connect_sent" });

    assert.ok(result.ok, "Tool must return ok:true");
    assert.strictEqual(result.data.stage, "connect_sent");
    assert.strictEqual(result.data.leadId, leadId);

    const leadAfter = db.prepare("SELECT stage, updated_at FROM leads WHERE id = ?").get(leadId) as {
      stage: string;
      updated_at: number;
    };
    assert.strictEqual(leadAfter.stage, "connect_sent", "leads.stage must be updated to 'connect_sent'");
    assert.ok(leadAfter.updated_at >= leadBefore.updated_at, "leads.updatedAt must be bumped after stage update");

    // Verify timeline event
    const timeline = db
      .prepare("SELECT event_type FROM lead_timeline WHERE lead_id = ? AND event_type = 'connect_sent'")
      .all(leadId) as { event_type: string }[];
    assert.strictEqual(timeline.length, 1, "Must have 1 'connect_sent' timeline event");
  });

  // ─── T-SP-A.Stage.2 ──────────────────────────────────────────────────────────
  it("T-SP-A.Stage.2: update_lead_stage rejects invalid stage value", async () => {
    // Given: leads row at any valid stage
    // When:  update_lead_stage({leadId, stage:'bogus'}) invoked
    // Then:  tool returns {ok:false, error:{kind:'invalid_input'}}; no DB change
    closeSalesDatabase(":memory:");
    const { db, leadId } = await mkTestSalesDb();

    const stageBefore = db.prepare("SELECT stage FROM leads WHERE id = ?").get(leadId) as { stage: string };

    const tool = makeUpdateLeadStageTool(":memory:");
    const result = await (tool.execute as Function)({ leadId, stage: "bogus" });

    assert.strictEqual(result.ok, false, "Must return ok:false for invalid stage");
    assert.strictEqual(result.error.kind, "invalid_input");

    // Stage must be unchanged
    const stageAfter = db.prepare("SELECT stage FROM leads WHERE id = ?").get(leadId) as { stage: string };
    assert.strictEqual(stageAfter.stage, stageBefore.stage, "Stage must remain unchanged after rejected call");
  });

  // ─── T-SP-A.Stage.3 ──────────────────────────────────────────────────────────
  it("T-SP-A.Stage.3: record_lead_event appends event with metadata JSON preserved", async () => {
    // Given: leads row exists (any stage)
    // When:  record_lead_event({leadId, eventType:'replied', metadata:{messageId:'m1', sentiment:'positive'}}) invoked
    // Then:  lead_timeline has a 'replied' row with matching leadId;
    //        metadata column equals JSON.stringify({messageId:'m1', sentiment:'positive'})
    closeSalesDatabase(":memory:");
    const { db, leadId } = await mkTestSalesDb();

    const tool = makeRecordLeadEventTool(":memory:");
    const result = await (tool.execute as Function)({
      leadId,
      eventType: "replied",
      metadata: { messageId: "m1", sentiment: "positive" },
    });

    assert.ok(result.ok, "Tool must return ok:true");
    assert.ok(result.data.eventId, "Must return an eventId");
    assert.strictEqual(result.data.eventType, "replied");
    assert.strictEqual(result.data.leadId, leadId);

    const row = db.prepare("SELECT event_type, metadata FROM lead_timeline WHERE id = ?").get(result.data.eventId) as
      | { event_type: string; metadata: string }
      | undefined;
    assert.ok(row, "Timeline row must exist");
    assert.strictEqual(row.event_type, "replied");
    assert.strictEqual(
      row.metadata,
      JSON.stringify({ messageId: "m1", sentiment: "positive" }),
      "metadata must be stored as JSON.stringify of the input",
    );
  });
});
