import { type CoreMessage, type FinishReason, type LanguageModel, type StepResult, streamText, type ToolSet } from "ai";
import { DEFAULT_MAX_STEPS } from "./maxSteps.js";

/** P-46 D-2: fraction of the step budget consumed before the soft warning fires. */
const WARN_FRACTION = 0.8;

export interface AgentLoopOpts {
  model: LanguageModel;
  system: string;
  messages: CoreMessage[];
  tools: ToolSet;
  activeTools?: string[];
  /** Called for each text-delta chunk. Optional. */
  onText?: (delta: string) => void;
  /** Max LLM round-trips for tool-call loops. Default 200 (P-46 D-1). */
  maxSteps?: number;
  /** Abort signal for graceful cancellation (P-1; reused by P-6 stop tool). */
  abortSignal?: AbortSignal;
  /** Vercel onStepFinish hook — fires after each LLM step. Used by audit writer (P-6). */
  onStepFinish?: (step: StepResult<ToolSet>) => Promise<void> | void;
  /** Informational callback; the actual abort happens via abortSignal. Reserved for future use (P-6). */
  onStopRequested?: () => void;
  /** P-56b: fires when the model starts a tool call before execution. */
  onToolCall?: (toolName: string) => void;
}

/**
 * P-46 D-2: step-budget warning injected as a `user` turn between Phase 1 and
 * Phase 2 when Phase 1 was cut off mid-task. Deliberately distinct from the
 * Checkpoint band's token-limit / compaction guidance — this is a step-count
 * limit. Reuses the Checkpoint convention of reporting via `telegram_notify`.
 */
function budgetWarningMessage(remaining: number): CoreMessage {
  return {
    role: "user",
    content:
      `[STEP-BUDGET WARNING] About ${remaining} tool-call steps remain before this turn is ` +
      `force-ended. This is a step-count limit, not a context/token limit. Do NOT start new ` +
      `sub-tasks. Either complete the current action now, or stop and report your current ` +
      `progress and what still remains. Before the turn ends, call telegram_notify with the ` +
      `outcome (done / partial / blocked) so the operator is informed.`,
  };
}

/**
 * [P-75 D-12] Detect "narrate-without-execute" — the model emitted forward-looking text
 * ("Let me…", "I'll now…", "Next, I will…") and finished the turn with `stop` instead
 * of `tool-calls`, AND the final assistant message has no tool-call parts. This is a
 * recurring failure mode where the agent announces an action and quits without performing
 * it. We inject one synthetic continuation message and re-run a small phase.
 */
const NARRATIVE_HOOK_RE =
  /(let me (now |start |continue |first |go ahead |proceed |then |)|now let me|i['']?ll (now |start |go |then |next |proceed |first )|i will (now |then |proceed |first )|let['']?s (now |then |next )|next,?\s*(i['']?ll|i will))/i;

export function lastAssistantMessageMissedExecute(messages: CoreMessage[]): boolean {
  // Walk backward to find the LAST assistant message (tool results may follow it).
  let lastText = "";
  let hadToolCall = false;
  let found = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    found = true;
    const content = m.content as unknown;
    if (typeof content === "string") {
      lastText = content;
    } else if (Array.isArray(content)) {
      for (const part of content as Array<{ type?: string; text?: string }>) {
        if (part.type === "text" && typeof part.text === "string") lastText += part.text;
        if (part.type === "tool-call") hadToolCall = true;
      }
    }
    break;
  }
  if (!found || hadToolCall) return false;
  const tail = lastText.length > 500 ? lastText.slice(-500) : lastText;
  return NARRATIVE_HOOK_RE.test(tail);
}

export function narrationContinueMessage(): CoreMessage {
  return {
    role: "user",
    content:
      "Continue — execute the action you just announced. Call the next tool NOW; do not narrate further. " +
      "If you said you'd plan, call `todo_write`. If you said you'd draft, call `save_message_draft`. " +
      "If you said you'd click/type/inspect, call that tool. No more 'Let me…' or 'I'll…' prose this turn.",
  };
}

/**
 * [P-75 D-22] Stalled-turn detector. The model sometimes stops after only a
 * handful of tool calls without finishing the task — observed in Auto-Mastars
 * dogfood: start_auto_run + todo_write then silence for 3 minutes. D-12 narrative
 * detector only fires when the model emits "Let me…" prose first; a pure
 * silent-stop bypasses it. This complementary signal: when the turn ends with
 * very few tool-calling steps AND the last assistant message has no tool calls,
 * inject a continuation pushing the model to call its NEXT planned tool.
 *
 * Heuristic gate: stepCount <= STALL_STEP_THRESHOLD AND last assistant message
 * had no tool calls. Combined with the D-12 narrative check, we cover both
 * "stopped after announcing intent" (D-12) and "stopped without saying anything"
 * (D-22). Same retry budget pool — at most one retry per turn.
 */
export const STALL_STEP_THRESHOLD = 4;

export function lastAssistantMessageHasNoToolCalls(messages: CoreMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const content = m.content as unknown;
    if (typeof content === "string") return true;
    if (Array.isArray(content)) {
      for (const part of content as Array<{ type?: string }>) {
        if (part.type === "tool-call") return false;
      }
      return true;
    }
    return true;
  }
  return false;
}

export function stalledContinueMessage(): CoreMessage {
  return {
    role: "user",
    content:
      "You stopped without completing the task. Call your next planned tool NOW. " +
      "Look at the workflow plan you declared with `todo_write` (if any) and execute the next in_progress step. " +
      "If the page is blank, call `navigate_to_url` to my LinkedIn feed. " +
      "If you don't know what to do next, call `escalate_for_capability` with a clear question OR call `end_auto_run` (if an auto run is active) OR `stop`. " +
      "Do NOT respond with text only — call a tool.",
  };
}

/**
 * Run one turn of the agent loop:
 *  - sends the messages array to the LLM via streamText
 *  - executes any tool calls in-line (Vercel handles execution per scout Q2)
 *  - streams text deltas to onText
 *  - on stream end, appends response messages to the caller's messages array (mutates in place)
 *
 * P-46 D-2: two-phase. streamText (ai 4.3.19) has no mid-loop injection hook, so
 * we run Phase 1 to softCap = floor(maxSteps * 0.8); if it ends with finishReason
 * 'tool-calls' AND consumed the full Phase-1 cap (a heuristic for a genuine
 * maxSteps cutoff — see C-1), inject a soft budget warning as a user message and
 * run Phase 2 for the remaining steps. If Phase 1 finishes naturally ('stop'),
 * no Phase 2 — zero overhead.
 *
 * The two-phase split runs ONLY when the remaining budget is >= 2 (C-2): a
 * 1-step Phase 2 cannot both act and report, so for small budgets we run a
 * single phase at the full budget with no warning.
 *
 * Caller is responsible for persisting the new messages after this resolves.
 */
export async function runAgentLoop(opts: AgentLoopOpts): Promise<void> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const softCap = Math.max(1, Math.floor(maxSteps * WARN_FRACTION));
  const remaining = maxSteps - softCap;
  // C-2: only split into two phases when Phase 2 has a usable budget — at least
  // 2 steps, enough to both finish the current action AND call telegram_notify.
  // For small budgets (maxSteps <= 5 → remaining < 2) run a single phase at the
  // full budget with no warning, so the agent is never handed a 1-step Phase 2.
  const twoPhase = remaining >= 2;

  /** Run one streamText pass: stream text deltas, append response messages,
   *  return the resolved finishReason and the number of steps consumed.
   *
   *  [P-75 D-25] The Vercel AI SDK does NOT throw for upstream provider errors
   *  in many cases — when the LLM endpoint returns a 401/429/network failure,
   *  streamText resolves cleanly with finishReason='error' and an empty stream
   *  rather than rejecting. Without explicit detection here, the agent loop
   *  silently returns, no audit row is written, no SSE error is emitted, and
   *  the operator sees a "turn done" frame with zero output. We throw a
   *  synthetic Error on finishReason='error' so the upstream catch in
   *  runOneTurn (and its writeLlmErrorAudit + SSE error frame) fires.
   */
  const runPhase = async (stepCap: number): Promise<{ finishReason: FinishReason; stepCount: number }> => {
    const result = streamText({
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      experimental_activeTools: opts.activeTools as (keyof ToolSet)[] | undefined,
      maxSteps: stepCap,
      abortSignal: opts.abortSignal,
      onStepFinish: (step) => {
        if (opts.onToolCall) {
          for (const tc of step.toolCalls ?? []) {
            opts.onToolCall(tc.toolName);
          }
        }
        opts.onStepFinish?.(step);
      },
    });
    for await (const chunk of result.textStream) {
      opts.onText?.(chunk);
    }
    const { messages: responseMessages } = await result.response;
    opts.messages.push(...responseMessages);
    const steps = await result.steps;
    const finishReason = await result.finishReason;
    if (finishReason === "error" && !opts.abortSignal?.aborted) {
      // The SDK exposes upstream details on result.warnings + result.experimental_providerMetadata
      // in some versions; fold them into the synthetic error message so the operator-facing
      // audit row has enough context to act (401 → bad key, 429 → rate limit, network → URL).
      const warnings = (await result.warnings.catch(() => null)) ?? null;
      const warningStr =
        warnings && Array.isArray(warnings) && warnings.length
          ? `warnings=${JSON.stringify(warnings).slice(0, 400)}`
          : "";
      const err = new Error(
        `LLM call returned finishReason='error' (empty stream, no tool calls). ${warningStr} ` +
          "Likely causes: invalid API key (401), rate limit (429), network/DNS failure, or upstream malformed response.",
      );
      err.name = "LlmCallError";
      throw err;
    }
    return { finishReason, stepCount: steps.length };
  };

  try {
    const phase1 = await runPhase(twoPhase ? softCap : maxSteps);
    const cutOffMidTask = phase1.finishReason === "tool-calls" && phase1.stepCount >= softCap;
    if (twoPhase && cutOffMidTask && !opts.abortSignal?.aborted) {
      opts.messages.push(budgetWarningMessage(remaining));
      await runPhase(remaining);
      return;
    }
    // [P-75 D-12] narrative-without-execute detection.
    // [P-75 D-22] complementary stalled-turn detection (silent stop after few tools).
    // Both detectors share a single retry budget — at most one continuation per turn.
    if (!opts.abortSignal?.aborted) {
      const narrative = lastAssistantMessageMissedExecute(opts.messages);
      const stalled =
        !narrative &&
        phase1.stepCount > 0 &&
        phase1.stepCount <= STALL_STEP_THRESHOLD &&
        lastAssistantMessageHasNoToolCalls(opts.messages);
      if (narrative || stalled) {
        const retryBudget = Math.min(twoPhase ? remaining : maxSteps, 30);
        if (retryBudget >= 1) {
          opts.messages.push(narrative ? narrationContinueMessage() : stalledContinueMessage());
          await runPhase(retryBudget);
        }
      }
    }
  } catch (e) {
    // P-6 Step 5a (Failure 1 fix): when the stop tool fires control.requestStop(),
    // the shared AbortController.abort() makes streamText throw AbortError. Treat
    // an aborted-signal completion as clean — caller's process.exit(0) flow expects
    // this. Audit JSONL is already flushed via onStepFinish for any completed steps.
    if (opts.abortSignal?.aborted) return;
    throw e;
  }
}
