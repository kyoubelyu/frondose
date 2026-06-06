import { type AssistantMessage, complete, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { CoreMessage, StepResult, ToolSet } from "ai";
import type { AgentLoopOpts } from "../loop.js";
import { DEFAULT_MAX_STEPS } from "../maxSteps.js";
import { coreMessagesToPi, piAssistantToCore, piToolResultToCore } from "./messageAdapter.js";
import { resolvePiModel } from "./model.js";
import { buildPiToolBundle } from "./toolAdapter.js";

/**
 * [P-PI Gate 2] Pi agent loop — a DROP-IN for runAgentLoop (same AgentLoopOpts contract),
 * selected by the MAI_AGENT_RUNTIME=pi flag. Drives DeepSeek through pi-ai's
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
 *
 * NOT yet ported (follow-up within Gate 2): the D-12 narrate-without-execute + D-22 stall
 * continuation retries, and token-level streaming via stream() (this v1 uses complete() and
 * emits each assistant text block as one onText chunk).
 */
export async function runAgentLoopPi(opts: AgentLoopOpts): Promise<void> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const { model, apiKey, onPayload } = resolvePiModel();
  const { tools, dispatch } = buildPiToolBundle(opts.tools, opts.activeTools);
  const { piMessages } = coreMessagesToPi(opts.messages, model.id);
  const newCore: CoreMessage[] = [];

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (opts.abortSignal?.aborted) break;
      const assistant: AssistantMessage = await complete(
        model,
        { systemPrompt: opts.system, messages: piMessages, tools },
        { apiKey, signal: opts.abortSignal, onPayload },
      );
      piMessages.push(assistant);
      newCore.push(piAssistantToCore(assistant));

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
  } catch (e) {
    if (opts.abortSignal?.aborted) return;
    throw e;
  } finally {
    // Persist whatever was produced (matches runAgentLoop pushing response messages; on
    // abort/error the partial transcript is still recorded for audit + the next turn).
    opts.messages.push(...newCore);
  }
}

function parseToolResult(tr: ToolResultMessage): unknown {
  const text = tr.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  try {
    return JSON.parse(text);
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
