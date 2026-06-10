import type { AppMode } from "../mode.js";
import { buildAutoStage, buildIwfCard } from "../render.js";
import type { DocumentLike, ElementLike } from "../render.js";

interface WorkflowStepView {
  id: string;
  title: string;
  requiresApproval: boolean;
  state: "pending" | "in_progress" | "completed" | "failed";
}
interface WorkflowView {
  workflowId: string;
  title: string;
  approvalMode: AppMode;
  steps: WorkflowStepView[];
  pendingStepId: string | null;
  notice: string;
}

export interface WorkflowCardSnapshot {
  appMode: AppMode;
  workflowView: WorkflowView | null;
  workflowExpanded: boolean;
}

export interface WorkflowCardDeps {
  document: DocumentLike;
  workflowCardEl: ElementLike;
  autoStageEl: ElementLike;
  bindAutoStageButtons: () => void;
}

export function renderWorkflowCard(snap: WorkflowCardSnapshot, deps: WorkflowCardDeps): void {
  if (snap.appMode === "auto") {
    deps.workflowCardEl.classList.add("hidden");
    buildAutoStage(deps.document, snap.workflowView);
    deps.bindAutoStageButtons();
    return;
  }
  deps.autoStageEl.classList.add("hidden");
  if (snap.workflowView === null) {
    deps.workflowCardEl.classList.add("hidden");
    return;
  }
  buildIwfCard(deps.document, snap.workflowView, snap.workflowExpanded);
}
