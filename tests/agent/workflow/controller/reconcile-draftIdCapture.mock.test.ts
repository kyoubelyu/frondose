/**
 * P-POST-PUBLISH-7 Step 2 — Group C scaffold
 * T-Reconcile.SynthesizeCapture / T-Reconcile.AdvanceCapture / T-Reconcile.IdempotentCapture:
 * step.draftId is captured when save_message_draft runs for the in-progress outbound step.
 *
 * Gate: G-P7.reconcile
 *
 * COMPILE APPROACH: ensureWorkflowForSaveDraft + autoAdvanceOnSaveDraft already exist
 * and are importable. The NEW behavior is that they write step.draftId from
 * tr.result.data.draftId — a field that does NOT exist on TodoStep yet (pre-Step-4).
 * The scaffold calls the real functions and probes (result.current.steps[0] as any).draftId
 * via an explicit cast to avoid tsc errors on the missing field. Tests fail at
 * assert.fail("TODO P7: …") → RED on HEAD.
 *
 * All 3 tests FAIL on HEAD (correct RED). No production-code edits.
 *
 * Runner:
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/workflow/controller/reconcile-draftIdCapture.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ensureWorkflowForSaveDraft,
  autoAdvanceOnSaveDraft,
} from "../../../../src/agent/workflow/controller/reconcile.js";
import type { WorkflowControllerDeps } from "../../../../src/agent/workflow/controller.js";
import type { WorkflowState, Workflow } from "../../../../src/agent/workflow/types.js";
import type { WorkflowReconcileCtx } from "../../../../src/agent/workflow/controller/reconcile.js";
import type { ToolResultLike } from "../../../../src/agent/workflow/controller/types-internal.js";

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

function makeDeps(): WorkflowControllerDeps {
  return {
    emitFrame: () => {},
    writeWorkflowAudit: () => {},
  };
}

function makeCtx(overrides?: Partial<WorkflowReconcileCtx>): WorkflowReconcileCtx {
  return {
    turnId: "turn-p7-reconcile",
    isCronTurn: false,
    resolvedMode: "manual",
    ...overrides,
  };
}

/**
 * Build a ToolResultLike that models a successful save_message_draft result
 * with a draftId in result.data. Mirrors the ok() envelope from linkedin/envelope.ts:
 *   { ok: true, command: "save_message_draft", data: { draftId, leadId, status } }
 */
function makeSaveDraftToolResult(draftId: string, kind = "post", leadId = ""): ToolResultLike {
  return {
    toolName: "save_message_draft",
    args: { kind, leadId },
    result: {
      ok: true,
      command: "save_message_draft",
      data: { draftId, leadId, status: "draft" },
    },
  };
}

/**
 * Build a minimal Workflow with a single requiresApproval in-progress step
 * for use in autoAdvanceOnSaveDraft tests.
 */
function makeWorkflowWithPendingApprovalStep(existingDraftId?: string): Workflow {
  return {
    id: "wf-p7-reconcile",
    title: "Outbound: send post",
    approvalMode: "manual",
    steps: [
      {
        id: "step-p7-reconcile",
        title: "Publish the post draft",
        state: "in_progress",
        requiresApproval: true,
        startedAt: "2026-06-24T00:00:00.000Z",
        // draftId is the new P7 field — cast through unknown to avoid tsc error on missing field
        ...(existingDraftId !== undefined ? ({ draftId: existingDraftId } as unknown as Record<string, unknown>) : {}),
      },
    ],
    state: "active",
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// T-Reconcile.SynthesizeCapture
// ---------------------------------------------------------------------------

describe("ensureWorkflowForSaveDraft — synthesized single-step records step.draftId from result.data.draftId (G-P7.reconcile)", () => {
  it(
    "T-Reconcile.SynthesizeCapture: when state.current is null and save_message_draft result carries data.draftId='d-xyz', the synthesized step has draftId==='d-xyz'",
    { timeout: 5000 },
    () => {
      // Given: no current workflow (state.current = null) AND a save_message_draft
      //        ToolResultLike with result.data.draftId = "d-xyz".
      // When:  ensureWorkflowForSaveDraft(state, deps, ctx, tr) runs.
      // Then:  state.current.steps[0].draftId === "d-xyz" (the P7 reconcile capture).
      const state: WorkflowState = { current: null, awaitingApprovalStepId: null };
      const deps = makeDeps();
      const ctx = makeCtx();
      const tr = makeSaveDraftToolResult("d-xyz", "post");

      ensureWorkflowForSaveDraft(state, deps, ctx, tr);

      assert.ok(state.current !== null, "ensureWorkflowForSaveDraft must create a workflow");
      assert.equal(state.current.steps.length, 1, "synthesized workflow must have exactly 1 step");

      const step = state.current.steps[0] as unknown as Record<string, unknown>;
      // T-Reconcile.SynthesizeCapture: step.draftId must be captured from tr.result.data.draftId
      assert.equal(step["draftId"], "d-xyz", `T-Reconcile.SynthesizeCapture: step.draftId should be 'd-xyz', got ${String(step["draftId"])}`);
    },
  );
});

// ---------------------------------------------------------------------------
// T-Reconcile.AdvanceCapture
// ---------------------------------------------------------------------------

describe("autoAdvanceOnSaveDraft — advance-on-saveDraft records step.draftId for the approval-gated step (G-P7.reconcile)", () => {
  it(
    "T-Reconcile.AdvanceCapture: when a manual workflow has an in-progress requiresApproval step (no draftId), autoAdvanceOnSaveDraft with data.draftId='d-zzz' sets step.draftId==='d-zzz'",
    { timeout: 5000 },
    () => {
      // Given: a manual workflow with an in_progress requiresApproval step (no draftId yet)
      //        AND a save_message_draft result with data.draftId = "d-zzz".
      // When:  autoAdvanceOnSaveDraft(state, approvedStepIds, deps, ctx) runs.
      // Then:  the in-progress step now has draftId === "d-zzz".
      const wf = makeWorkflowWithPendingApprovalStep(/* no existing draftId */);
      const state: WorkflowState = { current: wf, awaitingApprovalStepId: null };
      const approvedStepIds = new Set<string>();
      const deps = makeDeps();
      const ctx = makeCtx();

      // autoAdvanceOnSaveDraft does NOT take a ToolResultLike directly; the P7 change
      // needs the reconcile layer to thread tr through it. The plan §6.3 shows
      // autoAdvanceOnSaveDraft's signature growing a `tr: ToolResultLike` parameter.
      // For the scaffold, we pass an extra arg and test the field capture.
      // If the signature hasn't changed yet, the call still compiles (extra args
      // are ignored at the JS level); the assert.fail fires before any assertion.
      const tr = makeSaveDraftToolResult("d-zzz", "post");

      // Call with the extended signature (tr as 5th arg — P7 addition)
      // Cast to any to suppress tsc error on the missing 5th parameter until Step 4.
      (autoAdvanceOnSaveDraft as (...args: unknown[]) => unknown)(
        state, approvedStepIds, deps, ctx, tr,
      );

      const step = wf.steps[0] as unknown as Record<string, unknown>;
      // T-Reconcile.AdvanceCapture: step.draftId must be captured from tr.result.data.draftId
      assert.equal(step["draftId"], "d-zzz", `T-Reconcile.AdvanceCapture: step.draftId should be 'd-zzz', got ${String(step["draftId"])}`);
    },
  );
});

// ---------------------------------------------------------------------------
// T-Reconcile.IdempotentCapture
// ---------------------------------------------------------------------------

describe("autoAdvanceOnSaveDraft — re-running with the same draftId is a no-op (G-P7.reconcile — idempotency)", () => {
  it(
    "T-Reconcile.IdempotentCapture: when step already has draftId==='d-old' and advance runs with data.draftId==='d-old', step.draftId is unchanged AND no extra workflow audit row is emitted",
    { timeout: 5000 },
    () => {
      // Given: a manual workflow with an in-progress step that already has draftId = "d-old"
      //        AND a save_message_draft result with data.draftId = "d-old" (same id).
      // When:  autoAdvanceOnSaveDraft runs.
      // Then:  step.draftId is still "d-old" AND writeWorkflowAudit is NOT called an extra
      //        time for this idempotent re-capture (no duplicate step_advance event).
      const wf = makeWorkflowWithPendingApprovalStep("d-old");
      const state: WorkflowState = { current: wf, awaitingApprovalStepId: null };
      const approvedStepIds = new Set<string>();
      const auditCalls: unknown[] = [];
      const deps: WorkflowControllerDeps = {
        emitFrame: () => {},
        writeWorkflowAudit: (event) => { auditCalls.push(event); },
      };
      const ctx = makeCtx();
      const tr = makeSaveDraftToolResult("d-old", "post");

      const auditCountBefore = auditCalls.length;

      (autoAdvanceOnSaveDraft as (...args: unknown[]) => unknown)(
        state, approvedStepIds, deps, ctx, tr,
      );

      const step = wf.steps[0] as unknown as Record<string, unknown>;
      // T-Reconcile.IdempotentCapture: captureDraftId guards `if (!step.requiresApproval || step.draftId) return`
      // so an existing draftId must NOT be overwritten
      assert.equal(step["draftId"], "d-old", `T-Reconcile.IdempotentCapture: step.draftId should remain 'd-old', got ${String(step["draftId"])}`);
      // No extra step_advance audit calls from an idempotent run (target step already in_progress,
      // captureDraftId no-ops, autoAdvanceOnSaveDraft finds nothing to advance → returns {abort:false})
      assert.equal(auditCalls.length, auditCountBefore, `T-Reconcile.IdempotentCapture: no extra writeWorkflowAudit calls on idempotent re-run (before=${auditCountBefore}, after=${auditCalls.length})`);
    },
  );
});
