import type { PostDraftRecovery } from "../../persistence/sales/drafts.js";
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
  recoverPostDraftId?: () => PostDraftRecovery;
  /** [P-FIX-MARK-SENT-STALE-DRAFT] Retire the declined step's draft (draft → rejected)
   *  so a stale draftId can never be marked sent later. Called by decline() BEFORE any workflow
   *  state mutation; a throw keeps the approval gate pending/retryable. Optional for back-compat. */
  markDraftDeclined?: (draftId: string) => void;
  /** [P-FIX-MARK-SENT-STALE-DRAFT] Server-side semantic correlation for a declined step with NO
   *  captured draftId (the prescribed save→todo_write order drops the in-memory binding): resolve
   *  the pending draft whose lead is named in the step title. Ambiguous → decline() emits a
   *  DraftLineageAmbiguous commit warning and retires nothing. Optional for back-compat. */
  findDraftForDeclinedStep?: (stepTitle: string) => PostDraftRecovery;
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
