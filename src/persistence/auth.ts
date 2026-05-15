/** P-7 + P-21 + P-24: provider auth + secrets shim.
 *
 * P-24 (plan §6.3): `readAuth` / `writeAuth` route through `readSecrets` /
 * `writeSecrets`. The path arg is derived via `authPathToSecretsPath` so
 * tests passing `tmpDir/auth.json` write to `tmpDir/secrets.json`, never
 * touching the operator's real `~/.mai/agent/secrets.json` (B-1 fix).
 *
 * Schemas + `migrateProviderEntry` remain exported here — `secrets.ts`
 * imports `providerEntrySchema` + `migrateProviderEntry` to validate
 * + auto-migrate provider entries inside `secrets.json`.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DEFAULT_SECRETS_PATH, readSecrets, type SecretsJson, writeSecrets } from "./secrets.js";

export const DEFAULT_AUTH_PATH = (): string => join(homedir(), ".mai", "auth.json");

export const providerEntrySchema = z.object({
  key: z.string().min(1),
  baseUrl: z.string().url().optional(),
  type: z.enum(["openai", "anthropic"]).optional(),
});
export type ProviderEntry = z.infer<typeof providerEntrySchema>;

export const authJsonSchema = z.object({
  default: z.string().min(1).optional(),
  visionModel: z.string().min(1).optional(),
  providers: z.record(z.string().min(1), providerEntrySchema).optional(),
});
export type AuthJson = z.infer<typeof authJsonSchema>;

// P-21: well-known provider default base URLs (used for migration + fallback).
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

export const KNOWN_PROVIDER_DEFAULTS: Record<string, string> = {
  anthropic: DEFAULT_ANTHROPIC_BASE_URL,
  openai: DEFAULT_OPENAI_BASE_URL,
  deepseek: DEFAULT_DEEPSEEK_BASE_URL,
};

/** P-21: auto-upgrade old-format provider entries that lack `type` and `baseUrl`. */
export function migrateProviderEntry(name: string, entry: ProviderEntry): ProviderEntry {
  if (entry.type !== undefined) return entry;
  const isAnthropic = name === "anthropic" && (!entry.baseUrl || entry.baseUrl.includes("anthropic"));
  const defaultBaseUrl = KNOWN_PROVIDER_DEFAULTS[name] ?? DEFAULT_OPENAI_BASE_URL;
  return {
    ...entry,
    type: isAnthropic ? "anthropic" : "openai",
    baseUrl: entry.baseUrl ?? defaultBaseUrl,
  };
}

/** Step-3b B-1 helper: derive the secrets path co-located with the given
 *  legacy auth path. Production calls (`authPath === DEFAULT_AUTH_PATH()`)
 *  hit `DEFAULT_SECRETS_PATH()`; test calls (`tmpDir/auth.json`) co-locate
 *  `secrets.json` in the same directory so `writeAuth(data, tmpDir/auth.json)`
 *  writes to `tmpDir/secrets.json`, never the operator's real path. */
export function authPathToSecretsPath(authPath: string): string {
  if (authPath === DEFAULT_AUTH_PATH()) return DEFAULT_SECRETS_PATH();
  return join(dirname(authPath), "secrets.json");
}

/** Read auth.json — actually reads `secrets.json` via the shim. Missing file → null.
 *  Threads `authPath` as the legacy override so test calls `readAuth(tmpDir/auth.json)`
 *  see tmpDir/auth.json on first-read fallback, never the operator's real auth.json. */
export function readAuth(path: string = DEFAULT_AUTH_PATH()): AuthJson | null {
  const s = readSecrets(authPathToSecretsPath(path), { authPath: path });
  if (s.providers === undefined && s.default === undefined && s.visionModel === undefined) {
    return null;
  }
  return {
    default: s.default,
    visionModel: s.visionModel,
    providers: s.providers,
  };
}

/** Write auth fields atomically via secrets.ts. Preserves github/search/server (C-1 RMW). */
export function writeAuth(auth: AuthJson, path: string = DEFAULT_AUTH_PATH()): void {
  const secretsPath = authPathToSecretsPath(path);
  const s = readSecrets(secretsPath, { authPath: path });
  const merged: SecretsJson = {
    schema_version: 1,
    default: auth.default,
    visionModel: auth.visionModel,
    providers: auth.providers,
    github: s.github,
    search: s.search,
    server: s.server, // C-1 RMW: preserve server.token if P-25 has populated it.
  };
  writeSecrets(merged, secretsPath);
}

/**
 * Read a provider's API key.
 * Returns undefined if file missing OR provider not configured.
 * Used by modelResolver.buildModel as fallback when env var absent.
 */
export function readAuthJsonKey(provider: string, path: string = DEFAULT_AUTH_PATH()): string | undefined {
  const auth = readAuth(path);
  return auth?.providers?.[provider]?.key;
}

export function readAuthJsonVisionModel(path: string = DEFAULT_AUTH_PATH()): string | undefined {
  const auth = readAuth(path);
  return auth?.visionModel;
}

/** Mask an API key for `mai auth list` output: keep last 4 chars; replace middle with stars. */
export function maskKey(key: string): string {
  if (key.length <= 4) return "****";
  const last4 = key.slice(-4);
  // Preserve `sk-ant-` style prefix if present.
  const dashIdx = key.indexOf("-", 3);
  if (dashIdx !== -1 && dashIdx < 8) {
    const prefix = key.slice(0, dashIdx + 1);
    return `${prefix}***${last4}`;
  }
  return `***${last4}`;
}
