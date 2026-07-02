import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
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
export const LLM_STREAM_IDLE_MS = 30_000;
export const LLM_STREAM_MAX_RETRIES = 2;
/**
 * [P-THINK] Reasoning effort passed to stream() to turn DeepSeek thinking ON. Proven live against
 * api.deepseek.com (deepseek-v4-flash / -chat / -reasoner all emit thinking_delta at "low").
 * NOTE: the loop drives the LOW-LEVEL stream() (which reads `reasoningEffort`, not `reasoning` —
 * that clamp only happens in streamSimple), so this value is passed as `reasoningEffort`.
 */
const REASONING_LEVEL: ThinkingLevel = "low";

export interface PiModelResolution {
  model: Model<"openai-completions">;
  apiKey: string;
  /** [P-THINK] Reasoning effort the loop passes to stream() as `reasoningEffort` to enable thinking. */
  reasoningLevel: ThinkingLevel;
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
    // [P-THINK] Reasoning ON (reverses v0.4-fix1's disable). Pi replays reasoning_content on
    // assistant messages natively via the deepseek compat flags below, so the multi-step tool
    // turn no longer 400s on step 2 (that was a Vercel-@ai-sdk/openai gap, absent from the Pi path).
    reasoning: true,
    // Set EXPLICITLY rather than relying on URL auto-detect: production runs a custom proxy baseUrl
    // where only provider==="deepseek" (not the URL) would trip auto-detection. thinkingFormat
    // "deepseek" sends thinking:{type:"enabled"}; requiresReasoningContentOnAssistantMessages makes
    // pi replay an (empty) reasoning_content on every assistant message so DeepSeek accepts the history.
    compat: { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 8192,
  };

  return { model, apiKey, reasoningLevel: REASONING_LEVEL, timeoutMs: LLM_COMPLETE_TIMEOUT_MS };
}
