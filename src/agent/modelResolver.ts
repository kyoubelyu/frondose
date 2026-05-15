import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ProviderEntry } from "../persistence/auth.js";
import { readAuth, readAuthJsonKey as readAuthJsonKeyFromAuthJs } from "../persistence/auth.js";

// P-7: re-export for callers (e.g. bootstrap-agent) that already import from modelResolver.
export const readAuthJsonKey = readAuthJsonKeyFromAuthJs;

export const DEFAULT_MODEL_SPEC = "anthropic:claude-sonnet-4-5";

/** P-24 B-2 fix: pre-P-24 read direct from auth.json via readFileSync.
 *  Now routes through readAuth() shim which reads secrets.json (with legacy
 *  fallback). Function signature preserved for resolveModelSpec's caller. */
export function readAuthJsonDefault(): string | undefined {
  return readAuth()?.default;
}

export interface ResolveModelOpts {
  /** Programmatic factory override — highest precedence. */
  factory?: string;
  /** CLI flag value (`--model`) — second precedence. */
  cli?: string;
}

/**
 * Resolve the model SPEC from precedence chain:
 *   factory > cli > MAI_MODEL env > ~/.mai/auth.json default > DEFAULT_MODEL_SPEC
 * Pure function (no SDK calls). Tested independently in T-M1..T-M3.
 */
export function resolveModelSpec(opts: ResolveModelOpts = {}): string {
  return opts.factory ?? opts.cli ?? process.env.MAI_MODEL ?? readAuthJsonDefault() ?? DEFAULT_MODEL_SPEC;
}

/** Resolve the model object via the precedence chain + provider dispatch. */
export function resolveModel(opts: ResolveModelOpts = {}): LanguageModel {
  return buildModel(resolveModelSpec(opts));
}

/**
 * P-7: returns true if any LLM key is detected — env vars OR auth.json.
 * P-21: iterates ALL configured providers (not just 3 hardcoded names).
 * Used by runIdentityBootstrap before runBootstrapAgent (chicken-and-egg guard per F-3r.4).
 */
export function detectAnyModelKey(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  if (process.env.OPENAI_API_KEY) return true;
  if (process.env.DEEPSEEK_API_KEY) return true;
  try {
    const auth = readAuth();
    if (auth?.providers) {
      for (const entry of Object.values(auth.providers)) {
        if (entry.key) return true;
      }
    }
  } catch {
    // auth.json missing or corrupt — no keys from file
  }
  return false;
}

export function parseModelSpec(spec: string): { provider: string; modelId: string } {
  const idx = spec.indexOf(":");
  if (idx === -1) {
    throw new Error(
      `Invalid model spec '${spec}': must be '<provider>:<modelId>' (e.g. 'anthropic:claude-sonnet-4-5').`,
    );
  }
  const provider = spec.slice(0, idx);
  const modelId = spec.slice(idx + 1);
  if (!provider || !modelId) {
    throw new Error(`Invalid model spec '${spec}': empty provider or modelId.`);
  }
  return { provider, modelId };
}

/**
 * v0.4-fix1: DeepSeek models that default to thinking mode.
 *
 * For these models, DeepSeek emits `reasoning_content` alongside `content`.
 * Vercel AI SDK v4.3.19's `@ai-sdk/openai` adapter does not echo
 * `reasoning_content` back on subsequent turns, which causes DeepSeek to 400
 * on turn 2 of any multi-turn tool-call sequence. We force non-thinking mode
 * via `thinking: { type: "disabled" }` (DeepSeek API docs).
 *
 * Extend by adding model IDs as DeepSeek introduces new thinking-default models.
 * `deepseek-chat` and `deepseek-reasoner` (deprecated 2026-07-24) are NOT in
 * this set — `deepseek-chat` is non-thinking by default; `deepseek-reasoner`
 * is intentionally thinking-mode for back-compat callers.
 */
export const DEEPSEEK_THINKING_DEFAULT_MODELS: ReadonlySet<string> = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);

/**
 * v0.4-fix1: returns a `fetch` implementation that injects
 * `thinking: { type: "disabled" }` into chat-completions request bodies for
 * DeepSeek models in DEEPSEEK_THINKING_DEFAULT_MODELS. For all other model
 * IDs, returns `globalThis.fetch` unmodified (reference-identical, no closure
 * overhead).
 *
 * Idempotent: if the body already has a `thinking` field, leaves it untouched.
 * Defensive: any non-string body, missing init, or JSON parse failure falls
 * through to `globalThis.fetch` verbatim.
 */
export function makeNoThinkingFetch(modelId: string): typeof globalThis.fetch {
  if (!DEEPSEEK_THINKING_DEFAULT_MODELS.has(modelId)) {
    return globalThis.fetch;
  }
  return async (url, init) => {
    if (init && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        if (!("thinking" in parsed)) {
          parsed.thinking = { type: "disabled" };
          init = { ...init, body: JSON.stringify(parsed) };
        }
      } catch {
        // Non-JSON body — pass through unmodified.
      }
    }
    return globalThis.fetch(url, init);
  };
}

/**
 * P-21: Resolve the API key for a provider. Env var (backward compat) takes
 * precedence over auth.json stored key for the three well-known provider names
 * (anthropic / openai / deepseek). All other named providers use the stored key.
 */
function resolveModelKey(provider: string, entry: ProviderEntry): string {
  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }
  if (provider === "openai" && process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }
  if (provider === "deepseek" && process.env.DEEPSEEK_API_KEY) {
    return process.env.DEEPSEEK_API_KEY;
  }
  return entry.key;
}

function buildModel(spec: string): LanguageModel {
  const { provider, modelId } = parseModelSpec(spec);
  const auth = readAuth();
  const entry = auth?.providers?.[provider];
  if (!entry) {
    throw new Error(`Provider '${provider}' not configured in auth.json. Run \`mai auth set\` to add it.`);
  }

  const key = resolveModelKey(provider, entry);
  const type = entry.type ?? "openai"; // migrated entries always have type

  if (type === "anthropic") {
    return createAnthropic({
      baseURL: entry.baseUrl,
      apiKey: key,
    })(modelId);
  }

  // type === "openai" — OpenAI-compatible provider.
  // DEEPSEEK_BASE_URL env override preserved for backward compat (research §4.2a).
  // Normalize to ensure trailing /v1 (idempotent).
  const rawDeepseekOverride = provider === "deepseek" ? process.env.DEEPSEEK_BASE_URL : undefined;
  const deepseekNorm = rawDeepseekOverride ? `${rawDeepseekOverride.replace(/\/v1\/?$/, "")}/v1` : undefined;
  const baseURL = deepseekNorm ?? entry.baseUrl;
  const fetchFn = DEEPSEEK_THINKING_DEFAULT_MODELS.has(modelId) ? makeNoThinkingFetch(modelId) : undefined;
  return createOpenAI({
    baseURL,
    apiKey: key,
    compatibility: "compatible",
    name: provider,
    ...(fetchFn ? { fetch: fetchFn } : {}),
  })(modelId);
}
