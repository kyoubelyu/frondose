import { type CoreMessage, type LanguageModel, streamText, type ToolSet } from "ai";

export interface AgentLoopOpts {
  model: LanguageModel;
  system: string;
  messages: CoreMessage[];
  tools: ToolSet;
  /** Called for each text-delta chunk. Optional. */
  onText?: (delta: string) => void;
  /** Max LLM round-trips for tool-call loops. Default 10 (per scout Q2 sufficient for echo). */
  maxSteps?: number;
  /** Abort signal for graceful cancellation. */
  abortSignal?: AbortSignal;
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
  const result = streamText({
    model: opts.model,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    maxSteps: opts.maxSteps ?? 10,
    abortSignal: opts.abortSignal,
  });
  for await (const chunk of result.textStream) {
    opts.onText?.(chunk);
  }
  const { messages: responseMessages } = await result.response;
  opts.messages.push(...responseMessages);
}
