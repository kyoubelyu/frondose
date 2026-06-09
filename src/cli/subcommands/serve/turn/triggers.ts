import { randomBytes } from "node:crypto";
import type { ServeDeps, ServeState } from "../context.js";
import type { TurnArgs } from "./runOne.js";

type RunOneFn = (args: TurnArgs) => Promise<void>;

export async function triggerAnalyzeProfile(
  state: ServeState,
  deps: ServeDeps,
  runOne: RunOneFn,
  pageUrl: string,
  turnId: string,
  abortController: AbortController,
): Promise<void> {
  deps.emitFrame({ type: "turn-started", turnId, source: "server" });
  const analyzePrompt =
    `Operator is on profile ${pageUrl}. Analyze this profile against the operator's ICP. ` +
    "First call `inspect` to extract role/industry/region/companyName from the page. " +
    "Then call `qualify_profile` with those four fields. " +
    "Then call `suggest_card` with: " +
    "(a) when qualified — title (name + role), icpMatch, painChainHypothesis (≤2 sentences), " +
    "painChainStage (one of the 15 methodology enum values), suggestedMove (kind + text); " +
    '(b) when disqualified or extraction failed — {dismissed:true, reason:"..."}. ' +
    "Stop after suggest_card. Do NOT take any outreach action in this sub-turn.";
  state.messages.push({ role: "user", content: analyzePrompt });
  state.lastTurnUserPrompt = analyzePrompt;
  try {
    await runOne({
      turnId,
      abortController,
      userPrompt: analyzePrompt,
      isRetryable: false,
      maxSteps: 20,
      isCronTurn: false,
    });
  } catch (e) {
    deps.emitFrame({
      type: "error",
      turnId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function triggerCardActionTurn(
  state: ServeState,
  deps: ServeDeps,
  runOne: RunOneFn,
  actionPrompt: string,
  isWorkflowResume = false,
): Promise<void> {
  if (state.currentTurn !== null) {
    deps.emitFrame({
      type: "error",
      message: `cannot fire card action - turn ${state.currentTurn.turnId} in progress`,
    });
    return;
  }
  const turnId = randomBytes(4).toString("hex");
  const abortController = new AbortController();
  state.currentTurn = { turnId, abortController };
  deps.emitFrame({ type: "turn-started", turnId, source: "server" });
  state.messages.push({ role: "user", content: actionPrompt });
  state.lastTurnUserPrompt = actionPrompt;
  try {
    await runOne({
      turnId,
      abortController,
      userPrompt: actionPrompt,
      isRetryable: true,
      isCronTurn: false,
      isWorkflowResume,
    });
  } catch (e) {
    deps.emitFrame({
      type: "error",
      turnId,
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    state.currentTurn = null;
  }
}
