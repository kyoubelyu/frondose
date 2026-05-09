import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { readAuthJsonKey as readAuthJsonKeyFromAuthJs } from "../persistence/auth.js";

// P-7: re-export for callers (e.g. bootstrap-agent) that already import from modelResolver.
export const readAuthJsonKey = readAuthJsonKeyFromAuthJs;

export const DEFAULT_MODEL_SPEC = "anthropic:claude-sonnet-4-5";

const AUTH_JSON_PATH = (): string => join(homedir(), ".mai", "auth.json");

/** Read ~/.mai/auth.json's `.default` field if file exists; else undefined. */
export function readAuthJsonDefault(): string | undefined {
  try {
    const raw = readFileSync(AUTH_JSON_PATH(), "utf-8");
    const json = JSON.parse(raw) as { default?: unknown };
    return typeof json.default === "string" ? json.default : undefined;
  } catch {
    return undefined;
  }
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
 * Used by runIdentityBootstrap before runBootstrapAgent (chicken-and-egg guard per F-3r.4).
 */
export function detectAnyModelKey(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  if (process.env.OPENAI_API_KEY) return true;
  if (process.env.DEEPSEEK_API_KEY) return true;
  if (readAuthJsonKey("anthropic")) return true;
  if (readAuthJsonKey("openai")) return true;
  if (readAuthJsonKey("deepseek")) return true;
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

function buildModel(spec: string): LanguageModel {
  const { provider, modelId } = parseModelSpec(spec);
  if (provider === "anthropic") {
    // P-7 (F-10): env wins; auth.json fallback.
    const key = process.env.ANTHROPIC_API_KEY ?? readAuthJsonKey("anthropic");
    return createAnthropic({ apiKey: key })(modelId);
  }
  if (provider === "openai") {
    if (modelId.startsWith("deepseek")) {
      const key = process.env.DEEPSEEK_API_KEY ?? readAuthJsonKey("deepseek");
      const rawBase = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
      // Normalize: strip trailing /v1 (with optional trailing slash) so we don't
      // produce https://api.deepseek.com/v1/v1/chat/completions when operator
      // sets DEEPSEEK_BASE_URL=https://api.deepseek.com/v1 (OQ-4).
      const baseURL = `${rawBase.replace(/\/v1\/?$/, "")}/v1`;
      return createOpenAI({
        baseURL,
        apiKey: key,
        compatibility: "compatible",
        name: "deepseek",
        fetch: makeNoThinkingFetch(modelId), // v0.4-fix1: force non-thinking on v4-flash / v4-pro
      })(modelId);
    }
    const key = process.env.OPENAI_API_KEY ?? readAuthJsonKey("openai");
    return createOpenAI({ apiKey: key })(modelId);
  }
  throw new Error(`Unknown provider '${provider}' in model spec '${spec}'. Supported: 'anthropic', 'openai'.`);
}
