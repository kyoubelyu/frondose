/**
 * P-SP-D Step 5 — T-SP-D.ApprovalAudit.1 (assertions filled)
 *
 * Approval audit integration test for the P-SP-D Manual Conversation Sales Workflow.
 *
 * Verifies the draft-before-approval invariant at the DB level:
 *   - A `message_drafts` row with status='draft' MUST exist in `sales.sqlite` BEFORE
 *     the approval gate fires (the agent calls save_message_draft → then todo_write
 *     marking the outbound step in_progress → gate fires → operator approves)
 *   - After `handleEndpoint("/workflow/approve", {stepId})`, the workflow audit writer
 *     receives an `approval_resolved` event with decision:"approved"
 *
 * This test exercises the WorkflowController in isolation (no tmux, no LLM, no real agent).
 * It simulates the gate trigger by calling onToolResults with a todo_write result that has
 * a step {requiresApproval:true, state:"in_progress"}, then calls handleEndpoint to approve.
 *
 * The sales DB assertions prove the draft-before-approval product-state invariant that
 * P-SP-D's prompt habits (Sketch A F-1: "save_message_draft before todo_write") enforce
 * at the LLM-planning level.
 *
 * Gates covered:
 *   G-PSPD.9 (T-SP-D.ApprovalAudit.1) — Approval audit + draft-before-approval invariant
 *
 * Run (mock only, no Chrome, no LLM):
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/workflow/sp-d-approval-audit.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { createWorkflowController } from "../../../src/agent/workflow/controller.js";
import { closeSalesDatabase, openSalesDatabase } from "../../../src/persistence/salesDb.js";
import { makeSaveMessageDraftTool } from "../../../src/tools/sales/saveMessageDraft.js";

/** Minimal Vercel tool execute options. */
const toolOpts = { messages: [] as never[], toolCallId: "test" };

describe("T-SP-D.ApprovalAudit — draft-before-approval invariant + approval_resolved audit event (P-SP-D §4.4)", () => {
  // ─── T-SP-D.ApprovalAudit.1 ──────────────────────────────────────────────────

  it("T-SP-D.ApprovalAudit.1: when the workflow approval gate fires for an outbound step, audit writer receives 'approval_resolved' with decision:'approved' AND message_drafts has a status='draft' row for the lead BEFORE the approval fires", async () => {
    // Given: a sales.sqlite with a seeded lead at a file tmpPath;
    //        save_message_draft({leadId, kind:"connect_note", text:"..."}) has run → draftId returned;
    //        WorkflowController created with a mocked audit writer that captures emitted events;
    //        todo_write(steps=[{title:"Send connect", requiresApproval:true, state:"in_progress"}])
    //        is simulated via onToolResults → gate fires → state.awaitingApprovalStepId is set
    // When:  handleEndpoint("/workflow/approve", {stepId}) is called (operator approves)
    // Then:  (product-state invariant at the DB level)
    //        1. message_drafts row has status='draft' (NOT 'sent' — sent happens AFTER approval + click)
    //        2. audit writer received an event with kind:"approval_resolved" AND decision:"approved"
    //           (per controller.ts:276: deps.writeWorkflowAudit({kind:"approval_resolved", decision:"approved"}))
    //        3. handleEndpoint returns {status:200, response:{ok:true}, resumePrompt: <non-empty string>}
    //           (the resumePrompt tells the agent to continue with the approved outbound click)

    const path = `/tmp/sp-d-audit-${randomUUID()}.sqlite`;
    const db = openSalesDatabase(path);
    try {
      // ── Step 1: Seed raw_candidates + leads rows directly via SQL ─────────────
      // (sales tools need a file-path DB, not :memory:; we seed via SQL not tool chain
      //  because this test only needs the DB state to exist — not to test the record/score tools)
      const candidateId = randomUUID();
      const leadId = randomUUID();
      const now = Date.now();

      db.prepare(`
        INSERT INTO raw_candidates
          (id, person_name, profile_url, source, observed_at, last_seen_at, status, evidence_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        candidateId,
        "Eve Fixture",
        `https://www.linkedin.com/in/eve-fixture-${candidateId.slice(0, 8)}/`,
        "search",
        now,
        now,
        "promoted",
        "VP Sales — strong ICP fit",
      );

      db.prepare(`
        INSERT INTO leads
          (id, candidate_id, account_id, person_name, profile_url, stage,
           total_score, confidence, one_line_pain_chain,
           next_action, next_action_due_at, owner_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        leadId,
        candidateId,
        null, // account_id nullable
        "Eve Fixture",
        `https://www.linkedin.com/in/eve-fixture-${candidateId.slice(0, 8)}/`,
        "qualified",
        75,
        0.7,
        "Scaling outbound without headcount",
        null,
        null,
        "manual",
        now,
        now,
      );

      // ── Step 2: save_message_draft (the P-SP-D F-1 habit step that precedes todo_write) ──
      const draftResult = (await makeSaveMessageDraftTool(path).execute(
        {
          leadId,
          kind: "connect_note",
          text: "Hi Eve, I noticed your work at TechCorp — I'd love to connect about scaling outbound.",
        },
        toolOpts,
      )) as { ok: boolean; data: { draftId: string } };
      assert.ok(
        draftResult.ok,
        `save_message_draft must succeed for fixture setup (got: ${JSON.stringify(draftResult)})`,
      );
      const { draftId } = draftResult.data;

      // ── Step 3: Assert draft.status='draft' BEFORE approval gate fires ─────────
      // (G-PSPD.9 product-state invariant: draft row exists in 'draft' state when gate fires)
      const draftRowBefore = db.prepare("SELECT status FROM message_drafts WHERE id = ?").get(draftId) as
        | { status: string }
        | undefined;
      assert.equal(
        draftRowBefore?.status,
        "draft",
        "message_drafts.status must be 'draft' before approval gate fires (G-PSPD.9 draft-before-approval invariant)",
      );

      // ── Step 4: Create WorkflowController with mocked audit writer ─────────────
      const auditEvents: unknown[] = [];
      const ctrl = createWorkflowController({
        emitFrame: () => {},
        writeWorkflowAudit: (event) => {
          auditEvents.push(event);
        },
      });

      // ── Step 5: Trigger approval gate via onToolResults with todo_write result ──
      // (Simulates the agent calling todo_write(requiresApproval:true, state:"in_progress")
      //  AFTER save_message_draft — as mandated by P-SP-D Sketch A F-1 habit)
      const gateResult = ctrl.onToolResults(
        [
          {
            toolName: "todo_write",
            result: {
              ok: true,
              workflowTitle: "Connect with Eve",
              steps: [
                {
                  id: "step-connect",
                  title: "Send connect note to Eve Fixture",
                  requiresApproval: true,
                  state: "in_progress",
                },
              ],
            },
          },
        ],
        { turnId: "t1", isCronTurn: false },
      );
      assert.equal(
        gateResult.abort,
        true,
        "onToolResults must return {abort:true} when requiresApproval step fires the approval gate (G-PSPD.9)",
      );
      assert.equal(
        ctrl.getState().awaitingApprovalStepId,
        "step-connect",
        "state.awaitingApprovalStepId must be 'step-connect' after gate fires (G-PSPD.9)",
      );

      // ── Step 6: Operator approves ─────────────────────────────────────────────
      const approveResult = ctrl.handleEndpoint("/workflow/approve", { stepId: "step-connect" }) as {
        status: number;
        response: { ok: boolean };
        resumePrompt?: string;
      };
      assert.equal(approveResult.status, 200, "handleEndpoint /workflow/approve must return status 200 (G-PSPD.9)");
      assert.equal(
        (approveResult.response as { ok: boolean }).ok,
        true,
        "handleEndpoint /workflow/approve must return {ok:true} (G-PSPD.9)",
      );
      assert.ok(
        typeof approveResult.resumePrompt === "string" && approveResult.resumePrompt.length > 0,
        "handleEndpoint must return a non-empty resumePrompt (G-PSPD.9)",
      );
      assert.ok(
        approveResult.resumePrompt?.includes("WORKFLOW RESUME"),
        "resumePrompt must begin with 'WORKFLOW RESUME' (per controller.ts:281, G-PSPD.9)",
      );

      // ── Step 7: Assert approval_resolved audit event captured ─────────────────
      const approvalEvent = auditEvents.find((e) => (e as { kind?: string }).kind === "approval_resolved") as
        | { kind: string; decision: string }
        | undefined;
      assert.ok(approvalEvent !== undefined, "audit writer must have received an 'approval_resolved' event (G-PSPD.9)");
      assert.equal(
        approvalEvent?.decision,
        "approved",
        "approval_resolved event must have decision:'approved' (G-PSPD.9 approval audit)",
      );

      // ── Step 8: Assert draft still 'draft' (mark_message_sent NOT yet called) ──
      // (The approval only unlocks the agent to proceed; the CLICK + mark_message_sent
      //  happens in the next agent turn after approval. At this point draft stays 'draft'.)
      const draftRowAfter = db.prepare("SELECT status FROM message_drafts WHERE id = ?").get(draftId) as
        | { status: string }
        | undefined;
      assert.equal(
        draftRowAfter?.status,
        "draft",
        "message_drafts.status must still be 'draft' after approval (mark_message_sent has not been called — G-PSPD.9)",
      );
    } finally {
      closeSalesDatabase(path);
    }
  });
});
