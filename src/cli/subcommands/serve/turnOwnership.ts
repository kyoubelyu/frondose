import type { ServeState } from "./context.js";

export function clearCurrentTurnIfOwned(state: ServeState, turnId: string): boolean {
  if (state.currentTurn?.turnId !== turnId) return false;
  state.currentTurn = null;
  return true;
}
