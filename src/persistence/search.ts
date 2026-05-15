/** P-15 + P-24: search config (Brave / Tavily API keys) — shim to secrets.json.
 *
 * P-24 (plan §6.3 pattern): `readSearchConfig` / `writeSearchConfig` route
 * through `readSecrets` / `writeSecrets` co-located with the supplied path
 * (production → DEFAULT_SECRETS_PATH; tests pass tmpDir/search.json which
 * derives tmpDir/secrets.json). C-1 RMW preserves sibling fields on write.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DEFAULT_SECRETS_PATH, readSecrets, type SecretsJson, writeSecrets } from "./secrets.js";

export const DEFAULT_SEARCH_CONFIG_PATH = (): string => join(homedir(), ".mai", "agent", "search.json");

export const searchConfigSchema = z.object({
  braveApiKey: z.string().min(1).optional(),
  tavilyApiKey: z.string().min(1).optional(),
});
export type SearchConfig = z.infer<typeof searchConfigSchema>;

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {};

/** Derive the secrets path co-located with the given legacy search path. */
function searchPathToSecretsPath(path: string): string {
  if (path === DEFAULT_SEARCH_CONFIG_PATH()) return DEFAULT_SECRETS_PATH();
  return join(dirname(path), "secrets.json");
}

export function readSearchConfig(path: string = DEFAULT_SEARCH_CONFIG_PATH()): SearchConfig {
  const s = readSecrets(searchPathToSecretsPath(path), { searchPath: path });
  return s.search ?? { ...DEFAULT_SEARCH_CONFIG };
}

export function writeSearchConfig(cfg: SearchConfig, path: string = DEFAULT_SEARCH_CONFIG_PATH()): void {
  const secretsPath = searchPathToSecretsPath(path);
  const s = readSecrets(secretsPath, { searchPath: path });
  const merged: SecretsJson = {
    ...s,
    schema_version: 1,
    search: cfg.braveApiKey || cfg.tavilyApiKey ? cfg : undefined,
  };
  writeSecrets(merged, secretsPath);
}
