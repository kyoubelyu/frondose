interface WorkflowStepView {
  id: string;
  title: string;
  requiresApproval: boolean;
  state: "pending" | "in_progress" | "completed" | "failed";
}
interface WorkflowView {
  steps: WorkflowStepView[];
}
type WorkflowStepState = "pending" | "in_progress" | "completed" | "failed";

export function upsertWorkflowStep(
  view: WorkflowView,
  stepId: string,
  title: string,
  state: WorkflowStepState,
  requiresApproval: boolean,
): void {
  const existing = view.steps.find((step) => step.id === stepId);
  if (existing) {
    existing.title = title;
    existing.state = state;
    existing.requiresApproval = existing.requiresApproval || requiresApproval;
    return;
  }
  view.steps.push({ id: stepId, title, state, requiresApproval });
}
