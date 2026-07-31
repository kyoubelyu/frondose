export function createTurnInterruptionController(deps) {
    async function interrupt(after) {
        const turnId = deps.getCurrentTurnId();
        if (turnId === null)
            return "already_stopped";
        let result;
        try {
            result = await deps.invoke("frondose_agent_abort");
        }
        catch (error) {
            if (deps.getCurrentTurnId() !== turnId)
                return "stale";
            deps.reportFailure(error);
            return "rejected";
        }
        if (deps.getCurrentTurnId() !== turnId)
            return "stale";
        if (!result.ok && result.reason !== "not_found") {
            deps.reportFailure(result.reason);
            return "rejected";
        }
        deps.settleOwned(turnId);
        await after();
        return result.ok ? "stopped" : "already_stopped";
    }
    return {
        pause: () => interrupt(() => undefined),
        stop: (text) => interrupt(() => deps.appendStoppedText(text)),
        steer: (text) => interrupt(() => deps.startReplacement(text)),
    };
}
//# sourceMappingURL=turnInterruption.js.map