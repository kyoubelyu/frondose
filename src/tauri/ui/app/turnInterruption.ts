type AbortResponse = { ok: true } | { ok: false; reason: string };
type InterruptOutcome = "stopped" | "already_stopped" | "rejected" | "stale";

export function createTurnInterruptionController(deps: {
  getCurrentTurnId: () => string | null;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  settleOwned: (turnId: string) => void;
  appendStoppedText: (text: string) => void;
  startReplacement: (text: string) => Promise<void>;
  reportFailure: (error: unknown) => void;
}): {
  pause(): Promise<InterruptOutcome>;
  stop(text: string): Promise<InterruptOutcome>;
  steer(text: string): Promise<InterruptOutcome>;
} {
  async function interrupt(after: () => void | Promise<void>): Promise<InterruptOutcome> {
    const turnId = deps.getCurrentTurnId();
    if (turnId === null) return "already_stopped";
    let result: AbortResponse;
    try {
      result = await deps.invoke<AbortResponse>("frondose_agent_abort");
    } catch (error) {
      if (deps.getCurrentTurnId() !== turnId) return "stale";
      deps.reportFailure(error);
      return "rejected";
    }
    if (deps.getCurrentTurnId() !== turnId) return "stale";
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
