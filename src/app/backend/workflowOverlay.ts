// P-Y2.2b — F7 live workflow drive. PURE mapper (Workflow snapshot + the triggering frame → render.ts
// WorkflowLike) + the thin overlay push. The notice strings are the VERBATIM mirror of the desktop
// reducer (src/tauri/ui/app.ts L509/516/524/536) — duplicated host-side BY DESIGN (OQ-2.2b.2: a shared
// helper would force editing app.ts's reducer, expanding the write-range into the desktop). getState()
// alone can't reproduce the transient notice/pendingStepId (they are per-FRAME on the desktop), so the
// mapper is frame-aware while still pulling the authoritative steps from getState().

import type { WorkflowController } from "../../agent/workflow/controller.js";
import type { WorkflowSseFrame, WorkflowState } from "../../agent/workflow/types.js";
import { callInOverlay } from "../../overlay/inject.js";
import type { WorkflowLike } from "../../tauri/ui/render.js";
import type { ServeDeps, ServeState } from "./context.js";

type OverlayPushDeps = ServeDeps | ServeDeps["session"];

function getSession(deps: OverlayPushDeps): ServeDeps["session"] {
  return "session" in deps ? deps.session : deps;
}

export function toOverlayWorkflowSnapshot(s: WorkflowState, frame: WorkflowSseFrame): WorkflowLike | null {
  if (frame.type === "workflow-completed") return null;
  const wf = s.current;
  if (!wf) return null;
  const steps = wf.steps.map((st) => ({
    id: st.id,
    title: st.title,
    requiresApproval: st.requiresApproval,
    state: st.state,
  }));
  let pendingStepId: string | null = s.awaitingApprovalStepId;
  let notice = "";
  switch (frame.type) {
    case "workflow-approval-pending":
      pendingStepId = frame.stepId;
      notice = "Approval required before outbound action.";
      break;
    case "workflow-approval-resolved":
      pendingStepId = null;
      notice = frame.decision === "approved" ? "Approved. Resuming workflow." : "Declined.";
      break;
    case "workflow-mode-changed":
      pendingStepId = null;
      notice = "Auto mode enabled.";
      break;
    case "commit-warning":
      notice = `Advisory: possible outbound click (${frame.label}).`;
      break;
  }
  return { workflowId: wf.id, title: wf.title, approvalMode: wf.approvalMode, steps, pendingStepId, notice };
}

export function pushWorkflowToOverlay(
  state: ServeState,
  deps: OverlayPushDeps,
  workflow: WorkflowController,
  frame: WorkflowSseFrame,
): void {
  const ctxId = state.overlayContextId;
  const client = getSession(deps).getClient();
  if (ctxId === undefined || !client) return;
  const snapshot = toOverlayWorkflowSnapshot(workflow.getState(), frame);
  const json = JSON.stringify(snapshot);
  void callInOverlay(client.handle, ctxId, `function() { window.__frondoseShowWorkflow(${JSON.stringify(json)}); }`);
}
