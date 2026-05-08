import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Inline .env reader — populates process.env from <cwd>/.env without clobbering
 * pre-existing keys. Silent: no logging.
 *
 * Skip via env: MAI_DOTENV=skip.
 * Format: KEY=VALUE; lines starting with # are comments; blank lines OK.
 * NO quote stripping; NO ${VAR} interpolation; NO multi-line values.
 */
export function loadDotenv(cwd: string): void {
  if (process.env.MAI_DOTENV === "skip") return;
  const envPath = resolve(cwd, ".env");
  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = val;
    }
  }
}
