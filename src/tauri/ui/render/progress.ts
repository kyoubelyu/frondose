// P-72 slice 12 — extracted from src/tauri/ui/render.ts L78-106.
// Pure render-data helpers — DOM-free, side-effect-free.
// Re-exported by the ./render.js barrel.

import type { AppMode } from "../mode.js";
import type { StepLike } from "./types.js";

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
