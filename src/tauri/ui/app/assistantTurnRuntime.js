import { createAssistantTurnController, } from "../assistantTurnController.js";
import { createTurnInterruptionController } from "./turnInterruption.js";
export function createAssistantTurnRuntime(deps) {
    const turn = deps.turnController ??
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
        handleEvent: (frame) => turn.handle(frame),
        pause: interruption.pause,
        stop: interruption.stop,
        steer: interruption.steer,
    };
}
//# sourceMappingURL=assistantTurnRuntime.js.map