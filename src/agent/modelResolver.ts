import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

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

function buildModel(spec: string): LanguageModel {
  const { provider, modelId } = parseModelSpec(spec);
  if (provider === "anthropic") {
    return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(modelId);
  }
  if (provider === "openai") {
    if (modelId.startsWith("deepseek")) {
      const rawBase = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
      // Normalize: strip trailing /v1 (with optional trailing slash) so we don't
      // produce https://api.deepseek.com/v1/v1/chat/completions when operator
      // sets DEEPSEEK_BASE_URL=https://api.deepseek.com/v1 (OQ-4).
      const baseURL = `${rawBase.replace(/\/v1\/?$/, "")}/v1`;
      return createOpenAI({
        baseURL,
        apiKey: process.env.DEEPSEEK_API_KEY,
        compatibility: "compatible",
        name: "deepseek",
      })(modelId);
    }
    return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(modelId);
  }
  throw new Error(`Unknown provider '${provider}' in model spec '${spec}'. Supported: 'anthropic', 'openai'.`);
}
