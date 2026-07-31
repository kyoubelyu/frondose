type AppState = "idle" | "running" | "error";
type TurnResponse = { ok: true; turnId: string } | { ok: false; reason: string };
type LifecycleFrame = { type: "turn-started"; turnId: string; source: string };
type DoneFrame = { type: "done"; turnId: string; finishReason: string; aborted?: boolean };
type ErrorFrame = { type: "error"; turnId?: string; message: string; retryable?: boolean };

export function createAssistantAppDependencies(deps: {
  getCurrentTurnId: () => string | null;
  setCurrentTurnId: (turnId: string | null) => void;
  getLastTurnPrompt: () => string | null;
  setLastTurnPrompt: (prompt: string | null) => void;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  requestAnimationFrame: (callback: () => void) => number;
  scrollToBottom: () => void;
  endAgentBubble: () => void;
  appendUserBubble: (text: string) => void;
  setTicker: (text: string) => void;
  setError: (text: string) => void;
  setRetryVisible: (visible: boolean) => void;
  setCommand: (text: string) => void;
  transition: (state: AppState) => void;
  translate: (key: string, vars?: Record<string, string>) => string;
  surfaceFailure: (label: string, error: unknown) => void;
}) {
  function settleOwned(turnId: string): void {
    if (deps.getCurrentTurnId() !== turnId) return;
    deps.endAgentBubble();
    deps.setCurrentTurnId(null);
    deps.transition("idle");
  }

  function appendStoppedText(text: string): void {
    deps.appendUserBubble(text);
    deps.endAgentBubble();
    deps.setTicker(deps.translate("ticker.done", { reason: "aborted" }));
    deps.setCommand("");
    deps.transition("idle");
  }

  async function startReplacement(text: string): Promise<void> {
    const result = await deps.invoke<TurnResponse>("frondose_agent_turn", { prompt: text });
    if (!result.ok) {
      const error = new Error(result.reason);
      deps.surfaceFailure("action.turn", error);
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
    reportFailure: (error: unknown) => deps.surfaceFailure("action.pauseAbort", error),
    onTurnStartedView: (frame: LifecycleFrame) => {
      deps.setTicker(deps.translate(frame.source === "cron" ? "ticker.cronRunning" : "ticker.starting"));
      deps.transition("running");
    },
    onDoneView: (frame: DoneFrame) => {
      deps.setTicker(deps.translate("ticker.done", { reason: frame.finishReason }));
      if (frame.aborted) {
        deps.transition("idle");
        return;
      }
      deps.setRetryVisible(false);
      deps.setError("");
      deps.setLastTurnPrompt(null);
      deps.transition("idle");
    },
    onErrorView: (frame: ErrorFrame, preserveRunning = false) => {
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
