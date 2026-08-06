import type { ServeDeps, ServeState } from "./context.js";
import type { TurnArgs } from "./turn/runOne.js";
import { runOneTurn } from "./turn/runOne.js";
import { resumeWorkflowTurn, steerThenTrigger } from "./turn/steer.js";
import { triggerAnalyzeProfile, triggerCardActionTurn } from "./turn/triggers.js";

export type { TurnArgs } from "./turn/runOne.js";

export function createTurnRunner(
  state: ServeState,
  deps: ServeDeps,
): {
  runOneTurn(args: TurnArgs): Promise<void>;
  triggerAnalyzeProfile(pageUrl: string, turnId: string, abortController: AbortController): Promise<void>;
  steerThenTrigger(newPrompt: string, isWorkflowResume?: boolean): Promise<void>;
  triggerCardActionTurn(actionPrompt: string, isWorkflowResume?: boolean): Promise<void>;
  resumeWorkflowTurn(prompt: string): Promise<void>;
} {
  const runOne = (args: TurnArgs): Promise<void> => runOneTurn(state, deps, args);
  const cardAction = (actionPrompt: string, isWorkflowResume = false): Promise<void> =>
    triggerCardActionTurn(state, deps, runOne, actionPrompt, isWorkflowResume);
  const analyzeProfile = (pageUrl: string, turnId: string, abortController: AbortController): Promise<void> =>
    triggerAnalyzeProfile(state, deps, runOne, pageUrl, turnId, abortController);
  const steer = (newPrompt: string, isWorkflowResume = false): Promise<void> =>
    steerThenTrigger(state, deps, cardAction, newPrompt, isWorkflowResume);
  const resumeWorkflow = (prompt: string): Promise<void> => resumeWorkflowTurn(steer, prompt);

  return {
    runOneTurn: runOne,
    triggerAnalyzeProfile: analyzeProfile,
    steerThenTrigger: steer,
    triggerCardActionTurn: cardAction,
    resumeWorkflowTurn: resumeWorkflow,
  };
}
