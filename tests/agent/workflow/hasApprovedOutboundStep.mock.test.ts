/**
 * P-63 scaffold — T-Wf.1..6
 * WorkflowController.hasApprovedOutboundStep() accessor unit tests.
 *
 * Step 4a: assertion bodies are TODO stubs — ALL FAIL pre-builder.
 * Step 5:  builder adds hasApprovedOutboundStep() to controller.ts → assertions filled.
 *
 * Drives the controller via its public interface:
 *  - onToolResults({toolName:"todo_write", result:{...}}, ctx) to propose a workflow
 *  - handleEndpoint("/workflow/approve", {stepId}) to approve a step
 *  - handleEndpoint("/workflow/cancel", null) to cancel
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/agent/workflow/hasApprovedOutboundStep.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkflowController } from "../../../src/agent/workflow/controller.js";
import type { WorkflowController } from "../../../src/agent/workflow/controller.js";

/** Minimal no-op deps for createWorkflowController. */
function makeDeps() {
  return {
    emitFrame: () => {},
    writeWorkflowAudit: () => {},
  };
}

/** Propose a manual workflow with the given steps via onToolResults. */
function proposeManualWorkflow(
  ctrl: WorkflowController,
  steps: Array<{ id: string; title: string; requiresApproval: boolean; state?: string }>,
  title = "Test Outreach Workflow",
): { abort: boolean } {
  return ctrl.onToolResults(
    [
      {
        toolName: "todo_write",
        result: {
          ok: true,
          workflowTitle: title,
          steps,
        },
      },
    ],
    { turnId: "turn-1", isCronTurn: false },
  );
}

/** Propose an auto (cron) workflow with the given steps via onToolResults. */
function proposeAutoWorkflow(
  ctrl: WorkflowController,
  steps: Array<{ id: string; title: string; requiresApproval: boolean; state?: string }>,
  title = "Auto Run Workflow",
): { abort: boolean } {
  return ctrl.onToolResults(
    [
      {
        toolName: "todo_write",
        result: {
          ok: true,
          workflowTitle: title,
          steps,
        },
      },
    ],
    { turnId: "turn-auto", isCronTurn: true },
  );
}

describe("T-Wf — WorkflowController.hasApprovedOutboundStep() (P-63)", () => {
  // ─── T-Wf.1 ─────────────────────────────────────────────────────────────────
  it("T-Wf.1: when no workflow has been started, hasApprovedOutboundStep() returns false", () => {
    // Given: a freshly-created controller (no todo_write call yet)
    // When:  hasApprovedOutboundStep() is called
    // Then:  returns false (state.current === null)
    assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
  });

  // ─── T-Wf.2 ─────────────────────────────────────────────────────────────────
  it("T-Wf.2: when workflow is in auto (cron handoff) mode, hasApprovedOutboundStep() returns true regardless of step approval state", () => {
    // Given: a workflow proposed inside a cron turn (isCronTurn:true → approvalMode==="auto")
    // When:  hasApprovedOutboundStep() called (no operator approval action taken)
    // Then:  returns true — every step is pre-approved in auto mode
    assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
  });

  // ─── T-Wf.3 ─────────────────────────────────────────────────────────────────
  it("T-Wf.3: when active manual workflow with in_progress step that does NOT require approval, hasApprovedOutboundStep() returns false", () => {
    // Given: manual workflow with steps=[{id:"step_1", title:"Research", requiresApproval:false}]
    //   step_1 is in_progress (first step auto-advances to in_progress)
    // When:  hasApprovedOutboundStep() called
    // Then:  returns false — a non-approval step does not count as outbound-approved
    assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
  });

  // ─── T-Wf.4 ─────────────────────────────────────────────────────────────────
  it("T-Wf.4: manual workflow with requiresApproval step — false before approval, true after /workflow/approve", () => {
    // Given: manual workflow with steps=[{id:"step_out", title:"Send invite", requiresApproval:true}]
    //   step_out is in_progress (first step); awaitingApprovalStepId = "step_out" (approval gate)
    // When:  hasApprovedOutboundStep() called PRE-approval
    // Then:  returns false
    //
    // When:  handleEndpoint("/workflow/approve", {stepId:"step_out"}) called
    // Then:  hasApprovedOutboundStep() returns true
    //   (proves the accessor handles post-approve correctly;
    //    the approved step remains in_progress until agent calls todo_write to mark it completed)
    assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
  });

  // ─── T-Wf.5 ─────────────────────────────────────────────────────────────────
  it("T-Wf.5: completed auto workflow → hasApprovedOutboundStep() returns false (BLOCKER-2 guard must close after completion)", () => {
    // Given: auto workflow proposed (isCronTurn:true → approvalMode==="auto")
    //   THEN workflow driven to completion: onToolResults called with todo_write
    //   result whose every step is state:"completed" → emitCompletionIfNeeded fires
    //   → wf.state = "completed"; state.current is still populated (cancel is the only path that nulls it)
    // When:  hasApprovedOutboundStep() called
    // Then:  returns false — completed state triggers early-return; guard MUST NOT stay open
    //   (BLOCKER-2: without this fix, a completed auto workflow would keep the guard permanently open)
    assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
  });

  // ─── T-Wf.6 ─────────────────────────────────────────────────────────────────
  it("T-Wf.6: cancelled manual workflow → hasApprovedOutboundStep() returns false (BLOCKER-2 inverse — cancellation closes guard)", () => {
    // Given: manual workflow with an approved in_progress outbound step
    //   (accessor would return true at this point)
    //   THEN handleEndpoint("/workflow/cancel", null) called
    //   → wf.state = "cancelled" AND state.current = null (cancel path nulls state.current)
    // When:  hasApprovedOutboundStep() called post-cancel
    // Then:  returns false via the state.current === null arm
    //   (proves cancellation closes the guard; exercises defence-in-depth for BLOCKER-2)
    assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
  });
});
