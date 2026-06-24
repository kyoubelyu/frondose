import type { WorkflowControllerDeps } from "../controller.js";
import { emitCommitWarning } from "../runtime/commitWarning.js";
import type { WorkflowState } from "../types.js";
import { clickLabel, isSaveDraftSuccess, isTodoWriteResult } from "./helpers.js";
import {
  autoAdvanceOnSaveDraft,
  ensureWorkflowForSaveDraft,
  reconcileTodoWrite,
  type WorkflowReconcileCtx,
} from "./reconcile.js";
import type { ToolResultLike } from "./types-internal.js";

export function onToolResults(
  state: WorkflowState,
  approvedStepIds: Set<string>,
  terminalWorkflowIds: Set<string>,
  deps: WorkflowControllerDeps,
  toolResults: ToolResultLike[],
  ctx: WorkflowReconcileCtx,
): { abort: boolean } {
  let abort = false;
  // P-AUTO-1+2 (B-1): a turn is "manualMode" for the always-ask telegram/gh path when it is
  // NOT cron AND the resolved mode is NOT Auto. Operator-started Auto turns must take the
  // same auto path as cron — otherwise the always-ask warning fires on an Auto run.
  const manualMode =
    !ctx.isCronTurn && ctx.resolvedMode !== "auto" && (state.current?.approvalMode ?? "manual") === "manual";
  for (const tr of toolResults) {
    if (tr.toolName === "todo_write" && isTodoWriteResult(tr.result)) {
      abort = reconcileTodoWrite(state, approvedStepIds, terminalWorkflowIds, deps, tr.result, ctx).abort || abort;
    }
    if (tr.toolName === "save_message_draft" && isSaveDraftSuccess(tr.result)) {
      ensureWorkflowForSaveDraft(state, deps, ctx, tr); // [D-14] synthesize workflow if agent skipped todo_write
      abort = autoAdvanceOnSaveDraft(state, approvedStepIds, deps, ctx, tr).abort || abort;
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
        emitCommitWarning(deps, { workflowId: state.current?.id ?? null, stepId, label, severity: "low" });
      }
    }
  }
  return { abort };
}
