/**
 * P-SP-A mock tests — T-SP-A.Draft.1..3
 * save_message_draft + mark_message_sent tools.
 *
 * C1 note (guardian CONCERN-1): Draft.2 (mark_message_sent happy path) asserts that
 * the FK-satisfied path works — i.e. candidateId is resolved from the lead row
 * before appendTimelineEvent is called, so lead_timeline.candidate_id is never empty.
 *
 * Step 5: assertion bodies filled.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeSalesDatabase } from "../../src/persistence/salesDb.js";
import { makeMarkMessageSentTool } from "../../src/tools/sales/markMessageSent.js";
import { makeSaveMessageDraftTool } from "../../src/tools/sales/saveMessageDraft.js";
import { mkTestSalesDb, seedDraft } from "./_fixtures/salesDb.js";

describe("T-SP-A.Draft — save_message_draft + mark_message_sent tools", () => {
  // ─── T-SP-A.Draft.1 ──────────────────────────────────────────────────────────
  it("T-SP-A.Draft.1: save_message_draft creates row with status=draft", async () => {
    // Given: leads row exists (seeded via fixture)
    // When:  save_message_draft({leadId, kind:'connect_note', text:'Hi Alice ...', createdBy:'llm'}) invoked
    // Then:  message_drafts has 1 row with status='draft', created_at set;
    //        tool returns {ok:true, data:{draftId, leadId, status:'draft'}}
    closeSalesDatabase(":memory:");
    const { db, leadId } = await mkTestSalesDb();

    const tool = makeSaveMessageDraftTool(":memory:");
    const result = await (tool.execute as Function)({
      leadId,
      kind: "connect_note",
      text: "Hi Alice, I noticed your recent move to Acme and wanted to connect.",
      createdBy: "llm",
    });

    assert.ok(result.ok, "Tool must return ok:true");
    assert.strictEqual(result.command, "save_message_draft");
    assert.ok(result.data.draftId, "Must return a draftId");
    assert.strictEqual(result.data.leadId, leadId);
    assert.strictEqual(result.data.status, "draft");

    const row = db.prepare("SELECT * FROM message_drafts WHERE id = ?").get(result.data.draftId) as {
      status: string;
      kind: string;
      lead_id: string;
      created_at: number;
    };
    assert.ok(row, "message_drafts row must exist");
    assert.strictEqual(row.status, "draft");
    assert.strictEqual(row.kind, "connect_note");
    assert.strictEqual(row.lead_id, leadId);
    assert.ok(row.created_at > 0, "created_at must be set");
  });

  // ─── T-SP-A.Draft.2 ──────────────────────────────────────────────────────────
  it("T-SP-A.Draft.2: mark_message_sent flips status=sent + appends timeline with non-empty candidateId (C1 FK fix)", async () => {
    // Given: message_drafts row with status='draft'; leads row linked
    // When:  mark_message_sent({draftId}) invoked
    // Then:  message_drafts.status='sent';
    //        lead_timeline has a 'message_sent' row with leadId matching draft.leadId;
    //        lead_timeline.candidate_id is NOT empty (C1 fix: resolved from lead row);
    //        metadata JSON contains the draftId
    closeSalesDatabase(":memory:");
    const { db, leadId, candidateId } = await mkTestSalesDb();

    const draftId = seedDraft(db, leadId);

    const tool = makeMarkMessageSentTool(":memory:");
    const result = await (tool.execute as Function)({ draftId });

    assert.ok(result.ok, "Tool must return ok:true");
    assert.strictEqual(result.data.draftId, draftId);
    assert.strictEqual(result.data.leadId, leadId);

    // Draft status flipped to 'sent'
    const draft = db.prepare("SELECT status FROM message_drafts WHERE id = ?").get(draftId) as { status: string };
    assert.strictEqual(draft.status, "sent", "Draft status must be 'sent'");

    // Timeline event appended
    const timelineRow = db
      .prepare("SELECT * FROM lead_timeline WHERE event_type = 'message_sent' AND lead_id = ?")
      .get(leadId) as { candidate_id: string; lead_id: string; metadata: string } | undefined;
    assert.ok(timelineRow, "lead_timeline must have a 'message_sent' event");
    assert.strictEqual(timelineRow.lead_id, leadId);

    // C1 fix: candidateId must be non-null (resolved from lead row, not empty string)
    assert.ok(
      timelineRow.candidate_id && timelineRow.candidate_id.length > 0,
      "C1 fix: lead_timeline.candidate_id must be non-empty (resolved from lead.candidateId)",
    );
    assert.strictEqual(timelineRow.candidate_id, candidateId);

    // Metadata contains draftId
    const metadata = JSON.parse(timelineRow.metadata ?? "{}") as Record<string, unknown>;
    assert.strictEqual(metadata.draftId, draftId, "metadata must contain the draftId");
  });

  // ─── T-SP-A.Draft.3 ──────────────────────────────────────────────────────────
  it("T-SP-A.Draft.3: mark_message_sent rejects already-sent draft", async () => {
    // Given: message_drafts row already at status='sent'
    // When:  mark_message_sent({draftId}) invoked again
    // Then:  tool returns {ok:false, error:{kind:'invalid_input', message: includes 'already sent'}};
    //        no new timeline event appended
    closeSalesDatabase(":memory:");
    const { db, leadId } = await mkTestSalesDb();

    const draftId = seedDraft(db, leadId);

    // Mark as sent first time
    const tool = makeMarkMessageSentTool(":memory:");
    const firstResult = await (tool.execute as Function)({ draftId });
    assert.ok(firstResult.ok, "First mark_message_sent must succeed");

    const timelineCountBefore = db.prepare("SELECT COUNT(*) AS n FROM lead_timeline").get() as { n: number };

    // Mark as sent second time — must fail
    const secondResult = await (tool.execute as Function)({ draftId });
    assert.strictEqual(secondResult.ok, false, "Second mark_message_sent must return ok:false");
    assert.strictEqual(secondResult.error.kind, "invalid_input");
    assert.match(secondResult.error.message, /already sent/i, "Error message must include 'already sent'");

    // No new timeline event
    const timelineCountAfter = db.prepare("SELECT COUNT(*) AS n FROM lead_timeline").get() as { n: number };
    assert.strictEqual(
      timelineCountAfter.n,
      timelineCountBefore.n,
      "No new timeline event must be appended for already-sent draft",
    );
  });
});
