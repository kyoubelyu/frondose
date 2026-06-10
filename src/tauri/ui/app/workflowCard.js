import { buildAutoStage, buildIwfCard } from "../render.js";
export function renderWorkflowCard(snap, deps) {
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
//# sourceMappingURL=workflowCard.js.map