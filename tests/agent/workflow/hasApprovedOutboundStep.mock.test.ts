/**
 * P-63 Step 5 — T-Wf.1..6 (filled)
 * WorkflowController.hasApprovedOutboundStep() accessor unit tests.
 *
 * Assertions filled per plan §5.4 (F-4 locked code sketch) + §6.3.
 *
 * Expected failures at Step 5 due to builder deviation (D-P63-E):
 *   - Missing auto-mode short-circuit: should return true for approvalMode==="auto"
 *   - Checks nonexistent step.type === "outbound" && step.status === "approved" fields
 *     instead of the plan's approvedStepIds.has(inProgress.id) pattern
 *   - Result: T-Wf.2 and T-Wf.4 return false when they should return true
 *
 * Drives the controller via its public interface only (no internals access):
 *   - onToolResults({toolName:"todo_write", result:{...}}, ctx) to propose a workflow
 *   - handleEndpoint("/workflow/approve", {stepId}) to approve a step
 *   - handleEndpoint("/workflow/cancel", null) to cancel
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/agent/workflow/hasApprovedOutboundStep.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkflowController } from "../../../src/agent/workflow/controller.js";
import { createWorkflowController } from "../../../src/agent/workflow/controller.js";

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
    //   Covers G-P63.10 (no-workflow arm)
    const ctrl = createWorkflowController(makeDeps());
    assert.strictEqual(
      ctrl.hasApprovedOutboundStep(),
      false,
      "fresh controller must return false (state.current === null)",
    );
  });

  // ─── T-Wf.2 ─────────────────────────────────────────────────────────────────
  it("T-Wf.2: when workflow is in auto (cron handoff) mode, hasApprovedOutboundStep() returns true regardless of step approval state", () => {
    // Given: a workflow proposed inside a cron turn (isCronTurn:true → approvalMode==="auto")
    // When:  hasApprovedOutboundStep() called (no operator approval action taken)
    // Then:  returns true — every step is pre-approved in auto mode
    //   Covers G-P63.10 (auto-mode arm, plan §5.4 step 3: approvalMode === "auto" → true)
    const ctrl = createWorkflowController(makeDeps());
    proposeAutoWorkflow(ctrl, [{ id: "step_auto_1", title: "Visit profiles", requiresApproval: false }]);

    assert.strictEqual(
      ctrl.hasApprovedOutboundStep(),
      true,
      "auto-mode workflow must return true (every step pre-approved in cron handoff; plan §5.4)",
    );
  });

  // ─── T-Wf.3 ─────────────────────────────────────────────────────────────────
  it("T-Wf.3: when active manual workflow with in_progress step that does NOT require approval, hasApprovedOutboundStep() returns false", () => {
    // Given: manual workflow with steps=[{id:"step_1", title:"Research", requiresApproval:false}]
    //   step_1 is in_progress (first step auto-advances to in_progress)
    // When:  hasApprovedOutboundStep() called
    // Then:  returns false — a non-approval step does not count as outbound-approved
    //   Covers G-P63.10 (manual + no-requiresApproval arm)
    const ctrl = createWorkflowController(makeDeps());
    proposeManualWorkflow(ctrl, [{ id: "step_1", title: "Research the profile", requiresApproval: false }]);

    assert.strictEqual(
      ctrl.hasApprovedOutboundStep(),
      false,
      "manual workflow with non-approval step must return false",
    );
  });

  // ─── T-Wf.4 ─────────────────────────────────────────────────────────────────
  it("T-Wf.4: manual workflow with requiresApproval step — false before approval, true after /workflow/approve", () => {
    // Given: manual workflow with steps=[{id:"step_out", title:"Send invite", requiresApproval:true}]
    //   step_out is in_progress (first step); approval gate pending
    // When:  hasApprovedOutboundStep() called PRE-approval
    // Then:  returns false
    //
    // When:  handleEndpoint("/workflow/approve", {stepId:"step_out"}) called
    // Then:  hasApprovedOutboundStep() returns true
    //   (proves the accessor handles post-approve resume correctly;
    //    the approved step remains in_progress until agent calls todo_write to mark it completed)
    //   Covers G-P63.10 (manual + requiresApproval + approval transition)
    const ctrl = createWorkflowController(makeDeps());
    proposeManualWorkflow(ctrl, [{ id: "step_out", title: "Send invite to Alice", requiresApproval: true }]);

    // Pre-approval: awaitingApprovalStepId = "step_out"; wf.state = "awaiting_approval"
    assert.strictEqual(
      ctrl.hasApprovedOutboundStep(),
      false,
      "requiresApproval step must return false BEFORE operator approval",
    );

    // Approve the step
    const approveResult = ctrl.handleEndpoint("/workflow/approve", { stepId: "step_out" });
    assert.strictEqual((approveResult.response as { ok: boolean }).ok, true, "approve endpoint must succeed");

    // Post-approval: approvedStepIds.has("step_out") = true; step state still in_progress
    assert.strictEqual(
      ctrl.hasApprovedOutboundStep(),
      true,
      "requiresApproval step must return true AFTER operator approval (plan §5.4: approvedStepIds.has(inProgress.id))",
    );
  });

  // ─── T-Wf.5 ─────────────────────────────────────────────────────────────────
  it("T-Wf.5: completed auto workflow → hasApprovedOutboundStep() returns false (BLOCKER-2 guard must close after completion)", () => {
    // Given: auto workflow proposed (isCronTurn:true → approvalMode==="auto")
    //   THEN workflow driven to completion: second onToolResults with same title + step:state:"completed"
    //   → emitCompletionIfNeeded fires → wf.state = "completed"; state.current is still populated
    // When:  hasApprovedOutboundStep() called
    // Then:  returns false — completed state triggers early-return; guard MUST NOT stay open
    //   BLOCKER-2: without this fix, a completed auto workflow would keep the guard permanently open
    //   Covers G-P63.10 (completed auto arm)
    const ctrl = createWorkflowController(makeDeps());
    proposeAutoWorkflow(ctrl, [{ id: "auto_step_1", title: "Profile visit", requiresApproval: false }]);

    // Drive to completion: same title + same step + state:"completed"
    ctrl.onToolResults(
      [
        {
          toolName: "todo_write",
          result: {
            ok: true,
            workflowTitle: "Auto Run Workflow",
            steps: [{ id: "auto_step_1", title: "Profile visit", requiresApproval: false, state: "completed" }],
          },
        },
      ],
      { turnId: "turn-auto-2", isCronTurn: true },
    );

    assert.strictEqual(
      ctrl.hasApprovedOutboundStep(),
      false,
      "BLOCKER-2: completed workflow must return false (guard must close; plan §5.4 state=completed early-return)",
    );
  });

  // ─── T-Wf.6 ─────────────────────────────────────────────────────────────────
  it("T-Wf.6: cancelled manual workflow → hasApprovedOutboundStep() returns false (BLOCKER-2 inverse — cancellation closes guard)", () => {
    // Given: manual workflow with requiresApproval step proposed + approved
    //   (accessor returns true at this point — T-Wf.4 proves this)
    //   THEN handleEndpoint("/workflow/cancel", null) called
    //   → wf.state = "cancelled" AND state.current = null (cancel nulls state.current)
    // When:  hasApprovedOutboundStep() called post-cancel
    // Then:  returns false via the state.current === null arm
    //   Covers G-P63.10 (BLOCKER-2 — cancellation closes the guard; defence-in-depth)
    const ctrl = createWorkflowController(makeDeps());
    proposeManualWorkflow(ctrl, [{ id: "step_out", title: "Send invite to Bob", requiresApproval: true }]);
    // Approve (so the guard would be open if not cancelled)
    ctrl.handleEndpoint("/workflow/approve", { stepId: "step_out" });

    // Cancel
    const cancelResult = ctrl.handleEndpoint("/workflow/cancel", null);
    assert.strictEqual((cancelResult.response as { ok: boolean }).ok, true, "cancel endpoint must succeed");

    assert.strictEqual(
      ctrl.hasApprovedOutboundStep(),
      false,
      "BLOCKER-2: cancelled workflow must return false (cancel nulls state.current → null arm fires)",
    );
  });
});
