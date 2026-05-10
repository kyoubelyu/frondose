import { type CoreMessage, generateText, type LanguageModel } from "ai";

export interface CompactionMarker {
  type: "compaction";
  ts: string;
  summarizedCount: number;
  keptCount: number;
  model: string;
}

const SUMMARIZER_SYSTEM = `You are a conversation summarizer. Given the messages so far, produce a concise factual summary that preserves: operator's intent and any decisions made; key facts retrieved or stated; tool calls made and their outcomes; outstanding TODOs. Plain text, no markdown headers, ≤ 500 words. Do not add commentary.`;

const DEFAULT_LAST_K = 10;

export async function compactMessages(opts: {
  model: LanguageModel;
  messages: CoreMessage[];
  lastK?: number;
  abortSignal?: AbortSignal;
}): Promise<{ newMessages: CoreMessage[]; marker: CompactionMarker }> {
  const k = opts.lastK ?? DEFAULT_LAST_K;
  const total = opts.messages.length;
  const tail = opts.messages.slice(Math.max(0, total - k));
  const head = opts.messages.slice(0, Math.max(0, total - k));
  if (head.length === 0) {
    // nothing to summarize; return as-is with a no-op marker
    return {
      newMessages: opts.messages,
      marker: {
        type: "compaction",
        ts: new Date().toISOString(),
        summarizedCount: 0,
        keptCount: tail.length,
        model: modelLabel(opts.model),
      },
    };
  }
  const { text } = await generateText({
    model: opts.model,
    system: SUMMARIZER_SYSTEM,
    messages: head,
    maxTokens: 2048,
    abortSignal: opts.abortSignal,
  });
  // rev-2 D-9 / CONCERN-MR-1: role:"user" with marker prefix; works for all
  // providers (Anthropic / OpenAI / DeepSeek) without mid-conversation system-
  // message quirks.
  const summaryMsg: CoreMessage = {
    role: "user",
    content: `[Previous conversation summary by /compact]\n\n${text}`,
  };
  return {
    newMessages: [summaryMsg, ...tail],
    marker: {
      type: "compaction",
      ts: new Date().toISOString(),
      summarizedCount: head.length,
      keptCount: tail.length,
      model: modelLabel(opts.model),
    },
  };
}

function modelLabel(m: LanguageModel): string {
  const anyM = m as { provider?: string; modelId?: string };
  return `${anyM.provider ?? "?"}:${anyM.modelId ?? "?"}`;
}
