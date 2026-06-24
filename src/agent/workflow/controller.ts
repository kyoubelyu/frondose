import { hasApprovedOutboundStep as hasApprovedOutboundStepImpl } from "./controller/approval-gate.js";
import type { WorkflowEndpointResult } from "./controller/endpoints.js";
import { handleEndpoint as handleEndpointImpl } from "./controller/endpoints.js";
import type { WorkflowReconcileCtx } from "./controller/reconcile.js";
import { onToolResults as onToolResultsImpl } from "./controller/tool-observer.js";
import type { ToolResultLike } from "./controller/types-internal.js";
import type { WorkflowAuditEntry, WorkflowSseFrame, WorkflowState } from "./types.js";

export interface WorkflowControllerDeps {
  emitFrame: (frame: WorkflowSseFrame) => void;
  writeWorkflowAudit: (event: WorkflowAuditEntry["event"]) => void;
}

export interface WorkflowController {
  onToolResults(toolResults: ToolResultLike[], ctx: WorkflowReconcileCtx): { abort: boolean };
  // approve() resumePrompt includes "Do NOT call suggest_card" so approved steps resume into execution.
  handleEndpoint(url: string, body: Record<string, unknown> | null): WorkflowEndpointResult;
  getState(): WorkflowState;
  hasApprovedOutboundStep(): boolean;
}

export function createWorkflowController(deps: WorkflowControllerDeps): WorkflowController {
  const state: WorkflowState = { current: null, awaitingApprovalStepId: null };
  const approvedStepIds = new Set<string>();
  const terminalWorkflowIds = new Set<string>();

  return {
    onToolResults: (toolResults, ctx) =>
      onToolResultsImpl(state, approvedStepIds, terminalWorkflowIds, deps, toolResults, ctx),
    handleEndpoint: (url, body) => handleEndpointImpl(state, approvedStepIds, terminalWorkflowIds, deps, url, body),
    getState: () => state,
    hasApprovedOutboundStep: () => hasApprovedOutboundStepImpl(state, approvedStepIds),
  };
}
