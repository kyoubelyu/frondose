/**
 * Phase 14 (P-72 slice 1) — Workflow controller characterization fixtures.
 *
 * Purpose: pin the CURRENT public-API behavior of createWorkflowController so
 * any future refactor (in pursuit of P-72 optimization slices) preserves the
 * contract observable from outside the module.
 *
 * Pure characterization — no behavior change, no bug claim, no scaffold. These
 * tests are GREEN today and must stay GREEN after refactors. If a refactor
 * intentionally changes external behavior, the test author must update the
 * expected value here with a comment naming the deliberate change.
 *
 * Coverage:
 * - isContinuation external observable (workflow.id preservation across todo_write calls)
 * - handleEndpoint URL dispatch (approve/decline/handoff/cancel/unknown)
 * - approvedStepIds lifecycle on new-workflow / continuation / cancel
 * - hasApprovedOutboundStep state-machine
 * - Frame + audit emission shape
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit \
 *     tests/agent/workflow/controller-characterization.mock.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkflowController } from "../../../src/agent/workflow/controller.js";
import type { WorkflowAuditEntry, WorkflowSseFrame } from "../../../src/agent/workflow/types.js";

interface ToolResultLike {
  toolName: string;
  result: unknown;
  args?: unknown;
}

const CTX = { turnId: "t1", isCronTurn: false };

function makeController() {
  const frames: WorkflowSseFrame[] = [];
  const audits: WorkflowAuditEntry["event"][] = [];
  const ctrl = createWorkflowController({
    emitFrame: (f) => frames.push(f),
    writeWorkflowAudit: (e) => audits.push(e),
  });
  return { ctrl, frames, audits };
}

/** Build a synthetic todo_write tool-result that the controller will accept. */
function tw(
  workflowTitle: string,
  steps: Array<{ title: string; requiresApproval?: boolean; state?: string }>,
): ToolResultLike {
  return {
    toolName: "todo_write",
    args: { workflowTitle, steps },
    result: {
      ok: true,
      workflowTitle,
      steps: steps.map((s, i) => ({
        id: `step_${workflowTitle.toLowerCase().replace(/\s+/g, "_")}_${i + 1}`,
        title: s.title,
        requiresApproval: s.requiresApproval ?? false,
        state: s.state ?? (i === 0 ? "in_progress" : "pending"),
      })),
    },
  };
}

describe("workflow controller characterization (Phase 14 / P-72 slice 1)", () => {
  describe("isContinuation observable (workflow.id preservation)", () => {
    // Given: a fresh controller + todo_write "Plan A" with [A,B]
    // When:  the SAME todo_write arrives again (identical title + identical ordered steps)
    // Then:  controller treats it as a continuation — workflow.id preserved
    it("title-match + identical step set + non-terminal → continuation (id preserved)", () => {
      const { ctrl } = makeController();
      ctrl.onToolResults([tw("Plan A", [{ title: "A" }, { title: "B" }])], CTX);
      const id1 = ctrl.getState().current?.id;
      ctrl.onToolResults([tw("Plan A", [{ title: "A" }, { title: "B" }])], CTX);
      const id2 = ctrl.getState().current?.id;
      assert.strictEqual(id2, id1, "workflow id must be preserved when continuation");
    });

    // Given: todo_write "Plan A" with [A,B]
    // When:  a second todo_write extends the plan to [A,B,C] (prefix match)
    // Then:  STILL a continuation per the "same-step-prefix" rule (controller.ts:106-111)
    //        — id preserved + step ids of A and B preserved.
    it("title-match + new step appended (prefix match) → continuation (id preserved)", () => {
      const { ctrl } = makeController();
      ctrl.onToolResults([tw("Plan A", [{ title: "A" }, { title: "B" }])], CTX);
      const id1 = ctrl.getState().current?.id;
      const stepBId1 = ctrl.getState().current?.steps[1].id;
      ctrl.onToolResults([tw("Plan A", [{ title: "A" }, { title: "B" }, { title: "C" }])], CTX);
      const id2 = ctrl.getState().current?.id;
      const stepBId2 = ctrl.getState().current?.steps[1].id;
      assert.strictEqual(id2, id1, "appending a step keeps the workflow id (prefix match)");
      assert.strictEqual(stepBId2, stepBId1, "existing step ids are preserved");
    });

    // Given: todo_write "Plan A" with [A,B]
    // When:  a second todo_write has DIFFERENT first step [Z,A,B] (NOT a prefix of new)
    // Then:  NEW workflow — id changes
    it("title-match but step reorder breaks prefix → new workflow (id changes)", () => {
      const { ctrl } = makeController();
      ctrl.onToolResults([tw("Plan A", [{ title: "A" }, { title: "B" }])], CTX);
      const id1 = ctrl.getState().current?.id;
      ctrl.onToolResults([tw("Plan A", [{ title: "Z" }, { title: "A" }, { title: "B" }])], CTX);
      const id2 = ctrl.getState().current?.id;
      assert.notStrictEqual(id2, id1, "non-prefix step change must trigger new workflow");
    });

    // Given: todo_write "Plan A"
    // When:  a second todo_write has DIFFERENT title "Plan B"
    // Then:  NEW workflow — title is a primary keying signal
    it("title-mismatch → new workflow (id changes)", () => {
      const { ctrl } = makeController();
      ctrl.onToolResults([tw("Plan A", [{ title: "A" }])], CTX);
      const id1 = ctrl.getState().current?.id;
      ctrl.onToolResults([tw("Plan B", [{ title: "A" }])], CTX);
      const id2 = ctrl.getState().current?.id;
      assert.notStrictEqual(id2, id1, "different title must trigger new workflow");
    });

    // Given: workflow A with approved step
    // When:  a NEW workflow B (different title) lands
    // Then:  approvedStepIds is CLEARED — prior approval doesn't carry over
    //        (hasApprovedOutboundStep returns false until a fresh approval on B)
    it("new workflow CLEARS approvedStepIds (no cross-workflow approval leakage)", () => {
      const { ctrl } = makeController();
      ctrl.onToolResults(
        [tw("Plan A", [{ title: "Send outbound", requiresApproval: true, state: "in_progress" }])],
        CTX,
      );
      const wf1 = ctrl.getState().current;
      const approveResult = ctrl.handleEndpoint("/workflow/approve", { stepId: wf1?.steps[0].id });
      assert.strictEqual(approveResult.status, 200, "approve must succeed");
      assert.strictEqual(ctrl.hasApprovedOutboundStep(), true, "approved-outbound true post-approval");
      ctrl.onToolResults(
        [tw("Plan B", [{ title: "Send outbound", requiresApproval: true, state: "in_progress" }])],
        CTX,
      );
      assert.strictEqual(
        ctrl.hasApprovedOutboundStep(),
        false,
        "new workflow must require fresh approval — prior approval cleared",
      );
    });
  });

  describe("handleEndpoint URL dispatch", () => {
    // Given: an active workflow with one pending requiresApproval step
    // When:  POST /workflow/approve with that stepId
    // Then:  returns status 200 + resumePrompt is a non-empty string
    it("/workflow/approve → 200 + non-empty resumePrompt", () => {
      const { ctrl } = makeController();
      ctrl.onToolResults(
        [tw("Outreach", [{ title: "Send connect", requiresApproval: true, state: "in_progress" }])],
        CTX,
      );
      const wf = ctrl.getState().current;
      const r = ctrl.handleEndpoint("/workflow/approve", { stepId: wf?.steps[0].id });
      assert.strictEqual(r.status, 200);
      assert.ok(typeof r.resumePrompt === "string" && r.resumePrompt.length > 0);
    });

    // Given: active workflow with pending step
    // When:  POST /workflow/decline with stepId + reason
    // Then:  returns 200; subsequent hasApprovedOutboundStep() is false
    it("/workflow/decline → 200 + closes approval window", () => {
      const { ctrl } = makeController();
      ctrl.onToolResults(
        [tw("Outreach", [{ title: "Send connect", requiresApproval: true, state: "in_progress" }])],
        CTX,
      );
      const wf = ctrl.getState().current;
      const r = ctrl.handleEndpoint("/workflow/decline", { stepId: wf?.steps[0].id, reason: "not now" });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(ctrl.hasApprovedOutboundStep(), false);
    });

    // Given: active manual workflow
    // When:  POST /workflow/handoff
    // Then:  workflow.approvalMode flips to "auto"
    it("/workflow/handoff → workflow approvalMode becomes 'auto'", () => {
      const { ctrl } = makeController();
      ctrl.onToolResults(
        [tw("Outreach", [{ title: "Send connect", requiresApproval: true, state: "in_progress" }])],
        CTX,
      );
      ctrl.handleEndpoint("/workflow/handoff", null);
      assert.strictEqual(ctrl.getState().current?.approvalMode, "auto");
    });

    // Given: active workflow
    // When:  POST /workflow/cancel
    // Then:  approval window is closed
    it("/workflow/cancel → closes approval window", () => {
      const { ctrl } = makeController();
      ctrl.onToolResults(
        [tw("Outreach", [{ title: "Send connect", requiresApproval: true, state: "in_progress" }])],
        CTX,
      );
      ctrl.handleEndpoint("/workflow/cancel", null);
      assert.strictEqual(ctrl.hasApprovedOutboundStep(), false);
    });

    // Given: any state
    // When:  POST to an unknown endpoint
    // Then:  404 + {ok:false, reason:'unknown_workflow_endpoint'}
    it("unknown URL → 404 + reason:'unknown_workflow_endpoint'", () => {
      const { ctrl } = makeController();
      const r = ctrl.handleEndpoint("/workflow/bogus", null);
      assert.strictEqual(r.status, 404);
      const body = r.response as { ok: boolean; reason: string };
      assert.strictEqual(body.ok, false);
      assert.strictEqual(body.reason, "unknown_workflow_endpoint");
    });
  });

  describe("hasApprovedOutboundStep state machine", () => {
    it("no workflow → false", () => {
      const { ctrl } = makeController();
      assert.strictEqual(ctrl.hasApprovedOutboundStep(), false);
    });

    it("active workflow whose in-progress step is NOT requiresApproval → false", () => {
      const { ctrl } = makeController();
      ctrl.onToolResults(
        [tw("Plan", [{ title: "Search", requiresApproval: false, state: "in_progress" }])],
        CTX,
      );
      assert.strictEqual(ctrl.hasApprovedOutboundStep(), false);
    });

    it("manual workflow with requiresApproval in_progress BEFORE approval → false", () => {
      const { ctrl } = makeController();
      ctrl.onToolResults(
        [tw("Plan", [{ title: "Outbound", requiresApproval: true, state: "in_progress" }])],
        CTX,
      );
      assert.strictEqual(ctrl.hasApprovedOutboundStep(), false);
    });

    it("manual workflow AFTER /workflow/approve → true", () => {
      const { ctrl } = makeController();
      ctrl.onToolResults(
        [tw("Plan", [{ title: "Outbound", requiresApproval: true, state: "in_progress" }])],
        CTX,
      );
      const wf = ctrl.getState().current;
      ctrl.handleEndpoint("/workflow/approve", { stepId: wf?.steps[0].id });
      assert.strictEqual(ctrl.hasApprovedOutboundStep(), true);
    });

    it("/workflow/handoff opens the gate without explicit step approval", () => {
      const { ctrl } = makeController();
      ctrl.onToolResults(
        [tw("Plan", [{ title: "Outbound", requiresApproval: true, state: "in_progress" }])],
        CTX,
      );
      ctrl.handleEndpoint("/workflow/handoff", null);
      assert.strictEqual(ctrl.hasApprovedOutboundStep(), true);
    });
  });

  describe("event emission shape", () => {
    // Given: a fresh controller
    // When:  a todo_write lands proposing a new workflow
    // Then:  a 'workflow-proposed' SSE frame fires AND a 'proposed' audit event is written
    it("new workflow emits 'workflow-proposed' frame + 'proposed' audit event", () => {
      const { ctrl, frames, audits } = makeController();
      ctrl.onToolResults(
        [tw("Outreach", [{ title: "Send", requiresApproval: true, state: "in_progress" }])],
        CTX,
      );
      const proposed = frames.find((f) => f.type === "workflow-proposed");
      assert.ok(proposed, "workflow-proposed frame must be emitted");
      const auditProposed = audits.find((a) => a.kind === "proposed");
      assert.ok(auditProposed, "audit 'proposed' event must be emitted");
    });

    // Given: an active workflow with a pending requiresApproval step
    // When:  POST /workflow/approve
    // Then:  a 'workflow-approval-resolved' SSE frame fires AND
    //        an 'approval_resolved' audit with decision:'approved' is written
    it("approval emits 'workflow-approval-resolved' frame + audit", () => {
      const { ctrl, frames, audits } = makeController();
      ctrl.onToolResults(
        [tw("Outreach", [{ title: "Send", requiresApproval: true, state: "in_progress" }])],
        CTX,
      );
      const wf = ctrl.getState().current;
      ctrl.handleEndpoint("/workflow/approve", { stepId: wf?.steps[0].id });
      const resolved = frames.find((f) => f.type === "workflow-approval-resolved");
      assert.ok(resolved, "workflow-approval-resolved frame must be emitted");
      const auditResolved = audits.find(
        (a) => a.kind === "approval_resolved" && (a as { decision?: string }).decision === "approved",
      );
      assert.ok(auditResolved, "audit 'approval_resolved' with decision:'approved' must be emitted");
    });
  });
});
