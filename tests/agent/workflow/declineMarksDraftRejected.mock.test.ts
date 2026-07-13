/**
 * P-FIX-MARK-SENT-STALE-DRAFT FM-2 (r2-revised) — decline() retires the declined step's
 * draft (draft → rejected), fail-closed BEFORE any workflow state mutation.
 *
 * THE BUG (live 2026-07-13): decline() never touched message_drafts, so a declined draft
 * stayed status='draft' and its stale draftId could later be marked sent. Resolution order
 * (r2 critic: NEVER guess by cardinality/order — the reverted lineage-carry could retire or
 * publish the WRONG draft):
 *   1. the step's captured draftId when present;
 *   2. otherwise server-side SEMANTIC correlation via deps.findDraftForDeclinedStep
 *      (pending draft whose lead is named in the step title);
 *   3. ambiguity → DraftLineageAmbiguous commit warning, nothing retired.
 * A throwing persistence call keeps the approval gate pending and retryable
 * (no state mutation, no resolved frame, no audit event, HTTP 500).
 *
 * Run:
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/agent/workflow/declineMarksDraftRejected.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { WorkflowControllerDeps } from "../../../src/agent/workflow/controller.js";
import { createWorkflowController } from "../../../src/agent/workflow/controller.js";
import { findDraftForDeclinedStep, markDraftRejected, openSalesDatabase } from "../../../src/persistence/salesDb.js";
import { makeSaveMessageDraftTool } from "../../../src/tools/sales/saveMessageDraft.js";
import { makeTmpFile } from "../../_helpers/tmp";

// biome-ignore lint/suspicious/noExplicitAny: runtime envelope introspection
type AnyObj = Record<string, any>;

/** Minimal Vercel tool execute options. */
const toolOpts = { messages: [] as never[], toolCallId: "test" };

const ctx = { turnId: "t1", isCronTurn: false } as const;

/** A save_message_draft success envelope shaped like the real tool's output. */
function saveDraftResult(draftId: string, leadId: string): { toolName: string; result: unknown; args: unknown } {
  return {
    toolName: "save_message_draft",
    result: { ok: true, command: "save_message_draft", data: { draftId, leadId, status: "draft" } },
    args: { leadId, kind: "connect_note" },
  };
}

function makeCtrl(deps: Partial<WorkflowControllerDeps>) {
  const frames: AnyObj[] = [];
  const audits: AnyObj[] = [];
  const ctrl = createWorkflowController({
    emitFrame: (f) => {
      frames.push(f as AnyObj);
    },
    writeWorkflowAudit: (e) => {
      audits.push(e as AnyObj);
    },
    ...deps,
  });
  return { ctrl, frames, audits };
}

/** Replays the LIVE incident's exact tool order (soul habit): save_message_draft lands first
 *  (synthesizes a workflow, capturing the draftId THERE), then the agent's todo_write re-plans
 *  under a DIFFERENT title — the new gating step has NO draftId (verified live: step_68ccba17
 *  had draftId===undefined). decline() must fall back to semantic correlation. Returns the
 *  pending stepId. */
function driveLiveOrder(ctrl: ReturnType<typeof createWorkflowController>, draftId: string, leadId: string): string {
  ctrl.onToolResults([saveDraftResult(draftId, leadId)], ctx);
  const gate = ctrl.onToolResults(
    [
      {
        toolName: "todo_write",
        result: {
          ok: true,
          workflowTitle: "Send connect note to Wilfred Fixture",
          steps: [
            { id: "s-save", title: "保存 connect note 草稿", requiresApproval: false, state: "completed" },
            {
              id: "s-send",
              title: "Send connect note to Wilfred Fixture",
              requiresApproval: true,
              state: "in_progress",
            },
          ],
        },
      },
    ],
    ctx,
  );
  assert.equal(gate.abort, true, "the todo_write re-plan's approval gate must fire");
  const stepId = ctrl.getState().awaitingApprovalStepId;
  assert.ok(stepId, "a pending approval step must exist after the re-plan");
  const step = ctrl.getState().current?.steps.find((s) => s.id === stepId);
  assert.equal(
    step?.draftId,
    undefined,
    "precondition: the re-planned gating step has NO captured draftId (live ground truth)",
  );
  return stepId as string;
}

describe("T-DeclineDraft — decline() retires the declined step's draft (captured id, else semantic correlation)", () => {
  it("T-DeclineDraft.1: LIVE order (save → different-title re-plan, no captured draftId) → decline consults findDraftForDeclinedStep(step.title) and retires ITS result", () => {
    // Given: the live tool order — the gating step has NO draftId; a finder spy resolves the
    //        step title to the pending draft; a retire spy records calls.
    // When:  /workflow/decline for the pending step.
    // Then:  finder called once with the step title; markDraftDeclined called exactly once with
    //        the finder's id; decline resolves normally with the declined audit event.
    const draftId = randomUUID();
    const finderCalls: string[] = [];
    const retired: string[] = [];
    const { ctrl, audits } = makeCtrl({
      findDraftForDeclinedStep: (stepTitle) => {
        finderCalls.push(stepTitle);
        return { id: draftId };
      },
      markDraftDeclined: (id) => {
        retired.push(id);
      },
    });
    const stepId = driveLiveOrder(ctrl, draftId, randomUUID());

    const r = ctrl.handleEndpoint("/workflow/decline", { stepId }) as AnyObj;

    assert.deepEqual(
      finderCalls,
      ["Send connect note to Wilfred Fixture"],
      "finder must receive the declined step's title",
    );
    assert.deepEqual(retired, [draftId], "markDraftDeclined must be called exactly once with the resolved draftId");
    assert.equal(r.status, 200, "decline must resolve with 200");
    assert.equal(r.response?.ok, true, "decline must resolve ok");
    assert.equal(ctrl.getState().awaitingApprovalStepId, null, "gate must be cleared after a successful decline");
    assert.equal(
      audits.find((e) => e.kind === "approval_resolved")?.decision,
      "declined",
      "audit records the declined resolution",
    );
  });

  it("T-DeclineDraft.2: a CAPTURED step.draftId takes precedence — the finder is not consulted", () => {
    // Given: todo_write proposes a PENDING requiresApproval step (no gate yet); the subsequent
    //        save_message_draft auto-advances it, capturing the draftId on the step and firing
    //        the gate. Finder + retire spies.
    // When:  /workflow/decline.
    // Then:  markDraftDeclined gets the CAPTURED id; the finder is never called.
    const draftId = randomUUID();
    const finderCalls: string[] = [];
    const retired: string[] = [];
    const { ctrl } = makeCtrl({
      findDraftForDeclinedStep: (stepTitle) => {
        finderCalls.push(stepTitle);
        return null;
      },
      markDraftDeclined: (id) => {
        retired.push(id);
      },
    });
    ctrl.onToolResults(
      [
        {
          toolName: "todo_write",
          result: {
            ok: true,
            workflowTitle: "Send connect note to Captured Fixture",
            steps: [
              { id: "s1", title: "Send connect note to Captured Fixture", requiresApproval: true, state: "pending" },
            ],
          },
        },
      ],
      ctx,
    );
    assert.equal(ctrl.getState().awaitingApprovalStepId, null, "precondition: pending step has not gated yet");
    const gate = ctrl.onToolResults([saveDraftResult(draftId, randomUUID())], ctx);
    assert.equal(gate.abort, true, "autoAdvanceOnSaveDraft must fire the gate");
    const stepId = ctrl.getState().awaitingApprovalStepId;
    assert.ok(stepId, "a pending approval step must exist");
    const step = ctrl.getState().current?.steps.find((s) => s.id === stepId);
    assert.equal(step?.draftId, draftId, "precondition: captureDraftId bound the id to the step");

    const r = ctrl.handleEndpoint("/workflow/decline", { stepId }) as AnyObj;

    assert.deepEqual(retired, [draftId], "the captured id must be retired");
    assert.deepEqual(finderCalls, [], "the finder must NOT be consulted when a captured id exists");
    assert.equal(r.response?.ok, true, "decline must resolve ok");
  });

  it("T-DeclineDraft.3: both callbacks omitted → decline() does not throw (back-compat for every existing WorkflowControllerDeps construction)", () => {
    // Given: a controller constructed WITHOUT the two new optional callbacks; live-order gate.
    // When:  /workflow/decline.
    // Then:  no throw; decline resolves ok.
    const { ctrl } = makeCtrl({});
    const stepId = driveLiveOrder(ctrl, randomUUID(), randomUUID());

    const r = ctrl.handleEndpoint("/workflow/decline", { stepId }) as AnyObj;

    assert.equal(r.status, 200, "decline must resolve 200 without the optional callbacks");
    assert.equal(r.response?.ok, true, "decline must resolve ok without the optional callbacks");
  });

  it("T-DeclineDraft.4: a THROWING persistence call leaves the gate retryable — no state mutation, no resolved frame/audit, 500; a later successful call completes the decline", () => {
    // Given: markDraftDeclined throws on the first call (SQLITE_BUSY) and succeeds after.
    // When:  the first /workflow/decline runs.
    // Then:  status 500 reason=draft_decline_persist_failed; awaitingApprovalStepId unchanged;
    //        step NOT failed; no workflow-approval-resolved frame; no approval_resolved audit.
    //        A second decline then resolves normally and retires the draft.
    const draftId = randomUUID();
    let throwOnce = true;
    const retired: string[] = [];
    const { ctrl, frames, audits } = makeCtrl({
      findDraftForDeclinedStep: () => ({ id: draftId }),
      markDraftDeclined: (id) => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("SQLITE_BUSY: database is locked");
        }
        retired.push(id);
      },
    });
    const stepId = driveLiveOrder(ctrl, draftId, randomUUID());

    const first = ctrl.handleEndpoint("/workflow/decline", { stepId }) as AnyObj;

    assert.equal(first.status, 500, "throwing persistence must yield 500");
    assert.equal(first.response?.reason, "draft_decline_persist_failed", "reason must name the failure");
    assert.equal(ctrl.getState().awaitingApprovalStepId, stepId, "gate must STAY pending (retryable)");
    const step = ctrl.getState().current?.steps.find((s) => s.id === stepId);
    assert.equal(step?.state, "in_progress", "step must NOT be failed after the aborted decline");
    assert.equal(
      frames.some((f) => f.type === "workflow-approval-resolved"),
      false,
      "no approval-resolved frame may be emitted on the aborted decline",
    );
    assert.equal(
      audits.some((e) => e.kind === "approval_resolved"),
      false,
      "no approval_resolved audit event may be written on the aborted decline",
    );

    const second = ctrl.handleEndpoint("/workflow/decline", { stepId }) as AnyObj;

    assert.equal(second.response?.ok, true, "retry must succeed once persistence is healthy");
    assert.deepEqual(retired, [draftId], "the successful retry must retire the resolved draft");
    assert.equal(ctrl.getState().awaitingApprovalStepId, null, "gate cleared after the successful retry");
    assert.equal(
      audits.find((e) => e.kind === "approval_resolved")?.decision,
      "declined",
      "the retry must write the declined audit event",
    );
  });

  it("T-DeclineDraft.5: AMBIGUOUS correlation → DraftLineageAmbiguous commit warning (frame + audit), nothing retired, decline still resolves", () => {
    // Given: the finder reports ambiguity (two plausible pending drafts — r2 critic: never guess).
    // When:  /workflow/decline.
    // Then:  a commit-warning frame with label DraftLineageAmbiguous + the commit_warning audit
    //        event; markDraftDeclined NOT called; the decline itself still resolves (the operator's
    //        workflow decision is not blocked by lineage ambiguity).
    const retired: string[] = [];
    const { ctrl, frames, audits } = makeCtrl({
      findDraftForDeclinedStep: () => ({ ambiguous: true }),
      markDraftDeclined: (id) => {
        retired.push(id);
      },
    });
    const stepId = driveLiveOrder(ctrl, randomUUID(), randomUUID());

    const r = ctrl.handleEndpoint("/workflow/decline", { stepId }) as AnyObj;

    assert.deepEqual(retired, [], "nothing may be retired on ambiguity");
    const warnFrame = frames.find((f) => f.type === "commit-warning" && f.label === "DraftLineageAmbiguous");
    assert.ok(warnFrame, "a DraftLineageAmbiguous commit-warning frame must be emitted");
    const warnAudit = audits.find((e) => e.kind === "commit_warning" && e.detectedLabel === "DraftLineageAmbiguous");
    assert.ok(warnAudit, "a DraftLineageAmbiguous commit_warning audit event must be written");
    assert.equal(r.response?.ok, true, "the decline itself must still resolve");
    assert.equal(
      audits.find((e) => e.kind === "approval_resolved")?.decision,
      "declined",
      "declined resolution recorded",
    );
  });

  it("T-DeclineDraft.6 (composed, real tmp DB): live-order decline retires the REAL sqlite row via semantic correlation; the follow-on bare-connect decline retires nothing (status filter)", async () => {
    // Given: a real tmp sales DB seeded with a lead named 'Wilfred Fixture'; the REAL
    //        save_message_draft tool creates the draft; production-shape wiring
    //        (findDraftForDeclinedStep + markDraftRejected against the same DB).
    // When:  live order → /workflow/decline; then a bare-connect re-plan → second decline.
    // Then:  the actual row transitions draft → rejected on the FIRST decline (whole seam, no
    //        spies); the SECOND decline finds nothing (row no longer status='draft') — no
    //        double-retirement, replaying the live incident end-to-end.
    const tmpPath = makeTmpFile(`decline-composed-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(tmpPath);
    const candidateId = randomUUID();
    const leadId = randomUUID();
    const now = Date.now();
    db.prepare(
      "INSERT INTO raw_candidates (id, person_name, profile_url, source, observed_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      candidateId,
      "Wilfred Fixture",
      `https://www.linkedin.com/in/wf-${candidateId.slice(0, 8)}/`,
      "search",
      now,
      now,
    );
    db.prepare(
      "INSERT INTO leads (id, candidate_id, person_name, profile_url, stage, owner_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      leadId,
      candidateId,
      "Wilfred Fixture",
      `https://www.linkedin.com/in/wf-${candidateId.slice(0, 8)}/`,
      "qualified",
      "manual",
      now,
      now,
    );

    const saveTool = makeSaveMessageDraftTool(tmpPath) as AnyObj;
    const saved = await saveTool.execute(
      { leadId, kind: "connect_note", text: "Composed-seam connect note draft." },
      toolOpts,
    );
    assert.equal(saved.ok, true, `save_message_draft fixture must succeed; got ${JSON.stringify(saved)}`);
    const draftId: string = saved.data.draftId;

    const retiredIds: string[] = [];
    const { ctrl } = makeCtrl({
      findDraftForDeclinedStep: (stepTitle) => findDraftForDeclinedStep(db, stepTitle),
      markDraftDeclined: (id) => {
        retiredIds.push(id);
        markDraftRejected(db, id);
      },
    });
    ctrl.onToolResults(
      [{ toolName: "save_message_draft", result: saved, args: { leadId, kind: "connect_note" } }],
      ctx,
    );
    const gate = ctrl.onToolResults(
      [
        {
          toolName: "todo_write",
          result: {
            ok: true,
            workflowTitle: "Send connect note to Wilfred Fixture",
            steps: [
              { id: "s-save", title: "保存 connect note 草稿", requiresApproval: false, state: "completed" },
              {
                id: "s-send",
                title: "Send connect note to Wilfred Fixture",
                requiresApproval: true,
                state: "in_progress",
              },
            ],
          },
        },
      ],
      ctx,
    );
    assert.equal(gate.abort, true, "the re-plan's approval gate must fire");
    const stepId = ctrl.getState().awaitingApprovalStepId;
    assert.ok(stepId, "a pending approval step must exist");

    const r = ctrl.handleEndpoint("/workflow/decline", { stepId }) as AnyObj;

    assert.equal(r.response?.ok, true, "decline must resolve ok");
    assert.deepEqual(retiredIds, [draftId], "semantic correlation must resolve the REAL draft row");
    const row = db.prepare("SELECT status FROM message_drafts WHERE id = ?").get(draftId) as
      | { status: string }
      | undefined;
    assert.equal(row?.status, "rejected", "the REAL sqlite row must be 'rejected' after the decline");

    // Follow-on (live replay): bare-connect re-plan → second decline retires NOTHING.
    const gate2 = ctrl.onToolResults(
      [
        {
          toolName: "todo_write",
          result: {
            ok: true,
            workflowTitle: "Send bare connect to Wilfred Fixture",
            steps: [
              {
                id: "s-bare",
                title: "Send bare connect (no note) to Wilfred Fixture",
                requiresApproval: true,
                state: "in_progress",
              },
            ],
          },
        },
      ],
      ctx,
    );
    assert.equal(gate2.abort, true, "the bare-connect re-plan's gate must fire");
    const bareStepId = ctrl.getState().awaitingApprovalStepId;
    assert.ok(bareStepId, "a pending approval step must exist for the bare connect");

    ctrl.handleEndpoint("/workflow/decline", { stepId: bareStepId });
    assert.deepEqual(retiredIds, [draftId], "the rejected row is no longer status='draft' — nothing more retired");
  });
});
