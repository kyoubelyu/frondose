import { randomUUID } from "node:crypto";
import type { TodoStep, Workflow, WorkflowAuditEntry, WorkflowSseFrame, WorkflowState } from "./types.js";

export interface WorkflowControllerDeps {
  emitFrame: (frame: WorkflowSseFrame) => void;
  writeWorkflowAudit: (event: WorkflowAuditEntry["event"]) => void;
}

interface ToolResultLike {
  toolName: string;
  result: unknown;
  args?: unknown;
}

interface TodoWriteResult {
  ok: boolean;
  workflowTitle: string;
  steps: Array<{ id: string; title: string; requiresApproval: boolean; state?: string }>;
}

export interface WorkflowController {
  onToolResults(toolResults: ToolResultLike[], ctx: { turnId: string; isCronTurn: boolean }): { abort: boolean };
  // approve() resumePrompt includes "Do NOT call suggest_card" so approved steps resume into execution.
  handleEndpoint(
    url: string,
    body: Record<string, unknown> | null,
  ): { status: number; response: unknown; resumePrompt?: string };
  getState(): WorkflowState;
  hasApprovedOutboundStep(): boolean;
}

export function createWorkflowController(deps: WorkflowControllerDeps): WorkflowController {
  const state: WorkflowState = { current: null, awaitingApprovalStepId: null };
  const approvedStepIds = new Set<string>();
  const terminalWorkflowIds = new Set<string>();

  function inferStepState(
    steps: Array<{ state?: string }>,
    idx: number,
    explicit: string | undefined,
  ): TodoStep["state"] {
    if (explicit === "pending" || explicit === "in_progress" || explicit === "completed" || explicit === "failed") {
      return explicit;
    }
    const firstActiveIdx = steps.findIndex((s) => s.state !== "completed" && s.state !== "failed");
    if (firstActiveIdx === -1) return "completed";
    if (idx < firstActiveIdx) return "completed";
    if (idx === firstActiveIdx) return "in_progress";
    return "pending";
  }

  function stepFrame(step: TodoStep): {
    id: string;
    title: string;
    requiresApproval: boolean;
    state: TodoStep["state"];
  } {
    return { id: step.id, title: step.title, requiresApproval: step.requiresApproval, state: step.state };
  }

  function emitCompletionIfNeeded(wf: Workflow): void {
    if (!wf.steps.every((s) => s.state === "completed")) return;
    wf.state = "completed";
    if (terminalWorkflowIds.has(wf.id)) return;
    terminalWorkflowIds.add(wf.id);
    deps.emitFrame({ type: "workflow-completed", workflowId: wf.id, finalState: "completed", ts: Date.now() });
    deps.writeWorkflowAudit({ kind: "completed", workflowId: wf.id, finalState: "completed" });
  }

  function checkApprovalGate(wf: Workflow, ctx: { turnId: string; isCronTurn: boolean }): { abort: boolean } {
    if (ctx.isCronTurn || wf.approvalMode !== "manual" || state.awaitingApprovalStepId !== null)
      return { abort: false };
    const gateStep = wf.steps.find(
      (s) => s.state === "in_progress" && s.requiresApproval && !approvedStepIds.has(s.id),
    );
    if (!gateStep) return { abort: false };
    state.awaitingApprovalStepId = gateStep.id;
    wf.state = "awaiting_approval";
    deps.emitFrame({
      type: "workflow-approval-pending",
      turnId: ctx.turnId,
      workflowId: wf.id,
      stepId: gateStep.id,
      stepTitle: gateStep.title,
      ts: Date.now(),
    });
    deps.writeWorkflowAudit({
      kind: "approval_pending",
      workflowId: wf.id,
      stepId: gateStep.id,
      turnIdAborted: ctx.turnId,
    });
    return { abort: true };
  }

  function reconcileTodoWrite(
    result: TodoWriteResult,
    ctx: { turnId: string; isCronTurn: boolean },
  ): { abort: boolean } {
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
    const priorByTitle = isContinuation ? new Map(prior!.steps.map((s) => [s.title, s])) : new Map<string, TodoStep>(); // NEW workflow → fresh step IDs, no title-keyed inheritance
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
        startedAt: nextState !== "pending" ? (priorStep?.startedAt ?? now) : undefined,
        completedAt: nextState === "completed" ? (priorStep?.completedAt ?? now) : undefined,
        failureReason: nextState === "failed" ? priorStep?.failureReason : undefined,
      };
    });
    const wf: Workflow = {
      id: isContinuation ? prior!.id : `wf_${randomUUID()}`,
      title: result.workflowTitle,
      // [P-59 WF-1] a NEW workflow must NOT inherit a prior handoff "auto" mode — that would skip the gate.
      approvalMode: isContinuation ? prior!.approvalMode : ctx.isCronTurn ? "auto" : "manual",
      steps,
      state: "active",
      createdAt: isContinuation ? prior!.createdAt : now,
      updatedAt: now,
    };
    state.current = wf;
    // [P-59 WF-1] a NEW workflow invalidates all prior approvals (approvedStepIds is session-global).
    if (!isContinuation && prior !== null) approvedStepIds.clear();
    if (!isContinuation) {
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
        const prev = prior!.steps.find((p) => p.id === step.id);
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
    const gate = checkApprovalGate(wf, ctx);
    if (!gate.abort) emitCompletionIfNeeded(wf);
    return gate;
  }

  function clickLabel(tr: ToolResultLike): string {
    const direct = pickString(tr.result, ["targetLabel", "label"]);
    if (direct) return direct;
    const data = pickObject(tr.result, "data");
    const fromData = pickString(data, ["targetLabel", "label", "target"]);
    if (fromData) return fromData;
    const ref = pickObject(tr.result, "ref") ?? pickObject(data, "ref");
    return pickString(ref, ["ariaLabel", "controlName", "text"]) ?? pickString(tr.args, ["label", "ref"]) ?? "";
  }

  function onToolResults(
    toolResults: ToolResultLike[],
    ctx: { turnId: string; isCronTurn: boolean },
  ): { abort: boolean } {
    let abort = false;
    const manualMode = !ctx.isCronTurn && (state.current?.approvalMode ?? "manual") === "manual";
    for (const tr of toolResults) {
      if (tr.toolName === "todo_write" && isTodoWriteResult(tr.result)) {
        abort = reconcileTodoWrite(tr.result, ctx).abort || abort;
      }
      if (manualMode && (tr.toolName === "telegram_notify" || tr.toolName === "gh_issue")) {
        const workflowId = state.current?.id ?? null;
        deps.emitFrame({
          type: "workflow-approval-pending",
          turnId: ctx.turnId,
          workflowId: workflowId ?? "",
          stepId: `alwaysask_${tr.toolName}`,
          stepTitle: `outbound: ${tr.toolName} (already sent - review)`,
          ts: Date.now(),
        });
        deps.writeWorkflowAudit({ kind: "always_ask", workflowId, toolName: tr.toolName, turnId: ctx.turnId });
      }
      if (tr.toolName === "click") {
        const label = clickLabel(tr);
        if (/Send|Connect|Post|Comment|Invite/i.test(label)) {
          const stepId = state.current?.steps.find((s) => s.state === "in_progress")?.id;
          deps.emitFrame({
            type: "commit-warning",
            workflowId: state.current?.id ?? null,
            label,
            severity: "low",
            ts: Date.now(),
          });
          deps.writeWorkflowAudit({
            kind: "commit_warning",
            workflowId: state.current?.id ?? null,
            detectedLabel: label,
            stepId,
          });
        }
      }
    }
    return { abort };
  }

  function handleEndpoint(
    url: string,
    body: Record<string, unknown> | null,
  ): { status: number; response: unknown; resumePrompt?: string } {
    const wf = state.current;
    const stepId = typeof body?.stepId === "string" ? body.stepId : null;
    if (url === "/workflow/approve") return approve(wf, stepId);
    if (url === "/workflow/decline")
      return decline(wf, stepId, typeof body?.reason === "string" ? body.reason : undefined);
    if (url === "/workflow/handoff" || url === "/workflow/hand-off-to-auto") return handoff(wf);
    if (url === "/workflow/cancel") return cancel(wf);
    return { status: 404, response: { ok: false, reason: "unknown_workflow_endpoint" } };
  }

  function approve(
    wf: Workflow | null,
    stepId: string | null,
  ): { status: number; response: unknown; resumePrompt?: string } {
    const step = wf?.steps.find((s) => s.id === stepId);
    if (!wf || !step || state.awaitingApprovalStepId !== stepId) {
      return { status: 200, response: { ok: false, reason: "no_pending_approval" } };
    }
    state.awaitingApprovalStepId = null;
    approvedStepIds.add(step.id);
    wf.state = "active";
    deps.emitFrame({
      type: "workflow-approval-resolved",
      workflowId: wf.id,
      stepId: step.id,
      decision: "approved",
      ts: Date.now(),
    });
    deps.writeWorkflowAudit({ kind: "approval_resolved", workflowId: wf.id, stepId: step.id, decision: "approved" });
    return {
      status: 200,
      response: { ok: true },
      resumePrompt:
        `WORKFLOW RESUME (not a new task). ` +
        `Operator approved step "${step.title}" in workflow "${wf.title}". ` +
        `Do not start this resume turn with search_memory or a new todo_write plan — ` +
        `the workflow plan is already declared and active. ` +
        `Continue from the existing in_progress step: perform the approved step "${step.title}" ` +
        `using browser tools now, then update the existing workflow state with todo_write as you progress. ` +
        `Do NOT call suggest_card for this approved step — it is approved for EXECUTION; perform it with browser tools directly.`,
    };
  }

  function decline(
    wf: Workflow | null,
    stepId: string | null,
    reason: string | undefined,
  ): { status: number; response: unknown; resumePrompt?: string } {
    const step = wf?.steps.find((s) => s.id === stepId);
    if (!wf || !step || state.awaitingApprovalStepId !== stepId) {
      return { status: 200, response: { ok: false, reason: "no_pending_approval" } };
    }
    state.awaitingApprovalStepId = null;
    step.state = "failed";
    step.failureReason = "operator_declined";
    wf.state = "active";
    deps.emitFrame({
      type: "workflow-approval-resolved",
      workflowId: wf.id,
      stepId: step.id,
      decision: "declined",
      ts: Date.now(),
    });
    deps.writeWorkflowAudit({
      kind: "approval_resolved",
      workflowId: wf.id,
      stepId: step.id,
      decision: "declined",
      declineReason: reason,
    });
    const suffix = reason ? ` Reason: ${reason}.` : "";
    return {
      status: 200,
      response: { ok: true },
      resumePrompt: `Operator DECLINED to send: "${step.title}".${suffix} Revise the plan or stop. Do not perform that outbound action.`,
    };
  }

  function handoff(wf: Workflow | null): { status: number; response: unknown; resumePrompt?: string } {
    if (!wf) return { status: 200, response: { ok: false, reason: "no_workflow" } };
    wf.approvalMode = "auto";
    wf.state = "active";
    state.awaitingApprovalStepId = null;
    deps.emitFrame({ type: "workflow-mode-changed", workflowId: wf.id, approvalMode: "auto", ts: Date.now() });
    return {
      status: 200,
      response: { ok: true },
      resumePrompt:
        "Operator handed off to Auto mode. Remaining steps are pre-approved; continue without approval pauses.",
    };
  }

  function cancel(wf: Workflow | null): { status: number; response: unknown } {
    if (!wf) return { status: 200, response: { ok: false, reason: "no_workflow" } };
    wf.state = "cancelled";
    state.awaitingApprovalStepId = null;
    deps.emitFrame({ type: "workflow-completed", workflowId: wf.id, finalState: "cancelled", ts: Date.now() });
    deps.writeWorkflowAudit({ kind: "completed", workflowId: wf.id, finalState: "cancelled" });
    terminalWorkflowIds.add(wf.id);
    state.current = null;
    return { status: 200, response: { ok: true } };
  }

  function hasApprovedOutboundStep(): boolean {
    if (!state.current) return false;
    if (state.current.state === "completed" || state.current.state === "cancelled") return false;
    if (state.current.approvalMode === "auto") return true;
    const inProgress = state.current.steps.find((s) => s.state === "in_progress");
    if (!inProgress || !inProgress.requiresApproval) return false;
    return approvedStepIds.has(inProgress.id);
  }

  return { onToolResults, handleEndpoint, getState: () => state, hasApprovedOutboundStep };
}

function isTodoWriteResult(result: unknown): result is TodoWriteResult {
  if (!result || typeof result !== "object") return false;
  const r = result as { ok?: unknown; workflowTitle?: unknown; steps?: unknown };
  return r.ok === true && typeof r.workflowTitle === "string" && Array.isArray(r.steps);
}

function pickObject(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : null;
}

function pickString(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return null;
}
