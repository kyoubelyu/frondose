import {
  createAssistantTurnController,
  type AssistantPresentationFrame,
  type AssistantPresentationOutcome,
  type AssistantTurnController,
} from "../assistantTurnController.js";
import type { DocumentLike, ElementLike } from "../render.js";
import { createTurnInterruptionController } from "./turnInterruption.js";

export function createAssistantTurnRuntime(deps: {
  document: DocumentLike;
  conversationList: ElementLike;
  getCurrentTurnId: () => string | null;
  requestAnimationFrame: (callback: () => void) => number;
  scrollToBottom: () => void;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  settleOwned: (turnId: string) => void;
  appendStoppedText: (text: string) => void;
  startReplacement: (text: string) => Promise<void>;
  reportFailure: (error: unknown) => void;
  turnController?: AssistantTurnController;
}) {
  const turn =
    deps.turnController ??
    createAssistantTurnController({
      document: deps.document,
      conversationList: deps.conversationList,
      getCurrentTurnId: deps.getCurrentTurnId,
      requestAnimationFrame: deps.requestAnimationFrame,
      scrollToBottom: deps.scrollToBottom,
    });
  const interruption = createTurnInterruptionController(deps);
  return {
    beginTurn: turn.beginTurn,
    handleEvent: (frame: AssistantPresentationFrame): AssistantPresentationOutcome => turn.handle(frame),
    pause: interruption.pause,
    stop: interruption.stop,
    steer: interruption.steer,
  };
}
