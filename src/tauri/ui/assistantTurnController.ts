import { buildAgentBubble, type AgentBubbleRefs } from "./app/agentBubble.js";
import { renderMarkdownInto, type DocumentLike, type ElementLike } from "./render.js";

export type AssistantPresentationFrame =
  | { type: "assistant-progress"; turnId: string; text: string }
  | { type: "text"; turnId: string; chunk: string }
  | { type: "done"; turnId: string; finishReason: string; aborted?: boolean }
  | { type: "error"; turnId?: string; message: string };

export type AssistantPresentationOutcome = "ignored" | "progress" | "final" | "terminal";

export interface AssistantTurnController {
  beginTurn(): void;
  handle(frame: AssistantPresentationFrame): AssistantPresentationOutcome;
  endTurn(): void;
  appendFinal(text: string): void;
}

export function createAssistantTurnController(deps: {
  document: DocumentLike;
  conversationList: ElementLike;
  getCurrentTurnId: () => string | null;
  requestAnimationFrame: (callback: () => void) => number;
  scrollToBottom: () => void;
}): AssistantTurnController {
  let refs: AgentBubbleRefs | null = null;
  let rawText = "";
  let generation = 0;
  let pendingGeneration: number | null = null;

  function beginTurn(): void {
    endTurn();
    refs = buildAgentBubble(deps.document, deps.conversationList);
    rawText = "";
    generation += 1;
    pendingGeneration = null;
    deps.scrollToBottom();
  }

  function ensureTurn(): AgentBubbleRefs {
    if (refs === null) beginTurn();
    return refs as AgentBubbleRefs;
  }

  function clearProgress(target: AgentBubbleRefs): void {
    target.progressTextEl.textContent = "";
    target.progressWrap.classList.add("hidden");
  }

  function renderNow(target: AgentBubbleRefs, targetGeneration: number): void {
    if (refs !== target || generation !== targetGeneration) return;
    renderMarkdownInto(deps.document, target.textEl, rawText);
    deps.scrollToBottom();
  }

  function scheduleRender(target: AgentBubbleRefs): void {
    const targetGeneration = generation;
    if (pendingGeneration === targetGeneration) return;
    pendingGeneration = targetGeneration;
    deps.requestAnimationFrame(() => {
      if (pendingGeneration === targetGeneration) pendingGeneration = null;
      renderNow(target, targetGeneration);
    });
  }

  function appendFinal(text: string): void {
    const target = ensureTurn();
    clearProgress(target);
    rawText += text;
    scheduleRender(target);
  }

  function endTurn(): void {
    if (refs === null) return;
    const target = refs;
    const targetGeneration = generation;
    clearProgress(target);
    renderNow(target, targetGeneration);
    refs = null;
    rawText = "";
    generation += 1;
    pendingGeneration = null;
  }

  function handle(frame: AssistantPresentationFrame): AssistantPresentationOutcome {
    const owner = deps.getCurrentTurnId();
    if (!("turnId" in frame) || frame.turnId !== owner) return "ignored";
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
