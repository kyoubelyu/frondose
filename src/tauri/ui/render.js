import { ICONS, LEAF_SVG, LOGO_MARK } from "./frondoseTokens.js";
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
function clear(el) {
    el.textContent = "";
}
function appendText(doc, parent, tag, className, text) {
    const el = doc.createElement(tag);
    if (className.length > 0)
        el.classList.add(className);
    el.textContent = text;
    parent.appendChild(el);
    return el;
}
export function buildLeafLogo(doc) {
    const svg = doc.createElementNS?.("http://www.w3.org/2000/svg", "svg") ?? doc.createElement("svg");
    svg.setAttribute?.("viewBox", LEAF_SVG.viewBox);
    svg.setAttribute?.("aria-hidden", "true");
    svg.classList.add("leaf-logo");
    for (const pathData of LEAF_SVG.paths) {
        const path = doc.createElementNS?.("http://www.w3.org/2000/svg", "path") ?? doc.createElement("path");
        path.setAttribute?.("d", pathData);
        path.setAttribute?.("fill", "none");
        path.setAttribute?.("stroke", "currentColor");
        path.setAttribute?.("stroke-width", "1.8");
        path.setAttribute?.("stroke-linecap", "round");
        path.setAttribute?.("stroke-linejoin", "round");
        svg.appendChild(path);
    }
    return svg;
}
export function buildIcon(doc, name) {
    const svg = doc.createElementNS?.("http://www.w3.org/2000/svg", "svg") ?? doc.createElement("svg");
    svg.setAttribute?.("viewBox", "0 0 24 24");
    svg.setAttribute?.("aria-hidden", "true");
    svg.classList.add("icon");
    const path = doc.createElementNS?.("http://www.w3.org/2000/svg", "path") ?? doc.createElement("path");
    path.setAttribute?.("d", ICONS[name]);
    path.setAttribute?.("fill", "none");
    path.setAttribute?.("stroke", "currentColor");
    path.setAttribute?.("stroke-width", "2");
    path.setAttribute?.("stroke-linecap", "round");
    path.setAttribute?.("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
}
export function buildSwitcher(manualTab, autoTab, mode) {
    manualTab.classList.toggle("active", mode === "manual");
    autoTab.classList.toggle("active", mode === "auto");
}
export function buildBrandBar(doc, target) {
    clear(target);
    const img = doc.createElement("img");
    img.setAttribute?.("src", LOGO_MARK);
    img.setAttribute?.("alt", "Frondose");
    img.classList.add("brand-logo");
    target.appendChild(img);
    appendText(doc, target, "span", "brand-word", "Frondose");
}
export function buildIwfCard(args) {
    const { doc, workflow } = args;
    args.card.classList.remove("hidden");
    args.title.textContent = workflow.title;
    args.mode.textContent = workflow.approvalMode === "auto" ? "Auto" : "Manual";
    clear(args.steps);
    const progress = computeProgress(workflow.steps);
    const progressRow = doc.createElement("li");
    progressRow.classList.add("workflow-progress-row");
    progressRow.textContent = `${progress.done} / ${progress.total}`;
    args.steps.appendChild(progressRow);
    for (const step of workflow.steps) {
        const item = doc.createElement("li");
        item.classList.add("workflow-step");
        item.classList.add(stepVisualState(step, workflow.pendingStepId, workflow.approvalMode));
        const label = stepChipLabel(step, workflow.pendingStepId, workflow.approvalMode);
        item.textContent = label.length > 0 ? `${label} · ${step.title}` : step.title;
        args.steps.appendChild(item);
    }
    args.notice.textContent = workflow.notice;
    args.notice.classList.toggle("hidden", workflow.notice.length === 0);
    const waiting = workflow.pendingStepId !== null;
    args.approveButton.classList.toggle("hidden", !waiting);
    args.declineButton.classList.toggle("hidden", !waiting);
    args.handoffButton.classList.toggle("hidden", workflow.approvalMode === "auto");
}
export function buildAutoStage(args) {
    const { doc, stage, workflow } = args;
    clear(stage);
    stage.classList.remove("hidden");
    const hero = doc.createElement("section");
    hero.classList.add("auto-hero");
    hero.appendChild(buildLeafLogo(doc));
    appendText(doc, hero, "h2", "auto-title", workflow?.title ?? "Auto is ready");
    appendText(doc, hero, "p", "auto-meta", workflow === null ? "Waiting for the next scheduled run." : "Working through the workflow.");
    stage.appendChild(hero);
    const strip = doc.createElement("ol");
    strip.classList.add("auto-progress-strip");
    const steps = workflow?.steps ?? [];
    for (const step of steps) {
        const segment = doc.createElement("li");
        segment.classList.add(stepVisualState(step, workflow?.pendingStepId ?? null, "auto"));
        segment.textContent = stepChipLabel(step, workflow?.pendingStepId ?? null, "auto") || step.title;
        strip.appendChild(segment);
    }
    stage.appendChild(strip);
    const timeline = doc.createElement("div");
    timeline.classList.add("auto-timeline");
    for (const step of steps) {
        const row = doc.createElement("div");
        row.classList.add("timeline-row");
        row.classList.add(stepVisualState(step, workflow?.pendingStepId ?? null, "auto"));
        appendText(doc, row, "span", "timeline-dot", "");
        appendText(doc, row, "strong", "timeline-title", step.title);
        appendText(doc, row, "code", "timeline-chip", stepChipLabel(step, workflow?.pendingStepId ?? null, "auto"));
        timeline.appendChild(row);
    }
    stage.appendChild(timeline);
}
//# sourceMappingURL=render.js.map