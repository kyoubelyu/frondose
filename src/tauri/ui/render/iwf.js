// P-72 slice 12 — extracted from src/tauri/ui/render.ts L174-277.
// buildSwitcher + Manual iwf-card builder (buildIwfCard) + 4 internal helpers.
// Re-exported by the ./render.js barrel: buildSwitcher, buildIwfCard.
import { clear, div, glyph, span, asEl, GLYPH } from "./dom.js";
import { computeProgress, stepVisualState } from "./progress.js";
// --- switcher (active-tab toggle; tabs live statically in index.html) ---
export function buildSwitcher(manualTab, autoTab, mode) {
    manualTab.classList.toggle("active", mode === "manual");
    autoTab.classList.toggle("active", mode === "auto");
}
// --- Manual: inline-workflow card (iwf-card). Mutates the static skeleton in index.html. ---
function summaryLabel(steps) {
    const approvals = steps.filter((s) => s.requiresApproval === true).length;
    const stepWord = `${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
    if (approvals === 0)
        return stepWord;
    return `${stepWord} · ${approvals} confirmation${approvals === 1 ? "" : "s"} required`;
}
// Collapsed view (design-doc §7.1): completed/current/needs-you shown; the remaining pending steps fold
// into the first pending row labelled "<title> · +N more steps". Expanded shows every step individually.
function visibleStepRows(workflow, expanded) {
    const steps = workflow.steps;
    if (expanded || steps.length <= 5)
        return steps.map((step) => ({ step, moreSuffix: "" }));
    const rows = [];
    const tail = [];
    for (const step of steps) {
        const isPlainPending = step.state === "pending" && step.id !== workflow.pendingStepId;
        if (isPlainPending)
            tail.push(step);
        else
            rows.push({ step, moreSuffix: "" });
    }
    const firstTail = tail[0];
    if (firstTail !== undefined) {
        const extra = tail.length - 1;
        rows.push({ step: firstTail, moreSuffix: extra > 0 ? ` · +${extra} more steps` : "" });
    }
    return rows;
}
function stepDot(doc, visual) {
    const dot = div(doc, `iwf-step-dot ${visual}`);
    if (visual === "success" || visual === "auto-approved") {
        dot.appendChild(glyph(doc, GLYPH.check, "iwf-step-check", 3));
    }
    else if (visual === "current") {
        dot.classList.add("pulse");
        dot.appendChild(div(doc, "iwf-step-dot-inner"));
    }
    return dot;
}
function stepRightLabel(step, workflow) {
    if (step.id === workflow.pendingStepId)
        return "needs you";
    if (step.state === "in_progress")
        return "running";
    if (step.state === "completed" && step.requiresApproval === true && workflow.approvalMode === "auto")
        return "auto-approved";
    if (step.state === "failed")
        return "failed";
    return "";
}
export function buildIwfCard(doc, workflow, expanded) {
    const card = asEl(doc.getElementById("workflow-card"));
    if (card)
        card.classList.remove("hidden");
    const title = doc.getElementById("workflow-title");
    if (title)
        title.textContent = workflow.title;
    const sub = doc.getElementById("workflow-sub");
    if (sub)
        sub.textContent = summaryLabel(workflow.steps);
    const progress = computeProgress(workflow.steps);
    const fill = doc.getElementById("workflow-progress-fill");
    fill?.setAttribute?.("style", `width: ${Math.round(progress.fraction * 100)}%`);
    const progressText = doc.getElementById("workflow-progress-text");
    if (progressText)
        progressText.textContent = `${progress.done} / ${progress.total}`;
    const stepsHost = asEl(doc.getElementById("workflow-steps"));
    if (stepsHost) {
        clear(stepsHost);
        for (const { step, moreSuffix } of visibleStepRows(workflow, expanded)) {
            const visual = stepVisualState(step, workflow.pendingStepId, workflow.approvalMode);
            const row = div(doc, `iwf-step ${visual}`);
            row.appendChild(stepDot(doc, visual));
            const textCls = visual === "idle" || visual === "needs-you" ? "iwf-step-text muted" : "iwf-step-text";
            row.appendChild(div(doc, textCls, `${step.title}${moreSuffix}`));
            const right = stepRightLabel(step, workflow);
            if (right.length > 0)
                row.appendChild(span(doc, `iwf-step-time ${visual}`, right));
            stepsHost.appendChild(row);
        }
    }
    const notice = doc.getElementById("workflow-notice");
    if (notice) {
        notice.textContent = workflow.notice;
        notice.classList.toggle("hidden", workflow.notice.length === 0);
    }
    const waiting = workflow.pendingStepId !== null;
    doc.getElementById("workflow-approve-btn")?.classList.toggle("hidden", !waiting);
    doc.getElementById("workflow-decline-btn")?.classList.toggle("hidden", !waiting);
    doc.getElementById("workflow-handoff-btn")?.classList.toggle("hidden", workflow.approvalMode === "auto");
    const showAll = doc.getElementById("workflow-showall-btn");
    if (showAll) {
        const collapsible = workflow.steps.length > 5;
        showAll.classList.toggle("hidden", !collapsible);
        showAll.textContent = expanded ? "Show fewer steps" : "Show all steps";
    }
}
//# sourceMappingURL=iwf.js.map