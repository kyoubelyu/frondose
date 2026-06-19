import type { Model } from "@earendil-works/pi-ai";
import { frondoseEnv } from "../../env.js";
import { DEFAULT_SECRETS_PATH, readSecrets } from "../../persistence/secrets.js";

/**
 * [P-PI Gate 2] Resolve the DeepSeek Pi model from the SAME config sources the Vercel
   * path uses — env first (DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / FRONDOSE_MODEL), then
 * secrets.json `providers.deepseek`. Stays within the P-57d single-custom-URL lock:
 * one OpenAI-compatible endpoint (DeepSeek), driven through Pi's `openai-completions`
 * provider instead of @ai-sdk/openai.
 */

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL_ID = "deepseek-v4-flash";
export const LLM_COMPLETE_TIMEOUT_MS = 120_000;
/** DeepSeek models whose thinking output we disable to match the Vercel makeNoThinkingFetch behavior. */
const THINKING_DEFAULT_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);

export interface PiModelResolution {
  model: Model<"openai-completions">;
  apiKey: string;
  /** Pi onPayload hook that injects thinking:disabled for the thinking-default models (parity with Vercel). */
  onPayload: (payload: unknown) => unknown;
  timeoutMs: number;
}

/** Parse a `deepseek:deepseek-v4-flash` style spec to its bare model id. */
function modelIdFromSpec(spec: string | undefined): string {
  if (!spec) return DEFAULT_MODEL_ID;
  const i = spec.indexOf(":");
  return (i >= 0 ? spec.slice(i + 1) : spec).trim() || DEFAULT_MODEL_ID;
}

export function resolvePiModel(secretsPath: string = DEFAULT_SECRETS_PATH()): PiModelResolution {
  let baseUrl = process.env.DEEPSEEK_BASE_URL?.trim();
  let apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    try {
      const secrets = readSecrets(secretsPath);
      const ds = secrets.providers?.deepseek;
      baseUrl = baseUrl || ds?.baseUrl;
      apiKey = apiKey || ds?.key;
    } catch {
      // env-only path; fall through to defaults below
    }
  }
  baseUrl = baseUrl || DEFAULT_BASE_URL;
  if (!apiKey) {
    throw new Error(
      "resolvePiModel: no DeepSeek API key (DEEPSEEK_API_KEY env or secrets.json providers.deepseek.key)",
    );
  }
  const id = modelIdFromSpec(frondoseEnv("MODEL"));

  const model: Model<"openai-completions"> = {
    id,
    name: id,
    api: "openai-completions",
    provider: "deepseek",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 8192,
  };

  const disableThinking = THINKING_DEFAULT_MODELS.has(id);
  const onPayload = (payload: unknown): unknown => {
    // Parity with makeNoThinkingFetch: inject thinking:disabled so DeepSeek-v4 models don't
    // burn tokens on reasoning we don't surface. Idempotent + defensive.
    if (!disableThinking || !payload || typeof payload !== "object") return payload;
    const p = payload as Record<string, unknown>;
    if (!("thinking" in p)) p.thinking = { type: "disabled" };
    return p;
  };

  return { model, apiKey, onPayload, timeoutMs: LLM_COMPLETE_TIMEOUT_MS };
}
