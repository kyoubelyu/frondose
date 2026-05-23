// P-Y2.1 — Frondose two-mode DOM builders + pure render-data helpers.
// DOM-lib-free: compiled by BOTH the Tauri-UI build (lib DOM) and the main build (no DOM lib),
// so this module references ONLY the `*Like` structural interfaces below — never HTMLElement/Document.
// Builders use the DOM API (createElement/textContent/appendChild/classList/setAttribute) — never innerHTML.

import type { AppMode } from "./mode.js";

// Inline glyph path-data (24x24, stroke=currentColor). Kept local so frondoseTokens.ts stays the
// pinned single-source-of-truth for the palette/leaf-mark; these are UI-builder glyphs only.
const GLYPH = {
  check: ["M5 12l5 5L20 7"],
  bolt: ["M13 3L4 14h7l-1 7l9-11h-7l1-7z"],
  pause: ["M9 5v14", "M15 5v14"],
  handStop: [
    "M9 11V6a1.5 1.5 0 0 1 3 0v5",
    "M12 11V5a1.5 1.5 0 0 1 3 0v6",
    "M15 11V7a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2.5-4.2a1.5 1.5 0 0 1 2.6-1.5L9 13",
  ],
} as const;

export interface ClassListLike {
  add(token: string): void;
  remove(token: string): void;
  toggle(token: string, force?: boolean): void;
}

export interface TextElementLike {
  classList: ClassListLike;
  textContent: string | null;
  setAttribute?(name: string, value: string): void;
}

export interface ElementLike extends TextElementLike {
  appendChild(child: ElementLike): void;
}

export interface ButtonElementLike extends TextElementLike {
  disabled: boolean;
  addEventListener(type: "click", listener: () => void): void;
}

export interface InputElementLike extends TextElementLike {
  value: string;
  disabled: boolean;
  addEventListener(type: "keydown", listener: (e: { key?: string; preventDefault: () => void }) => void): void;
  addEventListener(type: "input", listener: () => void): void;
}

export interface DocumentLike {
  documentElement: ElementLike;
  body?: ElementLike;
  getElementById(id: string): TextElementLike | null;
  createElement(tagName: string): ElementLike;
  createElementNS?(namespace: string, tagName: string): ElementLike;
}

export type StepState = "pending" | "in_progress" | "completed" | "failed";

export type StepLike = {
  id: string;
  title: string;
  requiresApproval?: boolean;
  state: StepState;
};

export type WorkflowLike = {
  workflowId: string;
  title: string;
  approvalMode: AppMode;
  steps: StepLike[];
  pendingStepId: string | null;
  notice: string;
};

// --- pure render-data helpers (unit-tested: T-Render.1..3 — DO NOT change behavior) ---

export function computeProgress(stepsOrDone: StepLike[] | number, totalArg?: number): {
  done: number;
  total: number;
  fraction: number;
} {
  const done = Array.isArray(stepsOrDone)
    ? stepsOrDone.filter((step) => step.state === "completed").length
    : Math.max(0, stepsOrDone);
  const total = Array.isArray(stepsOrDone) ? stepsOrDone.length : Math.max(0, totalArg ?? 0);
  return { done, total, fraction: total === 0 ? 0 : done / total };
}

export function stepChipLabel(step: StepLike, pendingStepId: string | null = null, mode: AppMode = "manual"): string {
  if (step.id === pendingStepId) return "needs you";
  if (step.state === "in_progress") return "working";
  if (step.state === "completed" && step.requiresApproval === true && mode === "auto") return "auto-approved";
  if (step.state === "completed") return "done";
  if (step.state === "failed") return "failed";
  return "";
}

export function stepVisualState(step: StepLike, pendingStepId: string | null = null, mode: AppMode = "manual"): string {
  if (step.id === pendingStepId) return "needs-you";
  if (step.state === "in_progress") return "current";
  if (step.state === "completed" && step.requiresApproval === true && mode === "auto") return "auto-approved";
  if (step.state === "completed") return "success";
  if (step.state === "failed") return "failed";
  return "idle";
}

// --- small DOM helpers ---

function clear(el: TextElementLike): void {
  el.textContent = "";
}

function asEl(node: TextElementLike | null): ElementLike | null {
  return node as ElementLike | null;
}

function div(doc: DocumentLike, className: string, text?: string): ElementLike {
  const el = doc.createElement("div");
  if (className.length > 0) for (const c of className.split(" ")) el.classList.add(c);
  if (text !== undefined) el.textContent = text;
  return el;
}

function span(doc: DocumentLike, className: string, text: string): ElementLike {
  const el = doc.createElement("span");
  if (className.length > 0) for (const c of className.split(" ")) el.classList.add(c);
  el.textContent = text;
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function glyph(doc: DocumentLike, paths: readonly string[], className: string, strokeWidth = 2): ElementLike {
  const svg = doc.createElementNS?.(SVG_NS, "svg") ?? doc.createElement("svg");
  svg.setAttribute?.("viewBox", "0 0 24 24");
  svg.setAttribute?.("aria-hidden", "true");
  if (className.length > 0) for (const c of className.split(" ")) svg.classList.add(c);
  for (const d of paths) {
    const p = doc.createElementNS?.(SVG_NS, "path") ?? doc.createElement("path");
    p.setAttribute?.("d", d);
    p.setAttribute?.("fill", "none");
    p.setAttribute?.("stroke", "currentColor");
    p.setAttribute?.("stroke-width", String(strokeWidth));
    p.setAttribute?.("stroke-linecap", "round");
    p.setAttribute?.("stroke-linejoin", "round");
    svg.appendChild(p);
  }
  return svg;
}

// --- switcher (active-tab toggle; tabs live statically in index.html) ---

export function buildSwitcher(manualTab: TextElementLike, autoTab: TextElementLike, mode: AppMode): void {
  manualTab.classList.toggle("active", mode === "manual");
  autoTab.classList.toggle("active", mode === "auto");
}

// --- Manual: inline-workflow card (iwf-card). Mutates the static skeleton in index.html. ---

function summaryLabel(steps: StepLike[]): string {
  const approvals = steps.filter((s) => s.requiresApproval === true).length;
  const stepWord = `${steps.length} ${steps.length === 1 ? "step" : "steps"}`;
  if (approvals === 0) return stepWord;
  return `${stepWord} · ${approvals} confirmation${approvals === 1 ? "" : "s"} required`;
}

// Collapsed view (design-doc §7.1): completed/current/needs-you shown; the remaining pending steps fold
// into the first pending row labelled "<title> · +N more steps". Expanded shows every step individually.
function visibleStepRows(
  workflow: WorkflowLike,
  expanded: boolean,
): Array<{ step: StepLike; moreSuffix: string }> {
  const steps = workflow.steps;
  if (expanded || steps.length <= 5) return steps.map((step) => ({ step, moreSuffix: "" }));
  const rows: Array<{ step: StepLike; moreSuffix: string }> = [];
  const tail: StepLike[] = [];
  for (const step of steps) {
    const isPlainPending = step.state === "pending" && step.id !== workflow.pendingStepId;
    if (isPlainPending) tail.push(step);
    else rows.push({ step, moreSuffix: "" });
  }
  const firstTail = tail[0];
  if (firstTail !== undefined) {
    const extra = tail.length - 1;
    rows.push({ step: firstTail, moreSuffix: extra > 0 ? ` · +${extra} more steps` : "" });
  }
  return rows;
}

function stepDot(doc: DocumentLike, visual: string): ElementLike {
  const dot = div(doc, `iwf-step-dot ${visual}`);
  if (visual === "success" || visual === "auto-approved") {
    dot.appendChild(glyph(doc, GLYPH.check, "iwf-step-check", 3));
  } else if (visual === "current") {
    dot.classList.add("pulse");
    dot.appendChild(div(doc, "iwf-step-dot-inner"));
  }
  return dot;
}

function stepRightLabel(step: StepLike, workflow: WorkflowLike): string {
  if (step.id === workflow.pendingStepId) return "needs you";
  if (step.state === "in_progress") return "running";
  if (step.state === "completed" && step.requiresApproval === true && workflow.approvalMode === "auto") return "auto-approved";
  if (step.state === "failed") return "failed";
  return "";
}

export function buildIwfCard(doc: DocumentLike, workflow: WorkflowLike, expanded: boolean): void {
  const card = asEl(doc.getElementById("workflow-card"));
  if (card) card.classList.remove("hidden");

  const title = doc.getElementById("workflow-title");
  if (title) title.textContent = workflow.title;
  const sub = doc.getElementById("workflow-sub");
  if (sub) sub.textContent = summaryLabel(workflow.steps);

  const progress = computeProgress(workflow.steps);
  const fill = doc.getElementById("workflow-progress-fill");
  fill?.setAttribute?.("style", `width: ${Math.round(progress.fraction * 100)}%`);
  const progressText = doc.getElementById("workflow-progress-text");
  if (progressText) progressText.textContent = `${progress.done} / ${progress.total}`;

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
      if (right.length > 0) row.appendChild(span(doc, `iwf-step-time ${visual}`, right));
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

// --- Auto: execution stage (hero + progress-strip + vertical timeline). Rebuilds #auto-stage. ---

function buildHero(doc: DocumentLike, workflow: WorkflowLike | null): ElementLike {
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
  } else {
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

function buildProgressStrip(doc: DocumentLike, workflow: WorkflowLike | null): ElementLike {
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

function buildTimeline(doc: DocumentLike, workflow: WorkflowLike | null): ElementLike {
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
    if (visual === "success" || visual === "auto-approved") dot.appendChild(glyph(doc, GLYPH.check, "tlA-check", 3));
    else if (visual === "current") dot.appendChild(div(doc, "tlA-dot-inner"));
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

export function buildAutoStage(doc: DocumentLike, workflow: WorkflowLike | null): void {
  const stage = asEl(doc.getElementById("auto-stage"));
  if (!stage) return;
  clear(stage);
  stage.classList.remove("hidden");
  stage.appendChild(buildHero(doc, workflow));
  stage.appendChild(buildProgressStrip(doc, workflow));
  stage.appendChild(buildTimeline(doc, workflow));
}
