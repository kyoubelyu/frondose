const EXACT_STOP_INTENTS = new Set([
    "stop",
    "stop now",
    "please stop",
    "cancel",
    "abort",
    "halt",
    "pause",
    "停",
    "停止",
    "停下",
    "停下来",
    "别做了",
    "不要继续",
    "先停",
    "暂停",
    "中止",
    "终止",
    "取消",
]);
function normalizeStopIntent(input) {
    return input.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?。！？]+$/u, "");
}
export function isExplicitStopIntent(input) {
    const normalized = normalizeStopIntent(input);
    if (normalized.length === 0)
        return false;
    if (EXACT_STOP_INTENTS.has(normalized))
        return true;
    if (/^(?:kill|close|quit|terminate) (?:the )?(?:chrome|browser)$/u.test(normalized))
        return true;
    return /^(?:关闭|关掉|退出|杀掉)\s*(?:chrome|浏览器)$/u.test(normalized);
}
export function createRunningComposerController(deps) {
    let inFlight = false;
    return {
        async dispatch(input) {
            const text = input.trim();
            if (text.length === 0)
                return "empty";
            if (inFlight)
                return "busy";
            inFlight = true;
            try {
                if (!isExplicitStopIntent(text)) {
                    await deps.steer(text);
                    return "steer";
                }
                try {
                    const result = await deps.invoke("frondose_agent_abort");
                    if (result.ok) {
                        deps.settleStopped(text);
                        return "stopped";
                    }
                    if (result.reason === "not_found") {
                        deps.settleStopped(text);
                        return "already_stopped";
                    }
                    deps.reportStopFailure(result.reason);
                    return "rejected";
                }
                catch (error) {
                    deps.reportStopFailure(error);
                    return "rejected";
                }
            }
            finally {
                inFlight = false;
            }
        },
    };
}
//# sourceMappingURL=runningComposer.js.map