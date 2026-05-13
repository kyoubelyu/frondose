import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const DEFAULT_SEARCH_CONFIG_PATH = (): string => join(homedir(), ".mai", "agent", "search.json");

export const searchConfigSchema = z.object({
  braveApiKey: z.string().min(1).optional(),
  tavilyApiKey: z.string().min(1).optional(),
});
export type SearchConfig = z.infer<typeof searchConfigSchema>;

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {};

export function readSearchConfig(path: string = DEFAULT_SEARCH_CONFIG_PATH()): SearchConfig {
  if (!existsSync(path)) return { ...DEFAULT_SEARCH_CONFIG };
  try {
    const raw = readFileSync(path, "utf-8");
    return searchConfigSchema.parse(JSON.parse(raw));
  } catch (e) {
    process.stderr.write(
      `[mai] search.json corrupt at ${path} (${e instanceof Error ? e.message : String(e)}); using defaults.\n`,
    );
    return { ...DEFAULT_SEARCH_CONFIG };
  }
}

export function writeSearchConfig(cfg: SearchConfig, path: string = DEFAULT_SEARCH_CONFIG_PATH()): void {
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
