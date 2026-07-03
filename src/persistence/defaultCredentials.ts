/** P-EMBED-KEYS: build-time-embedded DEFAULT credentials for internal-test (内测) installs.
 *
 * `scripts/gen-default-credentials.ts` (wired into `npm run build` / `build:tauri` before
 * `tsc`) reads FRONDOSE_DEFAULT_LLM_BASEURL / _MODEL / _KEY / FRONDOSE_DEFAULT_BRAVE_KEY at
 * BUILD time and writes a gitignored JSON sidecar next to this module (co-located, so the
 * SAME relative lookup resolves whether this code runs from `src/` via tsx, dev, or from the
 * compiled `dist/` sidecar shipped in the .app — `import.meta.url`-relative, no path-shape
 * assumptions). A normal dev/CI build never sets those env vars, so the generated file is
 * either absent or all-null, and this reader returns nulls — IDENTICAL to today's behavior.
 * Real values are injected ONLY at the operator's release build; the generated file is never
 * committed (see .gitignore) and no key material lives in this source file.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DefaultCredentials {
  llmBaseUrl: string | null;
  llmModel: string | null;
  llmKey: string | null;
  braveKey: string | null;
}

const EMPTY_DEFAULTS: DefaultCredentials = { llmBaseUrl: null, llmModel: null, llmKey: null, braveKey: null };

const GENERATED_FILENAME = "defaultCredentials.generated.json";

export const DEFAULT_CREDENTIALS_PATH = (): string => join(dirname(fileURLToPath(import.meta.url)), GENERATED_FILENAME);

function asNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/** Read the build-embedded defaults. Missing file / unset env at build time / corrupt
 *  JSON all resolve to {@link EMPTY_DEFAULTS} — never throws. */
export function readDefaultCredentials(path: string = DEFAULT_CREDENTIALS_PATH()): DefaultCredentials {
  if (!existsSync(path)) return EMPTY_DEFAULTS;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return {
      llmBaseUrl: asNonEmptyString(raw.llmBaseUrl),
      llmModel: asNonEmptyString(raw.llmModel),
      llmKey: asNonEmptyString(raw.llmKey),
      braveKey: asNonEmptyString(raw.braveKey),
    };
  } catch {
    return EMPTY_DEFAULTS;
  }
}
