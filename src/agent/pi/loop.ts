import {
  type AssistantMessage,
  complete,
  type Message as PiMessage,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { CoreMessage, StepResult, ToolSet } from "ai";
import {
  type AgentLoopOpts,
  lastAssistantMessageHasNoToolCalls,
  lastAssistantMessageMissedExecute,
  narrationContinueMessage,
  STALL_STEP_THRESHOLD,
  stalledContinueMessage,
} from "../loop.js";
import { DEFAULT_MAX_STEPS } from "../maxSteps.js";
import { coreMessagesToPi, piAssistantToCore, piToolResultToCore } from "./messageAdapter.js";
import { resolvePiModel } from "./model.js";
import { buildPiToolBundle } from "./toolAdapter.js";

/**
 * [P-PI Gate 2] Pi agent loop — a DROP-IN for runAgentLoop (same AgentLoopOpts contract),
 * selected by the FRONDOSE_AGENT_RUNTIME=pi flag. Drives DeepSeek through pi-ai's
 * `complete()` with the adapted tools, executes tool calls via the bundle dispatcher,
 * feeds results back, and repeats until the model stops or maxSteps. Emits the SAME
 * callbacks (onText / onToolCall / onStepFinish) with Vercel-shaped step objects so the
 * P-6 audit writer + the turn.ts overlay/workflow handling work UNCHANGED.
 *
 * Preserved invariants:
 * - opts.abortSignal: passed natively into complete() (a D-21 win — abort reaches the LLM
 *   call directly); the CDP-I/O abort still relies on raced.ts (loop-agnostic, unchanged).
 * - opts.messages: NEW assistant + tool messages are converted back to CoreMessage and pushed
 *   onto the caller's array (matching runAgentLoop), so persistence + audit stay Vercel-shaped.
 * - D-12 (narrate-without-execute) + D-22 (stall) retry gate: PORTED — runs the SAME shared
 *   detectors (exported from loop.ts) on the CoreMessage transcript after the main phase and
 *   injects one continuation, exactly like the Vercel loop.
 *
 * Remaining follow-up: token-level streaming via stream() (this v1 uses complete() and emits
 * each assistant text block as one onText chunk).
 */
export async function runAgentLoopPi(opts: AgentLoopOpts): Promise<void> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const { model, apiKey, onPayload, timeoutMs } = resolvePiModel();
  const { tools, dispatch } = buildPiToolBundle(opts.tools, opts.activeTools);
  const { piMessages } = coreMessagesToPi(opts.messages, model.id);
  const newCore: CoreMessage[] = [];

  /** Run one phase (up to stepCap complete() iterations); returns the iteration count. */
  const runPhase = async (stepCap: number): Promise<number> => {
    let count = 0;
    for (let step = 0; step < stepCap; step++) {
      if (opts.abortSignal?.aborted) break;
      const assistant: AssistantMessage = await complete(
        model,
        { systemPrompt: opts.system, messages: piMessages, tools },
        { apiKey, signal: opts.abortSignal, onPayload, timeoutMs },
      );
      count++;

      // [PI-LOOP-1] pi-ai does NOT throw on a provider error — it RETURNS an AssistantMessage with
      // stopReason='error' (e.g. the DeepSeek 400 schema reject). Surface it like the Vercel D-25 path:
      // throw so turn.ts's catch writes an llm_error audit row + emits the SSE error frame, instead of
      // silently looping. Thrown BEFORE persisting the empty assistant (PI-LOOP-2) and before the retry
      // gate (PI-LOOP-3 — no wasted second call on the same broken request).
      if (assistant.stopReason === "error" && !opts.abortSignal?.aborted) {
        const err = new Error(
          assistant.errorMessage || "LLM call returned stopReason='error' (no content, no tool calls)",
        );
        err.name = "LlmCallError";
        throw err;
      }

      // [PI-LOOP-2] Only persist an assistant that carries content/tool-calls. An error/aborted turn
      // yields content=[] — persisting it pollutes the transcript and risks a 400 on the next turn.
      if (assistant.content.length > 0) {
        piMessages.push(assistant);
        newCore.push(piAssistantToCore(assistant));
      }

      for (const c of assistant.content) {
        if (c.type === "text" && c.text) opts.onText?.(c.text);
      }

      const toolCalls = assistant.content.filter((c): c is ToolCall => c.type === "toolCall");
      const stepToolResults: Array<{ toolCallId: string; toolName: string; args: unknown; result: unknown }> = [];
      for (const tc of toolCalls) {
        if (opts.abortSignal?.aborted) break;
        opts.onToolCall?.(tc.name);
        const tr = await dispatch(tc, opts.abortSignal);
        piMessages.push(tr);
        newCore.push(piToolResultToCore(tr));
        stepToolResults.push({ toolCallId: tc.id, toolName: tc.name, args: tc.arguments, result: parseToolResult(tr) });
      }

      await opts.onStepFinish?.(makeVercelStep(assistant, toolCalls, stepToolResults));

      if (assistant.stopReason !== "toolUse" || toolCalls.length === 0) break;
    }
    return count;
  };

  try {
    const stepCount = await runPhase(maxSteps);

    // [P-75 D-12 + D-22] Retry gate — ported verbatim from the Vercel loop (shared detectors).
    // Run the detectors on the full CoreMessage transcript (history + this turn's new messages);
    // the last assistant message lives in newCore. At most one continuation per turn.
    if (!opts.abortSignal?.aborted) {
      const transcript = [...opts.messages, ...newCore];
      const narrative = lastAssistantMessageMissedExecute(transcript);
      const stalled =
        !narrative &&
        stepCount > 0 &&
        stepCount <= STALL_STEP_THRESHOLD &&
        lastAssistantMessageHasNoToolCalls(transcript);
      if (narrative || stalled) {
        const retryBudget = Math.min(maxSteps, 30);
        if (retryBudget >= 1) {
          const cont = narrative ? narrationContinueMessage() : stalledContinueMessage();
          piMessages.push(coreUserToPi(cont));
          newCore.push(cont);
          await runPhase(retryBudget);
        }
      }
    }
  } catch (e) {
    if (opts.abortSignal?.aborted) return;
    throw e;
  } finally {
    // Persist whatever was produced (matches runAgentLoop pushing response messages; on
    // abort/error the partial transcript is still recorded for audit + the next turn).
    opts.messages.push(...newCore);
  }
}

/** Convert a synthetic CoreMessage user-continuation (always a string) to a Pi UserMessage. */
function coreUserToPi(msg: CoreMessage): PiMessage {
  const content = typeof msg.content === "string" ? msg.content : "";
  return { role: "user", content, timestamp: Date.now() };
}

/**
 * [MA-1] Parse a tool-result text back to its envelope ONLY when it is genuinely structured
 * (object/array). A bare JSON-valid scalar — a quoted string, a numeric-overflow string like
 * "1e999" (→ null), a bare number — must stay the original string, or the round-trip corrupts
 * the tool output that turn.ts + the re-sent DeepSeek history read.
 */
function parseToolResult(tr: ToolResultMessage): unknown {
  const text = tr.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : text;
  } catch {
    return text;
  }
}

const STOP_REASON_TO_FINISH: Record<string, string> = {
  stop: "stop",
  length: "length",
  toolUse: "tool-calls",
  error: "error",
  aborted: "stop",
};

/** Build a Vercel StepResult-compatible object so turn.ts's onStepFinish (audit + overlay) is unchanged. */
function makeVercelStep(
  assistant: AssistantMessage,
  toolCalls: ToolCall[],
  toolResults: Array<{ toolCallId: string; toolName: string; args: unknown; result: unknown }>,
): StepResult<ToolSet> {
  const text = assistant.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");
  return {
    text,
    toolCalls: toolCalls.map((tc) => ({ toolCallId: tc.id, toolName: tc.name, args: tc.arguments })),
    toolResults,
    finishReason: STOP_REASON_TO_FINISH[assistant.stopReason] ?? "stop",
  } as unknown as StepResult<ToolSet>;
}
