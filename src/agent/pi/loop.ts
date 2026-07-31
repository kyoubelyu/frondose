import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Message as PiMessage,
  stream,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { CoreMessage, StepResult, ToolSet } from "ai";
import {
  type AgentLoopCompletion,
  type AgentLoopOpts,
  lastAssistantMessageHasNoToolCalls,
  lastAssistantMessageMissedExecute,
  narrationContinueMessage,
  STALL_STEP_THRESHOLD,
  stalledContinueMessage,
} from "../loop.js";
import { DEFAULT_MAX_STEPS } from "../maxSteps.js";
import { coreMessagesToPi, piAssistantToCore, piToolResultToCore } from "./messageAdapter.js";
import { LLM_STREAM_IDLE_MS, LLM_STREAM_MAX_RETRIES, resolvePiModel } from "./model.js";
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
type PhaseRecord = {
  assistant: CoreMessage;
  text: string;
  toolResults: CoreMessage[];
  phase?: "intermediate" | "final";
};

export async function runAgentLoopPi(opts: AgentLoopOpts): Promise<AgentLoopCompletion> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const { model, apiKey, reasoningLevel, timeoutMs } = resolvePiModel();
  const { tools, dispatch } = buildPiToolBundle(opts.tools, opts.activeTools);
  const { piMessages } = coreMessagesToPi(opts.messages, model.id);
  const newCore: CoreMessage[] = [];
  const records: PhaseRecord[] = [];
  // [P-CONVO-GATE] Tool calls made THIS turn (across phases). The D-22 stall nudge must only
  // fire when in-flight work went silent — a turn that made ZERO tool calls and replied in
  // plain text is a legitimate conversational reply (Boundary "Conversational-turn gate"),
  // not a stall. Live-proven 2026-07-13: on "你好" the model correctly answered text-only,
  // then the unconditional stall nudge ("call a tool NOW … navigate_to_url to my LinkedIn
  // feed") countermanded it and launched the full sales flow — the operator-reported bug.
  let turnToolCallCount = 0;

  const emitPhase = (record: PhaseRecord, phase: "intermediate" | "final"): void => {
    record.phase = phase;
    if (record.text) opts.onAssistantPhaseText?.(record.text, phase);
  };

  /** Run one phase (up to stepCap complete() iterations). A no-tool terminal is held for the outer retry gate. */
  const runPhase = async (
    stepCap: number,
  ): Promise<{ count: number; terminal: PhaseRecord | null; exhausted: boolean }> => {
    let count = 0;
    for (let step = 0; step < stepCap; step++) {
      if (opts.abortSignal?.aborted) return { count, terminal: null, exhausted: false };
      const assistant: AssistantMessage = await completeWithIdleTimeout(
        model,
        { systemPrompt: opts.system, messages: piMessages, tools },
        // [P-THINK] reasoningEffort (NOT reasoning) — stream() is the low-level fn; the reasoning→
        // reasoningEffort clamp only lives in streamSimple. onReasoning surfaces thinking_delta live.
        { apiKey, signal: opts.abortSignal, reasoningEffort: reasoningLevel, timeoutMs },
        opts.onReasoning,
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
        const assistantCore = piAssistantToCore(assistant);
        newCore.push(assistantCore);
        const textBlocks = assistant.content
          .filter(
            (content): content is Extract<AssistantMessage["content"][number], { type: "text" }> =>
              content.type === "text",
          )
          .map((content) => content.text)
          .filter(Boolean);
        const record: PhaseRecord = {
          assistant: assistantCore,
          text: textBlocks.join(""),
          toolResults: [],
        };
        records.push(record);
        for (const text of textBlocks) opts.onText?.(text);

        const toolCalls = assistant.content.filter((content): content is ToolCall => content.type === "toolCall");
        turnToolCallCount += toolCalls.length;
        const continues = assistant.stopReason === "toolUse" && toolCalls.length > 0;
        if (continues) emitPhase(record, "intermediate");

        const stepToolResults: Array<{ toolCallId: string; toolName: string; args: unknown; result: unknown }> = [];
        for (const toolCall of toolCalls) {
          if (opts.abortSignal?.aborted) break;
          opts.onToolCall?.(toolCall.name);
          const toolResult = await dispatch(toolCall, opts.abortSignal);
          const resultCore = piToolResultToCore(toolResult);
          piMessages.push(toolResult);
          newCore.push(resultCore);
          record.toolResults.push(resultCore);
          stepToolResults.push({
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: toolCall.arguments,
            result: parseToolResult(toolResult),
          });
        }

        await opts.onStepFinish?.(makeVercelStep(assistant, toolCalls, stepToolResults));
        if (opts.abortSignal?.aborted) return { count, terminal: null, exhausted: false };
        if (!continues) return { count, terminal: record, exhausted: false };
      }
    }
    return { count, terminal: null, exhausted: count >= stepCap };
  };

  let completion: AgentLoopCompletion = { finishReason: opts.abortSignal?.aborted ? "aborted" : "max_steps" };
  try {
    const main = await runPhase(maxSteps);
    if (opts.abortSignal?.aborted) return { finishReason: "aborted" };
    if (main.exhausted) return { finishReason: "max_steps" };

    // [P-75 D-12 + D-22] Retry gate — ported verbatim from the Vercel loop (shared detectors).
    // Run the detectors on the full CoreMessage transcript (history + this turn's new messages);
    // the last assistant message lives in newCore. At most one continuation per turn.
    if (main.terminal) {
      const transcript = [...opts.messages, ...newCore];
      const narrative = lastAssistantMessageMissedExecute(transcript);
      // [P-CONVO-GATE] turnToolCallCount > 0: the stall nudge fires ONLY when the turn
      // started acting (>=1 tool call) and then went silent — D-22's original dogfood case
      // (start_auto_run + todo_write then silence). A zero-tool text-only turn is a
      // conversational reply, which the Boundary conversational-turn gate makes a
      // first-class outcome; nudging it with "call a tool NOW" re-created the reported
      // greeting-launches-sales-flow bug.
      const stalled =
        !narrative &&
        main.count > 0 &&
        turnToolCallCount > 0 &&
        main.count <= STALL_STEP_THRESHOLD &&
        lastAssistantMessageHasNoToolCalls(transcript);
      if (narrative || stalled) {
        const retryBudget = Math.min(maxSteps, 30);
        if (retryBudget >= 1) {
          emitPhase(main.terminal, "intermediate");
          const cont = narrative ? narrationContinueMessage() : stalledContinueMessage();
          piMessages.push(coreUserToPi(cont));
          newCore.push(cont);
          const retry = await runPhase(retryBudget);
          if (opts.abortSignal?.aborted) return { finishReason: "aborted" };
          if (retry.terminal) {
            emitPhase(retry.terminal, "final");
            completion = { finishReason: "stop" };
            return completion;
          }
          completion = { finishReason: "max_steps" };
          return completion;
        }
      }
      emitPhase(main.terminal, "final");
      completion = { finishReason: "stop" };
      return completion;
    }
    return completion;
  } catch (e) {
    if (opts.abortSignal?.aborted) return { finishReason: "aborted" };
    throw e;
  } finally {
    // Persist whatever was produced (matches runAgentLoop pushing response messages; on
    // abort/error the partial transcript is still recorded for audit + the next turn).
    opts.messages.push(...(opts.assistantHistory === "final-only" ? projectFinalOnlyHistory(records) : newCore));
  }
}

function projectFinalOnlyHistory(records: PhaseRecord[]): CoreMessage[] {
  const projected: CoreMessage[] = [];
  for (const record of records) {
    if (record.phase === "final" && record.text) {
      projected.push({ role: "assistant", content: [{ type: "text", text: record.text }] });
      continue;
    }

    const results = new Map<string, CoreMessage>();
    for (const message of record.toolResults) {
      if (!Array.isArray(message.content)) continue;
      const part = message.content[0] as { toolCallId?: string } | undefined;
      if (part?.toolCallId) results.set(part.toolCallId, message);
    }
    const content = Array.isArray(record.assistant.content)
      ? record.assistant.content.filter(
          (part): part is Extract<(typeof record.assistant.content)[number], { type: "tool-call" }> =>
            part.type === "tool-call" && results.has(part.toolCallId),
        )
      : [];
    if (content.length === 0) continue;
    projected.push({ role: "assistant", content });
    for (const part of content) {
      const result = results.get(part.toolCallId);
      if (result) projected.push(result);
    }
  }
  return projected;
}

type PiStreamArgs = Parameters<typeof stream>;

async function completeWithIdleTimeout(
  model: PiStreamArgs[0],
  context: PiStreamArgs[1],
  opts: NonNullable<PiStreamArgs[2]>,
  onReasoning?: (delta: string) => void,
): Promise<AssistantMessage> {
  let lastIdleError: Error | null = null;
  for (let attempt = 0; attempt <= LLM_STREAM_MAX_RETRIES; attempt++) {
    const callAc = new AbortController();
    const requestSignal = opts.signal ? AbortSignal.any([opts.signal, callAc.signal]) : callAc.signal;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimer = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        callAc.abort();
      }, LLM_STREAM_IDLE_MS);
    };

    try {
      const eventStream = stream(model, context, { ...opts, signal: requestSignal });
      resetIdleTimer();
      let terminal: AssistantMessage | null = null;
      for await (const event of eventStream) {
        if (opts.signal?.aborted) break;
        resetIdleTimer();
        // [P-THINK] Keep reasoning private. The callback is a liveness signal; the adapter drops
        // thinking from CoreMessages and app callers never render its bytes.
        if (event.type === "thinking_delta") onReasoning?.(event.delta);
        terminal = assistantFromTerminalEvent(event);
        if (terminal) break;
      }
      if (opts.signal?.aborted) throw makeTurnAbortError();
      terminal ??= await eventStream.result();
      if (terminal.stopReason === "aborted") {
        throw classifyAbortedStream(callAc.signal, opts.signal);
      }
      return terminal;
    } catch (e) {
      if (opts.signal?.aborted) {
        throw makeTurnAbortError();
      }
      if (callAc.signal.aborted) {
        lastIdleError = e instanceof Error ? e : new Error(String(e));
        if (attempt < LLM_STREAM_MAX_RETRIES) continue;
        throw new Error(
          `LLM stream idle timeout after ${LLM_STREAM_MAX_RETRIES + 1} attempts (${LLM_STREAM_IDLE_MS}ms idle window)`,
          { cause: lastIdleError },
        );
      }
      throw e;
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
    }
  }
  throw lastIdleError ?? new Error("LLM stream idle timeout");
}

function assistantFromTerminalEvent(event: AssistantMessageEvent): AssistantMessage | null {
  if (event.type === "done") return event.message;
  if (event.type === "error") return event.error;
  return null;
}

function classifyAbortedStream(callSignal: AbortSignal, turnSignal?: AbortSignal): Error {
  if (turnSignal?.aborted) return makeTurnAbortError();
  if (callSignal.aborted) return new Error("LLM stream idle timeout");
  return new Error("LLM stream returned stopReason='aborted'");
}

function makeTurnAbortError(): Error {
  const err = new Error("LLM stream aborted by turn signal");
  err.name = "AbortError";
  return err;
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
