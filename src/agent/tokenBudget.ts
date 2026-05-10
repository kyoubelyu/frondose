import type { LanguageModel, LanguageModelUsage } from "ai";

/**
 * Per-model context-window table. Lookup key is `${provider}:${modelId}`,
 * with `${modelId}` as a fallback. Anything unmatched returns DEFAULT.
 *
 * Sources: scout V-6 + operator-confirmed deepseek-v4-flash = 1M (2026-05-10).
 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // DeepSeek (via OpenAI-compatible adapter — provider id is "openai" runtime,
  // but we also key by bare modelId for robustness)
  "openai:deepseek-v4-flash": 1_000_000,
  "openai:deepseek-v4-pro": 1_000_000,
  "openai:deepseek-chat": 64_000,
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  "deepseek-chat": 64_000,
  // Anthropic
  "anthropic:claude-sonnet-4-5": 200_000,
  "anthropic:claude-sonnet-4-5-20250929": 200_000,
  "anthropic:claude-sonnet-4-6": 1_000_000,
  "anthropic:claude-opus-4-5": 200_000,
  "anthropic:claude-opus-4-6": 1_000_000,
  "anthropic:claude-opus-4-7": 1_000_000,
  "anthropic:claude-haiku-4-5": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  // OpenAI
  "openai:gpt-4o": 128_000,
  "openai:gpt-4o-mini": 128_000,
  "gpt-4o": 128_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

export class TokenBudget {
  // rev-3: dropped cumulativePrompt (was only consumed by /cost; that command
  // is removed). lastPromptTokens is the canonical context-fill signal for
  // both auto-compaction (D-8) and the status line (D-18).
  cumulativeCompletion = 0;
  cumulativeTotal = 0;
  lastPromptTokens = 0;
  readonly contextWindow: number;

  constructor(model: LanguageModel) {
    this.contextWindow = TokenBudget.contextWindowFor(model);
  }

  add(usage: LanguageModelUsage): void {
    this.cumulativeCompletion += usage.completionTokens ?? 0;
    this.cumulativeTotal += usage.totalTokens ?? 0;
    this.lastPromptTokens = usage.promptTokens ?? this.lastPromptTokens;
  }

  reset(): void {
    this.cumulativeCompletion = 0;
    this.cumulativeTotal = 0;
    this.lastPromptTokens = 0;
  }

  static contextWindowFor(model: LanguageModel): number {
    const m = model as { provider?: string; modelId?: string };
    const composite = `${m.provider ?? ""}:${m.modelId ?? ""}`;
    const compositeHit = MODEL_CONTEXT_WINDOWS[composite];
    if (compositeHit != null) return compositeHit;
    if (m.modelId) {
      const bareHit = MODEL_CONTEXT_WINDOWS[m.modelId];
      if (bareHit != null) return bareHit;
    }
    return DEFAULT_CONTEXT_WINDOW;
  }
}
