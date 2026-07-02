import type { CoreMessage, LanguageModel, StepResult, ToolSet } from "ai";

/**
 * AgentLoopOpts — the stable contract every caller passes in (kept after the P-PI cutover so
 * the two call sites — serve/turn.ts, serve/passive.ts — don't have to change).
 * Pi (runAgentLoopPi) ignores opts.model and resolves DeepSeek from env/secrets; the rest of the
 * shape (system / messages / tools / callbacks / abortSignal) maps 1:1.
 */
export interface AgentLoopOpts {
  model: LanguageModel;
  system: string;
  messages: CoreMessage[];
  tools: ToolSet;
  activeTools?: string[];
  /** Called for each text chunk. Optional. */
  onText?: (delta: string) => void;
  /**
   * [P-THINK] Called for each reasoning/thinking delta as the model streams its chain of thought.
   * Ephemeral — thinking is surfaced live (gray in the UI) but NOT persisted to messages. Optional.
   */
  onReasoning?: (delta: string) => void;
  /** Max LLM round-trips for tool-call loops. Default 200 (P-46 D-1). */
  maxSteps?: number;
  /** Abort signal for graceful cancellation (P-1; reused by P-6 stop tool). */
  abortSignal?: AbortSignal;
  /** Fires after each LLM step — used by the P-6 audit writer + turn.ts overlay/workflow handlers. */
  onStepFinish?: (step: StepResult<ToolSet>) => Promise<void> | void;
  /** Informational callback; the actual abort happens via abortSignal. Reserved for future use (P-6). */
  onStopRequested?: () => void;
  /** P-56b: fires when the model starts a tool call before execution. */
  onToolCall?: (toolName: string) => void;
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
/**
 * [P-PI cutover] runAgentLoop is now a thin delegate to runAgentLoopPi — the Vercel AI SDK
 * `streamText` path has been removed. Pi (DeepSeek via openai-completions) is THE loop;
 * `opts.model` is ignored (Pi resolves DeepSeek from env/secrets). Kept as a function so the
 * two existing callers (src/cli/subcommands/serve/turn.ts,
 * src/cli/subcommands/serve/passive.ts) don't have to change. The D-12/D-22 retry detectors
 * exported above are shared with runAgentLoopPi. The D-25 finishReason='error' synthetic-throw
 * hack is GONE — Pi natively throws LlmCallError on stopReason='error' (PI-LOOP-1). The D-2
 * two-phase budget warning was a Vercel-specific workaround for the lack of mid-loop hooks; it
 * is a recorded follow-up (PI-LOOP-4) to port into runAgentLoopPi when long-Auto-turn cases
 * actually need it.
 */
export async function runAgentLoop(opts: AgentLoopOpts): Promise<void> {
  const { runAgentLoopPi } = await import("./pi/loop.js");
  await runAgentLoopPi(opts);
}
