export function createAssistantAppDependencies(deps) {
    function settleOwned(turnId) {
        if (deps.getCurrentTurnId() !== turnId)
            return;
        deps.endAgentBubble();
        deps.setCurrentTurnId(null);
        deps.transition("idle");
    }
    function appendStoppedText(text) {
        deps.appendUserBubble(text);
        deps.endAgentBubble();
        deps.setTicker(deps.translate("ticker.done", { reason: deps.translate("reason.aborted") }));
        deps.setCommand("");
        deps.transition("idle");
    }
    async function startReplacement(text) {
        const result = await deps.invoke("frondose_agent_turn", { prompt: text });
        if (!result.ok) {
            const error = new Error(result.reason);
            deps.surfaceFailure(deps.translate("action.turn"), error);
            throw error;
        }
        deps.setCurrentTurnId(result.turnId);
        deps.setLastTurnPrompt(text);
        deps.appendUserBubble(text);
        deps.setTicker(deps.translate("ticker.starting"));
        deps.setCommand("");
        deps.transition("running");
    }
    return {
        getCurrentTurnId: deps.getCurrentTurnId,
        setCurrentTurnId: deps.setCurrentTurnId,
        requestAnimationFrame: deps.requestAnimationFrame,
        scrollToBottom: deps.scrollToBottom,
        settleOwned,
        appendStoppedText,
        startReplacement,
        reportFailure: (error) => deps.surfaceFailure(deps.translate("action.pauseAbort"), error),
        onTurnStartedView: (frame) => {
            deps.setTicker(deps.translate(frame.source === "cron" ? "ticker.cronRunning" : "ticker.starting"));
            deps.transition("running");
        },
        onDoneView: (frame) => {
            const reason = frame.aborted ? deps.translate("reason.aborted") : frame.finishReason;
            deps.setTicker(deps.translate("ticker.done", { reason }));
            if (frame.aborted) {
                deps.transition("idle");
                return;
            }
            deps.setRetryVisible(false);
            deps.setError("");
            deps.setLastTurnPrompt(null);
            deps.transition("idle");
        },
        onErrorView: (frame, preserveRunning = false) => {
            const message = deps.translate("error.agent", { msg: frame.message });
            deps.setRetryVisible(frame.retryable === true);
            if (preserveRunning) {
                deps.transition("running");
                deps.setError(message);
                return;
            }
            deps.setError(message);
            deps.transition("error");
        },
    };
}
//# sourceMappingURL=assistantAppDependencies.js.map