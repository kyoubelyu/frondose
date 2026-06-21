import type { WorkflowControllerDeps } from "../controller.js";
import type { Workflow, WorkflowState } from "../types.js";
import type { WorkflowReconcileCtx } from "./reconcile.js";

export function checkApprovalGate(
  state: WorkflowState,
  approvedStepIds: Set<string>,
  deps: WorkflowControllerDeps,
  wf: Workflow,
  ctx: WorkflowReconcileCtx,
): { abort: boolean } {
  if (ctx.isCronTurn || wf.approvalMode !== "manual" || state.awaitingApprovalStepId !== null) return { abort: false };
  const gateStep = wf.steps.find((s) => s.state === "in_progress" && s.requiresApproval && !approvedStepIds.has(s.id));
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

export function approve(
  state: WorkflowState,
  approvedStepIds: Set<string>,
  deps: WorkflowControllerDeps,
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
    step.requiresApproval && /(send|connect|invite|message|dm|note|comment|post|follow)/i.test(step.title);
  const isConnectStep = /(connect|invite|add a note|邀请|添加好友|连接|follow)/i.test(step.title);
  const isMessageStep = isOutboundStep && !isConnectStep && /(message|reply|dm|消息|回复)/i.test(step.title);
  const connectExtra =
    ` THIS STEP IS THE OUTBOUND ACTION. Do NOT navigate, do NOT search, do NOT re-qualify, do NOT save another draft. ` +
    `Your VERY FIRST tool call MUST be \`inspect\` on the current page (no \`navigate_to_url\`). ` +
    `Then locate a button whose label matches one of these EXACT terms (case-insensitive): ` +
    `"Connect", "Invite to connect", "Invite \${name} to connect", "Send invite", "Send now", "Send without a note", ` +
    `"Add a note", "邀请", "添加好友", "发送邀请", "直接发送", "连接", "立即连接", "Follow". ` +
    `\`click\` that button by its \`ref\` directly (not by label, to avoid ambiguous-target errors). ` +
    `If the dialog asks "Add a note", click "Add a note" — DO NOT click "Send without a note" unless the operator explicitly declined to send a note. ` +
    `Then \`type\` the draft text into the note textarea and \`click\` "Send invite". ` +
    `Immediately after the outbound click, call \`mark_message_sent(draftId)\` AND \`update_lead_stage(leadId, "connect_sent")\` to close the loop.`;
  const messageExtra =
    ` THIS STEP IS THE OUTBOUND MESSAGE REPLY. Do NOT navigate, search, re-qualify, or save another draft. ` +
    `Your VERY FIRST tool call MUST be \`inspect\` on the current messaging thread (scope \`threadInput\` or \`messagingConversation\`), NOT navigate_to_url. ` +
    `This is a DIRECT MESSAGE, not a connection invite; there is NO note-dialog step and NO Connect/Invite button. ` +
    `Ensure the approved reply text is already in the message composer ("Write a message…" textbox); if it is NOT, \`type\` the approved draft text there first. ` +
    `Then \`click\` the thread's "Send" button (label "Send" / "发送") by its \`ref\` directly (not by label, to avoid ambiguous-target). ` +
    `Immediately after the send, call \`mark_message_sent(draftId)\` to record it. Do NOT call \`update_lead_stage\` for a connection-request stage; this was a message reply, not a connection request.`;
  const outboundExtra = isMessageStep ? messageExtra : isOutboundStep ? connectExtra : "";
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

export function decline(
  state: WorkflowState,
  deps: WorkflowControllerDeps,
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

export function hasApprovedOutboundStep(state: WorkflowState, approvedStepIds: Set<string>): boolean {
  if (!state.current) return false;
  if (state.current.state === "completed" || state.current.state === "cancelled") return false;
  // P-AUTO-1+2 (B-2): an auto workflow pre-approves outbound ONLY when operator-handed-off.
  // A stale cron-created auto workflow (handoff unset) must NOT authorize here — its outbound
  // is gated by the running auto-run (isAutoOutboundAuthorized), not the workflow approval state.
  if (state.current.approvalMode === "auto" && state.current.handoff === true) return true;
  const inProgress = state.current.steps.find((s) => s.state === "in_progress");
  if (!inProgress || !inProgress.requiresApproval) return false;
  return approvedStepIds.has(inProgress.id);
}
