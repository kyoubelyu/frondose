import { buildAgentBubble } from "./app/agentBubble.js";
import { renderMarkdownInto } from "./render.js";
export function createAssistantTurnController(deps) {
    let refs = null;
    let rawText = "";
    let generation = 0;
    let pendingGeneration = null;
    function beginTurn() {
        endTurn();
        refs = buildAgentBubble(deps.document, deps.conversationList);
        rawText = "";
        generation += 1;
        pendingGeneration = null;
        deps.scrollToBottom();
    }
    function ensureTurn() {
        if (refs === null)
            beginTurn();
        return refs;
    }
    function clearProgress(target) {
        target.progressTextEl.textContent = "";
        target.progressWrap.classList.add("hidden");
    }
    function renderNow(target, targetGeneration) {
        if (refs !== target || generation !== targetGeneration)
            return;
        renderMarkdownInto(deps.document, target.textEl, rawText);
        deps.scrollToBottom();
    }
    function scheduleRender(target) {
        const targetGeneration = generation;
        if (pendingGeneration === targetGeneration)
            return;
        pendingGeneration = targetGeneration;
        deps.requestAnimationFrame(() => {
            if (pendingGeneration === targetGeneration)
                pendingGeneration = null;
            renderNow(target, targetGeneration);
        });
    }
    function appendFinal(text) {
        const target = ensureTurn();
        clearProgress(target);
        rawText += text;
        scheduleRender(target);
    }
    function endTurn() {
        if (refs === null)
            return;
        const target = refs;
        const targetGeneration = generation;
        clearProgress(target);
        renderNow(target, targetGeneration);
        refs = null;
        rawText = "";
        generation += 1;
        pendingGeneration = null;
    }
    function handle(frame) {
        const owner = deps.getCurrentTurnId();
        if (!("turnId" in frame) || frame.turnId !== owner)
            return "ignored";
        if (frame.type === "assistant-progress") {
            const target = ensureTurn();
            target.progressTextEl.textContent = frame.text;
            target.progressWrap.classList.remove("hidden");
            deps.scrollToBottom();
            return "progress";
        }
        if (frame.type === "text") {
            appendFinal(frame.chunk);
            return "final";
        }
        endTurn();
        return "terminal";
    }
    return { beginTurn, handle, endTurn, appendFinal };
}
//# sourceMappingURL=assistantTurnController.js.map