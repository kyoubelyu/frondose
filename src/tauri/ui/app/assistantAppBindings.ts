import type {
  AssistantPresentationFrame,
  AssistantPresentationOutcome,
} from "../assistantTurnController.js";
import { isExplicitStopIntent } from "./runningComposer.js";

type LifecycleFrame = { type: "turn-started"; turnId: string; source: string };
type InterruptOutcome = "stopped" | "already_stopped" | "rejected" | "stale";
type PauseOutcome = InterruptOutcome | "workflow_cancelled" | "workflow_cancel_rejected";
type DispatchOutcome = "empty" | "busy" | "steer" | InterruptOutcome;

interface Runtime {
  beginTurn(): void;
  handleEvent(frame: AssistantPresentationFrame): AssistantPresentationOutcome;
  pause(): Promise<InterruptOutcome>;
  stop(text: string): Promise<InterruptOutcome>;
  steer(text: string): Promise<InterruptOutcome>;
}

export function createAssistantAppBindings(deps: {
  runtime: Runtime;
  getCurrentTurnId: () => string | null;
  cancelWorkflow: () => Promise<void>;
  onTurnStarted: (frame: LifecycleFrame) => void;
  onDone: (frame: Extract<AssistantPresentationFrame, { type: "done" }>) => void;
  onError: (
    frame: Extract<AssistantPresentationFrame, { type: "error" }>,
    preserveRunning: boolean,
  ) => void;
  reportFailure: (error: unknown) => void;
}) {
  let dispatchInFlight = false;

  function handleEvent(frame: unknown): boolean {
    if (typeof frame !== "object" || frame === null || !("type" in frame)) return false;
    const event = frame as { type: string };
    if (event.type === "reasoning") return true;
    if (event.type === "turn-started") {
      const lifecycle = event as LifecycleFrame;
      deps.onTurnStarted(lifecycle);
      deps.runtime.beginTurn();
      return true;
    }
    if (!["assistant-progress", "text", "done", "error"].includes(event.type)) return false;
    const presentation = event as AssistantPresentationFrame;
    const outcome = deps.runtime.handleEvent(presentation);
    if (presentation.type === "done" && outcome === "terminal") deps.onDone(presentation);
    if (presentation.type === "error" && (outcome === "terminal" || presentation.turnId === undefined)) {
      deps.onError(
        presentation,
        presentation.turnId === undefined && deps.getCurrentTurnId() !== null,
      );
    }
    return true;
  }

  async function pause(): Promise<PauseOutcome> {
    if (deps.getCurrentTurnId() !== null) return deps.runtime.pause();
    try {
      await deps.cancelWorkflow();
      return "workflow_cancelled";
    } catch (error) {
      deps.reportFailure(error);
      return "workflow_cancel_rejected";
    }
  }

  async function dispatchRunning(input: string): Promise<DispatchOutcome> {
    const text = input.trim();
    if (text.length === 0) return "empty";
    if (dispatchInFlight) return "busy";
    dispatchInFlight = true;
    try {
      if (isExplicitStopIntent(text)) return await deps.runtime.stop(text);
      await deps.runtime.steer(text);
      return "steer";
    } finally {
      dispatchInFlight = false;
    }
  }

  return { handleEvent, pause, dispatchRunning };
}
