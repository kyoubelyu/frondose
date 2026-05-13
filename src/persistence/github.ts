import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

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

export function readGithubConfig(path: string = DEFAULT_GITHUB_CONFIG_PATH()): GithubConfig {
  if (!existsSync(path)) return { ...DEFAULT_GITHUB_CONFIG };
  try {
    const raw = readFileSync(path, "utf-8");
    return githubConfigSchema.parse(JSON.parse(raw));
  } catch (e) {
    process.stderr.write(
      `[mai] github.json corrupt at ${path} (${e instanceof Error ? e.message : String(e)}); using defaults.\n`,
    );
    return { ...DEFAULT_GITHUB_CONFIG };
  }
}

export function writeGithubConfig(cfg: GithubConfig, path: string = DEFAULT_GITHUB_CONFIG_PATH()): void {
  mkdirSync(dirname(path), { recursive: true });
  const data = JSON.stringify(cfg, null, 2);
  const fd = openSync(path, "w", 0o600);
  try {
    writeSync(fd, data, 0, "utf-8");
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

export function maskToken(token: string): string {
  if (token.length <= 4) return "****";
  return `***${token.slice(-4)}`;
}
