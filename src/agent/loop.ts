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

function lastAssistantMessageMissedExecute(messages: CoreMessage[]): boolean {
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

function narrationContinueMessage(): CoreMessage {
  return {
    role: "user",
    content:
      "Continue — execute the action you just announced. Call the next tool NOW; do not narrate further. " +
      "If you said you'd plan, call `todo_write`. If you said you'd draft, call `save_message_draft`. " +
      "If you said you'd click/type/inspect, call that tool. No more 'Let me…' or 'I'll…' prose this turn.",
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
   *  return the resolved finishReason and the number of steps consumed. */
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
    return { finishReason: await result.finishReason, stepCount: steps.length };
  };

  try {
    const phase1 = await runPhase(twoPhase ? softCap : maxSteps);
    const cutOffMidTask = phase1.finishReason === "tool-calls" && phase1.stepCount >= softCap;
    if (twoPhase && cutOffMidTask && !opts.abortSignal?.aborted) {
      opts.messages.push(budgetWarningMessage(remaining));
      await runPhase(remaining);
      return;
    }
    // [P-75 D-12] Vercel SDK can report finishReason='tool-calls' even when the
    // model's actual final step had no tool call — so we don't gate on finishReason.
    // The reliable signal is: the LAST assistant message has no tool-call parts AND
    // its trailing text matches the narrative-intent pattern ("Let me…", "I'll…",
    // "Now let me…"). Cap at 1 retry per turn.
    if (!opts.abortSignal?.aborted && lastAssistantMessageMissedExecute(opts.messages)) {
      const retryBudget = Math.min(twoPhase ? remaining : maxSteps, 30);
      if (retryBudget >= 1) {
        opts.messages.push(narrationContinueMessage());
        await runPhase(retryBudget);
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
