import type { WorkflowControllerDeps } from "../controller.js";

export interface CommitWarningArgs {
  workflowId: string | null;
  stepId: string | undefined;
  label: string;
  severity: "low" | "high";
  dispatchAmbiguous?: boolean;
  accountingError?: string;
}

export function emitCommitWarning(
  deps: Pick<WorkflowControllerDeps, "emitFrame" | "writeWorkflowAudit">,
  args: CommitWarningArgs,
): void {
  deps.emitFrame({
    type: "commit-warning",
    workflowId: args.workflowId,
    label: args.label,
    severity: args.severity,
    ts: Date.now(),
  });
  deps.writeWorkflowAudit({
    kind: "commit_warning",
    workflowId: args.workflowId,
    detectedLabel: args.label,
    stepId: args.stepId,
    ...(args.dispatchAmbiguous ? { dispatchAmbiguous: true } : {}),
    ...(args.accountingError ? { accountingError: args.accountingError } : {}),
  });
}
