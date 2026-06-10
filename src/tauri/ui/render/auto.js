// P-72 slice 12 — extracted from src/tauri/ui/render.ts L281-401.
// Auto execution stage: buildHero + buildProgressStrip + buildTimeline + buildAutoStage.
// Re-exported by the ./render.js barrel: buildAutoStage.
import { div, glyph, span, asEl, clear, GLYPH } from "./dom.js";
import { computeProgress, stepChipLabel, stepVisualState } from "./progress.js";
function buildHero(doc, workflow) {
    const hero = div(doc, "hero");
    const iconWrap = div(doc, "hero-icon-wrap");
    const icon = div(doc, "hero-icon");
    icon.appendChild(glyph(doc, GLYPH.bolt, "hero-icon-glyph", 1.6));
    iconWrap.appendChild(icon);
    iconWrap.appendChild(div(doc, "hero-icon-ring"));
    hero.appendChild(iconWrap);
    const text = div(doc, "hero-text");
    text.appendChild(div(doc, "hero-title", workflow?.title ?? "Auto is ready"));
    const meta = div(doc, "hero-sub");
    if (workflow === null) {
        meta.appendChild(span(doc, "", "Waiting for the next scheduled run"));
    }
    else {
        meta.appendChild(span(doc, "", "Running in Chrome"));
        meta.appendChild(div(doc, "hero-sub-dot"));
        meta.appendChild(span(doc, "", "linkedin.com"));
    }
    text.appendChild(meta);
    hero.appendChild(text);
    const actions = div(doc, "hero-actions");
    const pause = doc.createElement("button");
    pause.setAttribute?.("type", "button");
    pause.setAttribute?.("id", "auto-pause-btn");
    pause.classList.add("hero-btn");
    pause.appendChild(glyph(doc, GLYPH.pause, "hero-btn-glyph", 2));
    pause.appendChild(span(doc, "", "Pause"));
    actions.appendChild(pause);
    const takeover = doc.createElement("button");
    takeover.setAttribute?.("type", "button");
    takeover.setAttribute?.("id", "auto-takeover-btn");
    takeover.classList.add("hero-btn");
    takeover.classList.add("hero-btn-stop");
    takeover.appendChild(glyph(doc, GLYPH.handStop, "hero-btn-glyph", 2));
    takeover.appendChild(span(doc, "", "Take over"));
    actions.appendChild(takeover);
    hero.appendChild(actions);
    return hero;
}
function buildProgressStrip(doc, workflow) {
    const strip = div(doc, "progress-strip");
    const row = div(doc, "ps-row");
    const left = div(doc, "ps-left");
    left.appendChild(div(doc, "ps-step-label", "Now"));
    const current = workflow?.steps.find((s) => s.state === "in_progress") ?? null;
    const cur = div(doc, "ps-current", current?.title ?? (workflow === null ? "Idle" : "Preparing"));
    left.appendChild(cur);
    row.appendChild(left);
    const progress = computeProgress(workflow?.steps ?? []);
    row.appendChild(span(doc, "ps-elapsed", `${progress.done} / ${progress.total}`));
    strip.appendChild(row);
    const bar = div(doc, "ps-bar-wrap");
    const steps = workflow?.steps ?? [];
    const segCount = steps.length > 0 ? steps.length : 7;
    for (let i = 0; i < segCount; i++) {
        const step = steps[i];
        const visual = step ? stepVisualState(step, workflow?.pendingStepId ?? null, "auto") : "idle";
        const segState = visual === "success" || visual === "auto-approved" ? "done" : visual === "current" ? "current" : "";
        bar.appendChild(div(doc, `ps-seg ${segState}`.trim()));
    }
    strip.appendChild(bar);
    return strip;
}
function buildTimeline(doc, workflow) {
    const timeline = div(doc, "timeline");
    const steps = workflow?.steps ?? [];
    if (steps.length === 0) {
        timeline.appendChild(div(doc, "timeline-empty", "Steps will appear here as the workflow runs."));
        return timeline;
    }
    steps.forEach((step, idx) => {
        const visual = stepVisualState(step, workflow?.pendingStepId ?? null, "auto");
        const last = idx === steps.length - 1;
        const stepEl = div(doc, "tlA-step");
        const rail = div(doc, "tlA-rail");
        const dot = div(doc, `tlA-dot ${visual}`);
        if (visual === "success" || visual === "auto-approved")
            dot.appendChild(glyph(doc, GLYPH.check, "tlA-check", 3));
        else if (visual === "current")
            dot.appendChild(div(doc, "tlA-dot-inner"));
        rail.appendChild(dot);
        if (!last) {
            const lineState = visual === "success" || visual === "auto-approved" ? "done" : visual === "current" ? "current" : "";
            rail.appendChild(div(doc, `tlA-line ${lineState}`.trim()));
        }
        stepEl.appendChild(rail);
        const body = div(doc, "tlA-body");
        const titleCls = visual === "idle" ? "tlA-title muted" : visual === "success" || visual === "auto-approved" ? "tlA-title done" : "tlA-title";
        const titleEl = div(doc, titleCls);
        titleEl.appendChild(span(doc, "tlA-title-text", step.title));
        const chip = stepChipLabel(step, workflow?.pendingStepId ?? null, "auto");
        if (chip.length > 0) {
            const chipCls = chip === "done" ? "tlA-chip tlA-chip-success" : "tlA-chip";
            titleEl.appendChild(span(doc, chipCls, chip));
        }
        body.appendChild(titleEl);
        stepEl.appendChild(body);
        timeline.appendChild(stepEl);
    });
    return timeline;
}
export function buildAutoStage(doc, workflow, opts) {
    const stage = asEl(doc.getElementById("auto-stage"));
    if (!stage)
        return;
    clear(stage);
    stage.classList.remove("hidden");
    stage.appendChild(buildHero(doc, workflow));
    stage.appendChild(buildProgressStrip(doc, workflow));
    if (opts?.compact !== true)
        stage.appendChild(buildTimeline(doc, workflow)); // desktop default unchanged
}
//# sourceMappingURL=auto.js.map