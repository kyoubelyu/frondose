import type { ServeDeps, ServeState } from "../context.js";

type CardActionFn = (actionPrompt: string, isWorkflowResume?: boolean) => Promise<void>;
type SteerFn = (newPrompt: string, isWorkflowResume?: boolean) => Promise<void>;

export async function steerThenTrigger(
  state: ServeState,
  deps: ServeDeps,
  cardAction: CardActionFn,
  newPrompt: string,
  isWorkflowResume = false,
): Promise<void> {
  if (state.currentTurn === null) {
    void cardAction(newPrompt, isWorkflowResume);
    return;
  }
  const previousTurnId = state.currentTurn.turnId;
  state.currentTurn.abortController.abort();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (state.currentTurn === null || state.currentTurn.turnId !== previousTurnId) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (state.currentTurn !== null && state.currentTurn.turnId === previousTurnId) {
    deps.emitFrame({
      type: "error",
      message: "steer timeout - aborted turn never cleared currentTurn",
    });
    return;
  }
  void cardAction(newPrompt, isWorkflowResume);
}

export async function resumeWorkflowTurn(steer: SteerFn, prompt: string): Promise<void> {
  await steer(prompt, true);
}
