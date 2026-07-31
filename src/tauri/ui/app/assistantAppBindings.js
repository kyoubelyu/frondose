import { isExplicitStopIntent } from "./runningComposer.js";
export function createAssistantAppBindings(deps) {
    let dispatchInFlight = false;
    function handleEvent(frame) {
        if (typeof frame !== "object" || frame === null || !("type" in frame))
            return false;
        const event = frame;
        if (event.type === "reasoning")
            return true;
        if (event.type === "turn-started") {
            const lifecycle = event;
            deps.onTurnStarted(lifecycle);
            deps.runtime.beginTurn();
            return true;
        }
        if (!["assistant-progress", "text", "done", "error"].includes(event.type))
            return false;
        const presentation = event;
        const outcome = deps.runtime.handleEvent(presentation);
        if (presentation.type === "done" && outcome === "terminal")
            deps.onDone(presentation);
        if (presentation.type === "error" && (outcome === "terminal" || presentation.turnId === undefined)) {
            deps.onError(presentation, presentation.turnId === undefined && deps.getCurrentTurnId() !== null);
        }
        return true;
    }
    async function pause() {
        if (deps.getCurrentTurnId() !== null)
            return deps.runtime.pause();
        try {
            await deps.cancelWorkflow();
            return "workflow_cancelled";
        }
        catch (error) {
            deps.reportFailure(error);
            return "workflow_cancel_rejected";
        }
    }
    async function dispatchRunning(input) {
        const text = input.trim();
        if (text.length === 0)
            return "empty";
        if (dispatchInFlight)
            return "busy";
        dispatchInFlight = true;
        try {
            if (isExplicitStopIntent(text))
                return await deps.runtime.stop(text);
            await deps.runtime.steer(text);
            return "steer";
        }
        finally {
            dispatchInFlight = false;
        }
    }
    return { handleEvent, pause, dispatchRunning };
}
//# sourceMappingURL=assistantAppBindings.js.map