/**
 * P-Y1 Step 5 — T-Types.1 — FILLED
 * (G-PY1.1)
 *
 * Workflow data model shapes (src/agent/workflow/types.ts).
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 tests/agent/workflow/types-pY1.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TodoStep, Workflow, WorkflowAuditEntry, WorkflowState } from "../../../src/agent/workflow/types.js";

// ─── T-Types.1 — Workflow data model shapes ─────────────────────────────────

describe("workflow/types.ts — TodoStep / Workflow / WorkflowState / WorkflowAuditEntry shapes (G-PY1.1)", () => {
  // Given: the workflow/types.ts module.
  // When:  const-typed literals are constructed for each interface + a WorkflowAuditEntry per kind.
  // Then:  they compile against declared shapes; WorkflowAuditEntry.type === "workflow_event";
  //        the event union covers all 7 kinds.
  it("T-Types.1: given workflow/types.ts, WHEN TodoStep/Workflow/WorkflowState/WorkflowAuditEntry literals are constructed, THEN they compile + WorkflowAuditEntry.type==='workflow_event' + the event union has the 7 kinds (proposed, step_advance, approval_pending, approval_resolved, always_ask, commit_warning, completed)", () => {
    const step: TodoStep = { id: "step_1", title: "Review profile", state: "pending", requiresApproval: false };
    assert.equal(step.state, "pending");

    const wf: Workflow = {
      id: "wf_1",
      title: "Outreach",
      approvalMode: "manual",
      steps: [step],
      state: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    assert.equal(wf.approvalMode, "manual");
    assert.equal(wf.steps.length, 1);

    const wstate: WorkflowState = { current: wf, awaitingApprovalStepId: null };
    assert.equal(wstate.current?.id, "wf_1");
    assert.equal(wstate.awaitingApprovalStepId, null);

    // One literal per event kind — compile-level proof the union has all 7 kinds.
    const events: Array<WorkflowAuditEntry["event"]> = [
      { kind: "proposed", workflowId: "wf_1", title: "T", approvalMode: "manual", stepCount: 1 },
      { kind: "step_advance", workflowId: "wf_1", stepId: "step_1", prevState: "pending", nextState: "in_progress" },
      { kind: "approval_pending", workflowId: "wf_1", stepId: "step_1", turnIdAborted: "t1" },
      { kind: "approval_resolved", workflowId: "wf_1", stepId: "step_1", decision: "approved" },
      { kind: "always_ask", workflowId: "wf_1", toolName: "telegram_notify", turnId: "t1" },
      { kind: "commit_warning", workflowId: "wf_1", detectedLabel: "Send", stepId: "step_1" },
      { kind: "completed", workflowId: "wf_1", finalState: "completed" },
    ];
    const kinds = new Set(events.map((e) => e.kind));
    assert.equal(kinds.size, 7, "event union must have exactly the 7 kinds");
    for (const k of [
      "proposed",
      "step_advance",
      "approval_pending",
      "approval_resolved",
      "always_ask",
      "commit_warning",
      "completed",
    ]) {
      assert.ok(kinds.has(k as WorkflowAuditEntry["event"]["kind"]), `event kind '${k}' must exist`);
    }

    const auditEntry: WorkflowAuditEntry = { ts: new Date().toISOString(), type: "workflow_event", event: events[0] };
    assert.equal(auditEntry.type, "workflow_event", "WorkflowAuditEntry.type discriminator");
  });
});
