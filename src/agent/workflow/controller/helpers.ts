import type { TodoStep } from "../types.js";
import type { TodoWriteResult, ToolResultLike } from "./types-internal.js";

export function inferStepState(steps: Array<{ state?: string }>, idx: number, explicit: string | undefined): TodoStep["state"] {
  if (explicit === "pending" || explicit === "in_progress" || explicit === "completed" || explicit === "failed") {
    return explicit;
  }
  const firstActiveIdx = steps.findIndex((s) => s.state !== "completed" && s.state !== "failed");
  if (firstActiveIdx === -1) return "completed";
  if (idx < firstActiveIdx) return "completed";
  if (idx === firstActiveIdx) return "in_progress";
  return "pending";
}

export function stepFrame(step: TodoStep): { id: string; title: string; requiresApproval: boolean; state: TodoStep["state"] } {
  return { id: step.id, title: step.title, requiresApproval: step.requiresApproval, state: step.state };
}

export function clickLabel(tr: ToolResultLike): string {
  const direct = pickString(tr.result, ["targetLabel", "label"]);
  if (direct) return direct;
  const data = pickObject(tr.result, "data");
  const fromData = pickString(data, ["targetLabel", "label", "target"]);
  if (fromData) return fromData;
  const ref = pickObject(tr.result, "ref") ?? pickObject(data, "ref");
  return pickString(ref, ["ariaLabel", "controlName", "text"]) ?? pickString(tr.args, ["label", "ref"]) ?? "";
}

export function isSaveDraftSuccess(r: unknown): boolean {
  return (
    typeof r === "object" &&
    r !== null &&
    "ok" in r &&
    (r as { ok: unknown }).ok === true &&
    "command" in r &&
    (r as { command: unknown }).command === "save_message_draft"
  );
}

export function isTodoWriteResult(result: unknown): result is TodoWriteResult {
  if (!result || typeof result !== "object") return false;
  const r = result as { ok?: unknown; workflowTitle?: unknown; steps?: unknown };
  return r.ok === true && typeof r.workflowTitle === "string" && Array.isArray(r.steps);
}

export function pickObject(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : null;
}

export function pickString(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return null;
}
