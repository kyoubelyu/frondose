import type { AssistantPresentationFrame } from "../assistantTurnController.js";
import { createAssistantAppBindings } from "./assistantAppBindings.js";

type LifecycleFrame = { type: "turn-started"; turnId: string; source: string };
type WorkflowCancelResponse = { ok: true } | { ok: false; reason: string };

export function createAssistantAppComposition(deps: {
  runtime: {
    beginTurn(): void;
    handleEvent(frame: AssistantPresentationFrame): "ignored" | "progress" | "final" | "terminal";
    pause(): Promise<"stopped" | "already_stopped" | "rejected" | "stale">;
    stop(text: string): Promise<"stopped" | "already_stopped" | "rejected" | "stale">;
    steer(text: string): Promise<"stopped" | "already_stopped" | "rejected" | "stale">;
  };
  getCurrentTurnId: () => string | null;
  setCurrentTurnId: (turnId: string | null) => void;
  getWorkflowId: () => string | null;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  onTurnStartedView: (frame: LifecycleFrame) => void;
  onDoneView: (frame: Extract<AssistantPresentationFrame, { type: "done" }>) => void;
  onErrorView: (
    frame: Extract<AssistantPresentationFrame, { type: "error" }>,
    preserveRunning?: boolean,
  ) => void;
  reportFailure: (error: unknown) => void;
}) {
  return createAssistantAppBindings({
    runtime: deps.runtime,
    getCurrentTurnId: deps.getCurrentTurnId,
    cancelWorkflow: async () => {
      const result = await deps.invoke<WorkflowCancelResponse>("frondose_workflow_cancel", {
        workflowId: deps.getWorkflowId() ?? "",
      });
      if (!result.ok) throw result.reason;
    },
    onTurnStarted: (frame) => {
      deps.setCurrentTurnId(frame.turnId);
      deps.onTurnStartedView(frame);
    },
    onDone: (frame) => {
      deps.setCurrentTurnId(null);
      deps.onDoneView(frame);
    },
    onError: (frame, preserveRunning) => {
      if (frame.turnId === deps.getCurrentTurnId()) deps.setCurrentTurnId(null);
      deps.onErrorView(frame, preserveRunning);
    },
    reportFailure: deps.reportFailure,
  });
}
