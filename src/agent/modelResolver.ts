import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { AuthJson, ProviderEntry } from "../persistence/auth.js";
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  getOfficialDirectProviderBaseUrlVendor,
  isAllowedRuntimeProviderEntry,
  isReservedDirectProviderName,
  normalizeDeepSeekBaseUrl,
  normalizeProviderName,
  readAuth,
  readAuthJsonKey as readAuthJsonKeyFromAuthJs,
} from "../persistence/auth.js";

// P-7: re-export for callers (e.g. bootstrap-agent) that already import from modelResolver.
export const readAuthJsonKey = readAuthJsonKeyFromAuthJs;

export const DEFAULT_MODEL_SPEC = "deepseek:deepseek-v4-flash";

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

/** P-36 F-B: resolve the model, but NEVER throw — on any resolution failure,
 *  write one clear actionable stderr line and return null. The server callers
 *  use this so a bad LLM config degrades (orchestrator agent off) instead of
 *  crashing the whole fleet-coordination plane. */
export function resolveModelOrNull(opts: ResolveModelOpts = {}): LanguageModel | null {
  try {
    return resolveModel(opts);
  } catch (e) {
    process.stderr.write(
      `[mai] LLM model resolution failed: ${e instanceof Error ? e.message : String(e)}\n` +
        "[mai] orchestrator agent is DISABLED until this is fixed; REST + web listeners stay up.\n",
    );
    return null;
  }
}

/**
 * P-7: returns true if any LLM key is detected — env vars OR auth.json.
 * P-21: iterates ALL configured providers (not just 3 hardcoded names).
 * Used by runIdentityBootstrap before runBootstrapAgent (chicken-and-egg guard per F-3r.4).
 */
export function detectAnyModelKey(): boolean {
  if (process.env.DEEPSEEK_API_KEY) return true;
  try {
    const auth = readAuth();
    if (auth?.providers) {
      for (const [name, entry] of Object.entries(auth.providers)) {
        if (isAllowedRuntimeProviderEntry(name, entry)) return true;
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
    if (isReservedDirectProviderName(spec)) {
      throw new Error(directProviderDisabledMessage(spec));
    }
    throw new Error(
      `Invalid model spec '${spec}': must be '<provider>:<modelId>' (e.g. 'deepseek:deepseek-v4-flash').`,
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
 * P-71: Resolve the API key for an in-scope provider. Direct Anthropic/OpenAI env
 * vars are intentionally ignored; DeepSeek env remains the approved default path.
 */
function resolveModelKey(provider: string, entry: ProviderEntry): string {
  if (provider === "deepseek" && process.env.DEEPSEEK_API_KEY) {
    return process.env.DEEPSEEK_API_KEY;
  }
  return entry.key;
}

function configuredProviderList(auth: AuthJson | null): string {
  const configured = Object.keys(auth?.providers ?? {});
  return configured.length > 0 ? configured.join(", ") : "(none)";
}

function specSource(spec: string): string {
  return spec === process.env.MAI_MODEL
    ? "the MAI_MODEL env var"
    : spec === readAuthJsonDefault()
      ? "the auth.json / secrets.json default"
      : "a CLI flag or the built-in default";
}

function directProviderDisabledMessage(provider: string, auth?: AuthJson | null, spec?: string): string {
  const normalized = normalizeProviderName(provider);
  const source = spec ? ` (model spec came from ${specSource(spec)})` : "";
  const configured = auth === undefined ? "" : ` Configured providers: ${configuredProviderList(auth)}.`;
  const preP21Hint =
    normalized === "openai"
      ? " This looks like a pre-P-21 model spec if it was meant for DeepSeek/custom OpenAI-compatible routing; migrate it to 'deepseek:<modelId>' or another non-reserved provider name."
      : "";
  return (
    `Direct provider '${provider}' is scope-disabled in P-71${source}.` +
    `${configured}${preP21Hint} ` +
    "Use 'deepseek:<modelId>' with DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL, or configure a non-official " +
    "OpenAI-compatible custom provider with: mai auth set https://api.deepseek.com/v1 --key <key> --model-id <modelId> --name deepseek --default."
  );
}

function notConfiguredMessage(provider: string, auth: AuthJson | null, spec: string): string {
  const preP21Hint =
    normalizeProviderName(provider) === "openai"
      ? "\n  This looks like a pre-P-21 model spec — 'openai' was the Vercel adapter name " +
        "before P-21. The format is now '<your-provider-name>:<modelId>'."
      : "";
  return (
    `Provider '${provider}' is not configured (model spec came from ${specSource(spec)}). ` +
    `Configured providers: ${configuredProviderList(auth)}.${preP21Hint}\n` +
    "  Configure DeepSeek/custom OpenAI-compatible routing with: " +
    "mai auth set https://api.deepseek.com/v1 --key <key> --model-id <modelId> --name deepseek --default"
  );
}

function runtimeDeepSeekEntry(provider: string, entry: ProviderEntry | undefined): ProviderEntry | undefined {
  if (provider !== "deepseek") return entry;
  if (entry) return entry;
  if (!process.env.DEEPSEEK_API_KEY) return undefined;
  return {
    key: process.env.DEEPSEEK_API_KEY,
    baseUrl: normalizeDeepSeekBaseUrl(process.env.DEEPSEEK_BASE_URL ?? DEFAULT_DEEPSEEK_BASE_URL),
    type: "openai",
  };
}

function resolveModelBaseUrl(provider: string, entry: ProviderEntry): string {
  const normalizedProvider = normalizeProviderName(provider);
  const baseUrl =
    normalizedProvider === "deepseek"
      ? normalizeDeepSeekBaseUrl(process.env.DEEPSEEK_BASE_URL ?? entry.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL)
      : entry.baseUrl?.trim();
  if (!baseUrl) {
    throw new Error(
      `Provider '${provider}' is missing baseUrl. P-71 blocks OpenAI-compatible providers without a custom baseUrl because the SDK would otherwise fall back to the official OpenAI endpoint. Configure DeepSeek/custom URL with: mai auth set https://api.deepseek.com/v1 --key <key> --model-id <modelId> --name deepseek --default.`,
    );
  }
  const officialVendor = getOfficialDirectProviderBaseUrlVendor(baseUrl);
  if (officialVendor) {
    throw new Error(
      `Provider '${provider}' uses official ${officialVendor} baseUrl '${baseUrl}', which is direct-vendor and scope-disabled in P-71. Use DeepSeek or a non-official OpenAI-compatible custom URL instead.`,
    );
  }
  return baseUrl;
}

function buildModel(spec: string): LanguageModel {
  const { provider, modelId } = parseModelSpec(spec);
  const auth = readAuth();
  if (isReservedDirectProviderName(provider)) {
    throw new Error(directProviderDisabledMessage(provider, auth, spec));
  }
  const entry = runtimeDeepSeekEntry(provider, auth?.providers?.[provider]);
  if (!entry) {
    throw new Error(notConfiguredMessage(provider, auth, spec));
  }

  const type = entry.type ?? "openai"; // migrated entries always have type

  if (type === "anthropic") {
    throw new Error(
      `Provider '${provider}' is configured as direct Anthropic, which is scope-disabled in P-71. ` +
        "Keep the legacy entry if needed for removal/listing, but use DeepSeek or a non-official OpenAI-compatible custom provider for runtime.",
    );
  }

  const key = resolveModelKey(provider, entry);
  const baseURL = resolveModelBaseUrl(provider, entry);
  const fetchFn = DEEPSEEK_THINKING_DEFAULT_MODELS.has(modelId) ? makeNoThinkingFetch(modelId) : undefined;
  return createOpenAI({
    baseURL,
    apiKey: key,
    compatibility: "compatible",
    name: provider,
    ...(fetchFn ? { fetch: fetchFn } : {}),
  })(modelId);
}
