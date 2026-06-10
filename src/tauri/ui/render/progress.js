// P-72 slice 12 — extracted from src/tauri/ui/render.ts L78-106.
// Pure render-data helpers — DOM-free, side-effect-free.
// Re-exported by the ./render.js barrel.
export function computeProgress(stepsOrDone, totalArg) {
    const done = Array.isArray(stepsOrDone)
        ? stepsOrDone.filter((step) => step.state === "completed").length
        : Math.max(0, stepsOrDone);
    const total = Array.isArray(stepsOrDone) ? stepsOrDone.length : Math.max(0, totalArg ?? 0);
    return { done, total, fraction: total === 0 ? 0 : done / total };
}
export function stepChipLabel(step, pendingStepId = null, mode = "manual") {
    if (step.id === pendingStepId)
        return "needs you";
    if (step.state === "in_progress")
        return "working";
    if (step.state === "completed" && step.requiresApproval === true && mode === "auto")
        return "auto-approved";
    if (step.state === "completed")
        return "done";
    if (step.state === "failed")
        return "failed";
    return "";
}
export function stepVisualState(step, pendingStepId = null, mode = "manual") {
    if (step.id === pendingStepId)
        return "needs-you";
    if (step.state === "in_progress")
        return "current";
    if (step.state === "completed" && step.requiresApproval === true && mode === "auto")
        return "auto-approved";
    if (step.state === "completed")
        return "success";
    if (step.state === "failed")
        return "failed";
    return "idle";
}
//# sourceMappingURL=progress.js.map