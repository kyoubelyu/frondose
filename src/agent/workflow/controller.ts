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
        startedAt: nextState !== "pending" ? (priorStep?.startedAt ?? now) : undefined,
        completedAt: nextState === "completed" ? (priorStep?.completedAt ?? now) : undefined,
        failureReason: nextState === "failed" ? priorStep?.failureReason : undefined,
      };
    });
    const wf: Workflow = {
      id: continuationPrior === null ? `wf_${randomUUID()}` : continuationPrior.id,
      title: result.workflowTitle,
      // [P-59 WF-1] a NEW workflow must NOT inherit a prior handoff "auto" mode — that would skip the gate.
      approvalMode: continuationPrior === null ? (ctx.isCronTurn ? "auto" : "manual") : continuationPrior.approvalMode,
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
        const priorApprovedTitles = new Set(
          prior.steps.filter((s) => approvedStepIds.has(s.id)).map((s) => s.title),
        );
        const priorCompletedTitles = new Set(
          prior.steps.filter((s) => s.state === "completed").map((s) => s.title),
        );
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

  function isSaveDraftSuccess(r: unknown): boolean {
    return (
      typeof r === "object" &&
      r !== null &&
      "ok" in r &&
      (r as { ok: unknown }).ok === true &&
      "command" in r &&
      (r as { command: unknown }).command === "save_message_draft"
    );
  }

  // [P-75 D-9 + D-14] Auto-advance workflow on save_message_draft so the approval gate engages
  // even if the model (a) fails to re-call todo_write between actions [D-9] OR
  // (b) skips todo_write entirely and goes straight to save_message_draft without
  // ever proposing a workflow plan [D-14]. In case (b) we synthesize a minimal
  // single-step workflow "Send the saved draft" with requiresApproval=true so the
  // operator can still approve and the gate plumbing works end-to-end.
  function ensureWorkflowForSaveDraft(ctx: { turnId: string; isCronTurn: boolean }, tr: ToolResultLike): void {
    if (state.current !== null || ctx.isCronTurn) return;
    const args = (tr.args as { leadId?: string; kind?: string } | null | undefined) ?? {};
    const kind = typeof args.kind === "string" ? args.kind : "outbound";
    const leadId = typeof args.leadId === "string" ? args.leadId : "";
    const nowIso = new Date().toISOString();
    const step: TodoStep = {
      id: `step_${randomUUID()}`,
      title: `Send the saved ${kind} draft${leadId ? ` (lead ${leadId.slice(0, 8)})` : ""}`,
      requiresApproval: true,
      state: "in_progress",
      startedAt: nowIso,
    };
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

  function autoAdvanceOnSaveDraft(ctx: { turnId: string; isCronTurn: boolean }): { abort: boolean } {
    const wf = state.current;
    if (!wf || ctx.isCronTurn || wf.approvalMode !== "manual") return { abort: false };
    if (state.awaitingApprovalStepId !== null) return { abort: false };
    const target = wf.steps.find(
      (s) => s.requiresApproval && s.state !== "completed" && s.state !== "failed" && !approvedStepIds.has(s.id),
    );
    if (!target) return { abort: false };
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
    return checkApprovalGate(wf, ctx);
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
      if (tr.toolName === "save_message_draft" && isSaveDraftSuccess(tr.result)) {
        ensureWorkflowForSaveDraft(ctx, tr); // [D-14] synthesize workflow if agent skipped todo_write
        abort = autoAdvanceOnSaveDraft(ctx).abort || abort;
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
    // [P-75 D-11] Strong resume prompt for outbound execution. The agent's habit is to
    // re-navigate / re-search / explore the page; for an approved outbound step the
    // first browser action should be `inspect` on the CURRENT page then `click` on the
    // outbound button. List the OUTBOUND_LABEL_RE labels explicitly so the model has
    // the targets in front of it instead of guessing from prose.
    const isOutboundStep =
      step.requiresApproval &&
      /(send|connect|invite|message|dm|note|comment|post|follow)/i.test(step.title);
    const outboundExtra = isOutboundStep
      ? ` THIS STEP IS THE OUTBOUND ACTION. Do NOT navigate, do NOT search, do NOT re-qualify, do NOT save another draft. ` +
        `Your VERY FIRST tool call MUST be \`inspect\` on the current page (no \`navigate_to_url\`). ` +
        `Then locate a button whose label matches one of these EXACT terms (case-insensitive): ` +
        `"Connect", "Invite to connect", "Invite \${name} to connect", "Send invite", "Send now", "Send without a note", ` +
        `"Add a note", "邀请", "添加好友", "发送邀请", "直接发送", "连接", "立即连接", "Follow". ` +
        `\`click\` that button by its \`ref\` directly (not by label, to avoid ambiguous-target errors). ` +
        `If the dialog asks "Add a note", click "Add a note" — DO NOT click "Send without a note" unless the operator explicitly declined to send a note. ` +
        `Then \`type\` the draft text into the note textarea and \`click\` "Send invite". ` +
        `Immediately after the outbound click, call \`mark_message_sent(draftId)\` AND \`update_lead_stage(leadId, "connect_sent")\` to close the loop.`
      : "";
    return {
      status: 200,
      response: { ok: true },
      resumePrompt:
        `WORKFLOW RESUME (not a new task). ` +
        `Operator approved step "${step.title}" in workflow "${wf.title}". ` +
        `Do not start this resume turn with search_memory or a new todo_write plan — ` +
        `the workflow plan is already declared and active and those tools are now disabled. ` +
        `Continue from the existing in_progress step: perform the approved step "${step.title}" ` +
        `using browser tools now, then update the existing workflow state with todo_write as you progress. ` +
        `Do NOT call suggest_card for this approved step — it is approved for EXECUTION; perform it with browser tools directly.` +
        outboundExtra,
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
