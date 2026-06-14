import type { WorkflowControllerDeps } from "../controller.js";
import type { Workflow, WorkflowState } from "../types.js";
import { approve, decline } from "./approval-gate.js";

export function handleEndpoint(state: WorkflowState, approvedStepIds: Set<string>, terminalWorkflowIds: Set<string>, deps: WorkflowControllerDeps, url: string, body: Record<string, unknown> | null): { status: number; response: unknown; resumePrompt?: string } {
  const wf = state.current;
  const stepId = typeof body?.stepId === "string" ? body.stepId : null;
  if (url === "/workflow/approve") return approve(state, approvedStepIds, deps, wf, stepId);
  if (url === "/workflow/decline")
    return decline(state, deps, wf, stepId, typeof body?.reason === "string" ? body.reason : undefined);
  if (url === "/workflow/handoff" || url === "/workflow/hand-off-to-auto") return handoff(state, deps, wf);
  if (url === "/workflow/cancel") return cancel(state, terminalWorkflowIds, deps, wf);
  return { status: 404, response: { ok: false, reason: "unknown_workflow_endpoint" } };
}

export function handoff(state: WorkflowState, deps: WorkflowControllerDeps, wf: Workflow | null): { status: number; response: unknown; resumePrompt?: string } {
  if (!wf) return { status: 200, response: { ok: false, reason: "no_workflow" } };
  wf.approvalMode = "auto";
  wf.handoff = true;
  wf.state = "active";
  state.awaitingApprovalStepId = null;
  deps.emitFrame({ type: "workflow-mode-changed", workflowId: wf.id, approvalMode: "auto", ts: Date.now() });
  return {
    status: 200,
    response: { ok: true },
    resumePrompt:
      "Operator handed off to Auto mode. Remaining steps are pre-approved; continue without approval pauses.",
  };
}

export function cancel(state: WorkflowState, terminalWorkflowIds: Set<string>, deps: WorkflowControllerDeps, wf: Workflow | null): { status: number; response: unknown } {
  if (!wf) return { status: 200, response: { ok: false, reason: "no_workflow" } };
  wf.state = "cancelled";
  state.awaitingApprovalStepId = null;
  deps.emitFrame({ type: "workflow-completed", workflowId: wf.id, finalState: "cancelled", ts: Date.now() });
  deps.writeWorkflowAudit({ kind: "completed", workflowId: wf.id, finalState: "cancelled" });
  terminalWorkflowIds.add(wf.id);
  state.current = null;
  return { status: 200, response: { ok: true } };
}
