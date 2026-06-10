export function upsertWorkflowStep(view, stepId, title, state, requiresApproval) {
    const existing = view.steps.find((step) => step.id === stepId);
    if (existing) {
        existing.title = title;
        existing.state = state;
        existing.requiresApproval = existing.requiresApproval || requiresApproval;
        return;
    }
    view.steps.push({ id: stepId, title, state, requiresApproval });
}
//# sourceMappingURL=workflowSteps.js.map