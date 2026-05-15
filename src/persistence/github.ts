/** P-15 + P-24: github config (token + repo) — shim to secrets.json.
 *
 * P-24 (plan §6.3 pattern): `readGithubConfig` / `writeGithubConfig` route
 * through `readSecrets` / `writeSecrets` co-located with the supplied path
 * (production → DEFAULT_SECRETS_PATH; tests pass tmpDir/github.json which
 * derives tmpDir/secrets.json). The C-1 RMW pattern preserves sibling
 * `providers`/`search`/`server` fields on write.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DEFAULT_SECRETS_PATH, readSecrets, type SecretsJson, writeSecrets } from "./secrets.js";

export const DEFAULT_GITHUB_CONFIG_PATH = (): string => join(homedir(), ".mai", "agent", "github.json");

export const githubConfigSchema = z.object({
  token: z.string().min(1).optional(),
  repo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .optional(),
});
export type GithubConfig = z.infer<typeof githubConfigSchema>;

export const DEFAULT_GITHUB_CONFIG: GithubConfig = {};

/** Derive the secrets path co-located with the given legacy github path. */
function githubPathToSecretsPath(path: string): string {
  if (path === DEFAULT_GITHUB_CONFIG_PATH()) return DEFAULT_SECRETS_PATH();
  return join(dirname(path), "secrets.json");
}

export function readGithubConfig(path: string = DEFAULT_GITHUB_CONFIG_PATH()): GithubConfig {
  const s = readSecrets(githubPathToSecretsPath(path), { githubPath: path });
  return s.github ?? { ...DEFAULT_GITHUB_CONFIG };
}

export function writeGithubConfig(cfg: GithubConfig, path: string = DEFAULT_GITHUB_CONFIG_PATH()): void {
  const secretsPath = githubPathToSecretsPath(path);
  const s = readSecrets(secretsPath, { githubPath: path });
  const merged: SecretsJson = {
    ...s,
    schema_version: 1,
    github: cfg.token || cfg.repo ? cfg : undefined,
  };
  writeSecrets(merged, secretsPath);
}

export function maskToken(token: string): string {
  if (token.length <= 4) return "****";
  return `***${token.slice(-4)}`;
}
