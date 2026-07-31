import { createAssistantAppBindings } from "./assistantAppBindings.js";
export function createAssistantAppComposition(deps) {
    return createAssistantAppBindings({
        runtime: deps.runtime,
        getCurrentTurnId: deps.getCurrentTurnId,
        cancelWorkflow: async () => {
            const result = await deps.invoke("frondose_workflow_cancel", {
                workflowId: deps.getWorkflowId() ?? "",
            });
            if (!result.ok)
                throw result.reason;
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
            if (frame.turnId === deps.getCurrentTurnId())
                deps.setCurrentTurnId(null);
            deps.onErrorView(frame, preserveRunning);
        },
        reportFailure: deps.reportFailure,
    });
}
//# sourceMappingURL=assistantAppComposition.js.map