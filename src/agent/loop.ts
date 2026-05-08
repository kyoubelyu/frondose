import { type CoreMessage, type LanguageModel, type StepResult, streamText, type ToolSet } from "ai";

export interface AgentLoopOpts {
  model: LanguageModel;
  system: string;
  messages: CoreMessage[];
  tools: ToolSet;
  /** Called for each text-delta chunk. Optional. */
  onText?: (delta: string) => void;
  /** Max LLM round-trips for tool-call loops. Default 10 (per scout Q2 sufficient for echo). */
  maxSteps?: number;
  /** Abort signal for graceful cancellation (P-1; reused by P-6 stop tool). */
  abortSignal?: AbortSignal;
  /** Vercel onStepFinish hook — fires after each LLM step. Used by audit writer (P-6). */
  onStepFinish?: (step: StepResult<ToolSet>) => Promise<void> | void;
  /** Informational callback; the actual abort happens via abortSignal. Reserved for future use (P-6). */
  onStopRequested?: () => void;
}

/**
 * Run one turn of the agent loop:
 *  - sends the messages array to the LLM via streamText
 *  - executes any tool calls in-line (Vercel handles execution per scout Q2)
 *  - streams text deltas to onText
 *  - on stream end, appends response messages to the caller's messages array (mutates in place)
 *
 * Caller is responsible for persisting the new messages after this resolves.
 */
export async function runAgentLoop(opts: AgentLoopOpts): Promise<void> {
  try {
    const result = streamText({
      model: opts.model,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      maxSteps: opts.maxSteps ?? 10,
      abortSignal: opts.abortSignal,
      onStepFinish: opts.onStepFinish,
    });
    for await (const chunk of result.textStream) {
      opts.onText?.(chunk);
    }
    const { messages: responseMessages } = await result.response;
    opts.messages.push(...responseMessages);
  } catch (e) {
    // P-6 Step 5a (Failure 1 fix): when the stop tool fires control.requestStop(),
    // the shared AbortController.abort() makes streamText throw AbortError. Treat
    // an aborted-signal completion as clean — caller's process.exit(0) flow expects
    // this. Audit JSONL is already flushed via onStepFinish for any completed steps
    // (synchronous appendFileSync per src/persistence/audit.ts).
    if (opts.abortSignal?.aborted) return;
    throw e;
  }
}
