import type { WorkflowControllerDeps } from "../controller.js";
import type { WorkflowState } from "../types.js";
import { clickLabel, isSaveDraftSuccess, isTodoWriteResult } from "./helpers.js";
import { autoAdvanceOnSaveDraft, ensureWorkflowForSaveDraft, reconcileTodoWrite } from "./reconcile.js";
import type { ToolResultLike } from "./types-internal.js";

export function onToolResults(state: WorkflowState, approvedStepIds: Set<string>, terminalWorkflowIds: Set<string>, deps: WorkflowControllerDeps, toolResults: ToolResultLike[], ctx: { turnId: string; isCronTurn: boolean }): { abort: boolean } {
  let abort = false;
  const manualMode = !ctx.isCronTurn && (state.current?.approvalMode ?? "manual") === "manual";
  for (const tr of toolResults) {
    if (tr.toolName === "todo_write" && isTodoWriteResult(tr.result)) {
      abort = reconcileTodoWrite(state, approvedStepIds, terminalWorkflowIds, deps, tr.result, ctx).abort || abort;
    }
    if (tr.toolName === "save_message_draft" && isSaveDraftSuccess(tr.result)) {
      ensureWorkflowForSaveDraft(state, deps, ctx, tr); // [D-14] synthesize workflow if agent skipped todo_write
      abort = autoAdvanceOnSaveDraft(state, approvedStepIds, deps, ctx).abort || abort;
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
