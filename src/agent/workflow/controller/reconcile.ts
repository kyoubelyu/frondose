import { randomUUID } from "node:crypto";
import type { WorkflowControllerDeps } from "../controller.js";
import type { TodoStep, Workflow, WorkflowState } from "../types.js";
import { checkApprovalGate } from "./approval-gate.js";
import { inferStepState, stepFrame } from "./helpers.js";
import type { TodoWriteResult, ToolResultLike } from "./types-internal.js";
// biome-ignore format: file LoC budget per controller-split-shape ≤ 250
export type WorkflowReconcileCtx = { turnId: string; isCronTurn: boolean; resolvedMode?: "manual" | "magical" | "auto" };
// biome-ignore format: file LoC budget per controller-split-shape ≤ 250
export function emitCompletionIfNeeded(terminalWorkflowIds: Set<string>, deps: WorkflowControllerDeps, wf: Workflow): void {
  if (!wf.steps.every((s) => s.state === "completed")) return;
  wf.state = "completed";
  if (terminalWorkflowIds.has(wf.id)) return;
  terminalWorkflowIds.add(wf.id);
  deps.emitFrame({ type: "workflow-completed", workflowId: wf.id, finalState: "completed", ts: Date.now() });
  deps.writeWorkflowAudit({ kind: "completed", workflowId: wf.id, finalState: "completed" });
}

// biome-ignore format: file LoC budget per controller-split-shape ≤ 250
export function reconcileTodoWrite(state: WorkflowState, approvedStepIds: Set<string>, terminalWorkflowIds: Set<string>, deps: WorkflowControllerDeps, result: TodoWriteResult, ctx: WorkflowReconcileCtx): { abort: boolean } {
  const now = new Date().toISOString();
  const prior = state.current;
  // [P-59 WF-1 / 5a] A todo_write is a CONTINUATION of the current workflow ONLY when it is the SAME,
  // still-active workflow AND the prior ordered step set remains a prefix of the new plan. This preserves
  // step ids when the same workflow grows (A,B → A,B,C), but fails closed for a changed/reordered first
  // step, which must become a NEW workflow → fresh ids, cleared approvals, and a new approval gate.
  const sameStepPrefix =
    prior !== null &&
    result.steps.length >= prior.steps.length &&
    prior.steps.every((s, i) => s.title === result.steps[i]?.title);
  const isContinuation =
    prior !== null && prior.title === result.workflowTitle && !terminalWorkflowIds.has(prior.id) && sameStepPrefix;
  const continuationPrior = (() => {
    if (!isContinuation) return null;
    if (prior === null) throw new Error("Workflow continuation invariant violated: prior workflow missing");
    return prior;
  })();
  const priorByTitle =
    continuationPrior === null
      ? new Map<string, TodoStep>() // NEW workflow → fresh step IDs, no title-keyed inheritance
      : new Map(continuationPrior.steps.map((s) => [s.title, s]));
  const STEP_RANK = { pending: 0, in_progress: 1, completed: 2 } as const;
  const steps = result.steps.map((s, idx): TodoStep => {
    const priorStep = priorByTitle.get(s.title);
    let nextState = inferStepState(result.steps, idx, s.state);
    if (priorStep !== undefined && priorStep.state !== "failed" && nextState !== "failed") {
      const regresses = STEP_RANK[nextState] < STEP_RANK[priorStep.state];
      const unApproves = nextState === "pending" && approvedStepIds.has(priorStep.id);
      if (regresses || unApproves) nextState = priorStep.state;
    }
    return {
      id: priorStep?.id ?? s.id,
      title: s.title,
      requiresApproval: s.requiresApproval,
      state: nextState,
      draftId: priorStep?.draftId,
      startedAt: nextState !== "pending" ? (priorStep?.startedAt ?? now) : undefined,
      completedAt: nextState === "completed" ? (priorStep?.completedAt ?? now) : undefined,
      failureReason: nextState === "failed" ? priorStep?.failureReason : undefined,
    };
  });
  const wf: Workflow = {
    id: continuationPrior === null ? `wf_${randomUUID()}` : continuationPrior.id,
    title: result.workflowTitle,
    // biome-ignore format: file LoC budget per controller-split-shape ≤ 250
    approvalMode: continuationPrior === null ? (ctx.isCronTurn || ctx.resolvedMode === "auto" ? "auto" : "manual") : continuationPrior.approvalMode,
    steps,
    state: "active",
    createdAt: continuationPrior === null ? now : continuationPrior.createdAt,
    updatedAt: now,
  };
  state.current = wf;
  // [P-59 WF-1] a NEW workflow invalidates all prior approvals (approvedStepIds is session-global).
  // [P-75 D-10] EXCEPT when the new workflow is a same-title re-plan during an unresolved
  // outbound — DeepSeek-v4-flash often re-plans during resume turns instead of continuing
  // the existing plan, breaking the approval lineage. Carry approvals forward by title:
  // any new step whose title was a previously-approved step's title stays approved, and any
  // new step whose prior counterpart was completed stays completed. Truly-new requiresApproval
  // steps still gate.
  if (continuationPrior === null && prior !== null) {
    const sameTitle = prior.title === result.workflowTitle && !terminalWorkflowIds.has(prior.id);
    if (sameTitle) {
      const priorApprovedTitles = new Set(prior.steps.filter((s) => approvedStepIds.has(s.id)).map((s) => s.title));
      const priorCompletedTitles = new Set(prior.steps.filter((s) => s.state === "completed").map((s) => s.title));
      approvedStepIds.clear();
      for (const newStep of wf.steps) {
        if (priorApprovedTitles.has(newStep.title)) {
          approvedStepIds.add(newStep.id);
        }
        if (priorCompletedTitles.has(newStep.title) && newStep.state === "pending") {
          newStep.state = "completed";
          if (!newStep.completedAt) newStep.completedAt = now;
        }
      }
    } else {
      approvedStepIds.clear();
    }
  }
  if (continuationPrior === null) {
    deps.emitFrame({
      type: "workflow-proposed",
      turnId: ctx.turnId,
      workflowId: wf.id,
      title: wf.title,
      approvalMode: wf.approvalMode,
      steps: wf.steps.map(stepFrame),
      ts: Date.now(),
    });
    deps.writeWorkflowAudit({
      kind: "proposed",
      workflowId: wf.id,
      title: wf.title,
      approvalMode: wf.approvalMode,
      stepCount: wf.steps.length,
    });
  } else {
    for (const step of wf.steps) {
      const prev = continuationPrior.steps.find((p) => p.id === step.id);
      if (!prev || prev.state === step.state) continue;
      deps.emitFrame({
        type: "workflow-step-advanced",
        turnId: ctx.turnId,
        workflowId: wf.id,
        stepId: step.id,
        prevState: prev.state,
        nextState: step.state,
        ts: Date.now(),
      });
      deps.writeWorkflowAudit({
        kind: "step_advance",
        workflowId: wf.id,
        stepId: step.id,
        prevState: prev.state,
        nextState: step.state,
      });
    }
  }
  const gate = checkApprovalGate(state, approvedStepIds, deps, wf, ctx);
  if (!gate.abort) emitCompletionIfNeeded(terminalWorkflowIds, deps, wf);
  return gate;
}

// [P-75 D-9 + D-14] Auto-advance workflow on save_message_draft so the approval gate engages
// even if the model (a) fails to re-call todo_write between actions [D-9] OR
// (b) skips todo_write entirely and goes straight to save_message_draft without
// ever proposing a workflow plan [D-14]. In case (b) we synthesize a minimal
// single-step workflow "Send the saved draft" with requiresApproval=true so the
// operator can still approve and the gate plumbing works end-to-end.
// biome-ignore format: file LoC budget per controller-split-shape ≤ 250 (signature kept one-line)
export function ensureWorkflowForSaveDraft(state: WorkflowState, deps: WorkflowControllerDeps, ctx: WorkflowReconcileCtx, tr: ToolResultLike): void {
  if (state.current !== null || ctx.isCronTurn) return;
  const args = (tr.args as { leadId?: string; kind?: string } | null | undefined) ?? {};
  const kind = typeof args.kind === "string" ? args.kind : "outbound";
  const leadId = typeof args.leadId === "string" ? args.leadId : "";
  const nowIso = new Date().toISOString();
  // biome-ignore format: file LoC budget per controller-split-shape <= 250
  const step: TodoStep = { id: `step_${randomUUID()}`, title: `Send the saved ${kind} draft${leadId ? ` (lead ${leadId.slice(0, 8)})` : ""}`, requiresApproval: true, state: ctx.resolvedMode === "auto" ? "in_progress" : "pending", startedAt: nowIso };
  captureDraftId(step, tr);
  const wf: Workflow = {
    id: `wf_${randomUUID()}`,
    title: `Outbound: send ${kind}`,
    approvalMode: "manual",
    steps: [step],
    state: "active",
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  state.current = wf;
  deps.emitFrame({
    type: "workflow-proposed",
    turnId: ctx.turnId,
    workflowId: wf.id,
    title: wf.title,
    approvalMode: wf.approvalMode,
    steps: wf.steps.map(stepFrame),
    ts: Date.now(),
  });
  deps.writeWorkflowAudit({
    kind: "proposed",
    workflowId: wf.id,
    title: wf.title,
    approvalMode: wf.approvalMode,
    stepCount: 1,
  });
}

// biome-ignore format: file LoC budget per controller-split-shape ≤ 250
export function autoAdvanceOnSaveDraft(state: WorkflowState, approvedStepIds: Set<string>, deps: WorkflowControllerDeps, ctx: WorkflowReconcileCtx, tr?: ToolResultLike): { abort: boolean } {
  const wf = state.current;
  if (!wf || ctx.isCronTurn || wf.approvalMode !== "manual") return { abort: false };
  if (state.awaitingApprovalStepId !== null) return { abort: false };
  const target = wf.steps.find(
    (s) => s.requiresApproval && s.state !== "completed" && s.state !== "failed" && !approvedStepIds.has(s.id),
  );
  if (!target) return { abort: false };
  if (tr) captureDraftId(target, tr);
  const nowIso = new Date().toISOString();
  let advanced = false;
  for (const s of wf.steps) {
    if (s.id === target.id) break;
    if (s.state === "pending" || s.state === "in_progress") {
      const prev = s.state;
      s.state = "completed";
      if (!s.completedAt) s.completedAt = nowIso;
      deps.emitFrame({
        type: "workflow-step-advanced",
        turnId: ctx.turnId,
        workflowId: wf.id,
        stepId: s.id,
        prevState: prev,
        nextState: "completed",
        ts: Date.now(),
      });
      deps.writeWorkflowAudit({
        kind: "step_advance",
        workflowId: wf.id,
        stepId: s.id,
        prevState: prev,
        nextState: "completed",
      });
      advanced = true;
    }
  }
  if (target.state === "pending") {
    target.state = "in_progress";
    if (!target.startedAt) target.startedAt = nowIso;
    deps.emitFrame({
      type: "workflow-step-advanced",
      turnId: ctx.turnId,
      workflowId: wf.id,
      stepId: target.id,
      prevState: "pending",
      nextState: "in_progress",
      ts: Date.now(),
    });
    deps.writeWorkflowAudit({
      kind: "step_advance",
      workflowId: wf.id,
      stepId: target.id,
      prevState: "pending",
      nextState: "in_progress",
    });
    advanced = true;
  }
  if (!advanced) return { abort: false };
  return checkApprovalGate(state, approvedStepIds, deps, wf, ctx);
}
// biome-ignore format: file LoC budget per controller-split-shape <= 250
function captureDraftId(step: TodoStep, tr: ToolResultLike): void { if (!step.requiresApproval || step.draftId) return; const data = tr.result && typeof tr.result === "object" && "data" in tr.result ? (tr.result as { data?: unknown }).data : undefined; const draftId = data && typeof data === "object" && !Array.isArray(data) ? (data as { draftId?: unknown }).draftId : undefined; if (typeof draftId === "string" && draftId.trim().length > 0) step.draftId = draftId; }
