/** P-24: consolidated secrets store at ~/.frondose/agent/secrets.json (plan §6.1).
 *
 * Atomicity invariant: every write goes through tmp+rename+chmod 600.
 * tmp file is also created with mode 0o600 to minimize the visibility window
 * during the brief moment between writeFileSync and the post-rename chmod.
 *
 * Read invariant: secrets.json is the only persisted credential source. If it
 * is absent or invalid, reading starts from an empty current schema and does not
 * write an empty file. Any
 * embedded-default field (P-EMBED-KEYS) still unset on the result is backfilled
 * per-field (never overwriting a configured field) and persisted if it changed.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isDeepSeekBaseUrl, isOfficialDirectProviderBaseUrl, migrateProviderEntry } from "./auth.js";
import { readDefaultCredentials } from "./defaultCredentials.js";
import { readJsonFileSync } from "./jsonFile.js";
import { DATA_DIR_NAME, getHomeBase } from "./paths.js";

// Inline provider schema — duplicated from auth.ts to break the secrets.ts ↔
// auth.ts top-level circular import (TDZ on z.object construction). Identical
// shape; the function-level migrateProviderEntry import is safe because it is
// not accessed at module-init time.
const providerEntrySchema = z.object({
  key: z.string().min(1),
  baseUrl: z.string().url().optional(),
  type: z.enum(["openai", "anthropic"]).optional(),
});

export const DEFAULT_SECRETS_PATH = (): string => join(getHomeBase(), DATA_DIR_NAME, "agent", "secrets.json");

const githubSubSchema = z.object({
  token: z.string().min(1).optional(),
  repo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .optional(),
});

const searchSubSchema = z.object({
  braveApiKey: z.string().min(1).optional(),
  tavilyApiKey: z.string().min(1).optional(),
});

export const secretsJsonSchema = z.object({
  schema_version: z.literal(1),
  default: z.string().min(1).optional(),
  visionModel: z.string().min(1).optional(),
  providers: z.record(z.string().min(1), providerEntrySchema).optional(),
  github: githubSubSchema.optional(),
  search: searchSubSchema.optional(),
  // Step-3b round-2 C-1: server.token lives here (chmod 600), NOT in config.json.
  // P-24 leaves this undefined; P-25 `mai server set` populates via writeSecrets.
  // P-29: webToken — Basic-Auth secret for the web dashboard (optional).
  server: z
    .object({
      token: z.string().min(1).optional(),
      webToken: z.string().min(1).optional(),
    })
    .optional(),
});
export type SecretsJson = z.infer<typeof secretsJsonSchema>;

const EMPTY_SECRETS: SecretsJson = { schema_version: 1 };

function tryReadJson<T>(path: string, schema: z.ZodType<T>, label: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return schema.parse(readJsonFileSync(path));
  } catch (e) {
    process.stderr.write(
      `[frondose] ${label} at ${path} corrupt or invalid: ${e instanceof Error ? e.message : String(e)}\n` +
        '  Expected: {"schema_version":1,"providers":{"<name>":{"key":"...","type":"anthropic|openai"}}}\n',
    );
    return null;
  }
}

export interface ReadSecretsOptions {
  // P-EMBED-KEYS: injectable path for the build-embedded default-credentials JSON (tests only —
  // production always resolves the co-located defaultCredentials.generated.json via import.meta.url).
  defaultCredentialsPath?: string;
}

/** Read the current consolidated secrets file and approved embedded defaults. */
export function readSecrets(path: string = DEFAULT_SECRETS_PATH(), options?: ReadSecretsOptions): SecretsJson {
  const fresh = tryReadJson(path, secretsJsonSchema, "secrets.json");
  const base = fresh === null ? EMPTY_SECRETS : migrateProviders(fresh);
  const withDefaults = applyDefaultCredentials(base, options?.defaultCredentialsPath);
  if (withDefaults !== base) writeSecrets(withDefaults, path);
  return withDefaults;
}

/** P-EMBED-KEYS: layer in the build-embedded default LLM provider, but ONLY for
 *  fields still unset on `s` — never overrides the current file's values. */
function applyDefaultCredentials(s: SecretsJson, path?: string): SecretsJson {
  const defaults = readDefaultCredentials(path);
  let next = s;
  if (!next.providers && defaults.llmKey && defaults.llmModel && defaults.llmBaseUrl) {
    if (isOfficialDirectProviderBaseUrl(defaults.llmBaseUrl)) {
      // Scope-lock (P-71 / CLAUDE.md provider scope lock): never seed a reserved direct-vendor
      // baseUrl, even from the build-embedded default — same rule buildModel() enforces at read time.
      process.stderr.write(
        "[frondose] embedded default LLM baseUrl is a reserved direct-vendor host — refusing to seed it.\n",
      );
    } else {
      const providerName = isDeepSeekBaseUrl(defaults.llmBaseUrl) ? "deepseek" : "custom";
      next = {
        ...next,
        providers: { [providerName]: { key: defaults.llmKey, baseUrl: defaults.llmBaseUrl, type: "openai" } },
        default: next.default ?? `${providerName}:${defaults.llmModel}`,
      };
    }
  }
  return next;
}

/** Apply P-21's per-provider type/baseUrl migration to providers (in-memory). */
function migrateProviders(s: SecretsJson): SecretsJson {
  if (!s.providers) return s;
  const migrated: Record<string, ReturnType<typeof migrateProviderEntry>> = {};
  for (const [name, entry] of Object.entries(s.providers)) {
    migrated[name] = migrateProviderEntry(name, entry);
  }
  return { ...s, providers: migrated };
}

/** Atomic write: tmp+rename+chmod 600. */
export function writeSecrets(secrets: SecretsJson, path: string = DEFAULT_SECRETS_PATH()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const data = JSON.stringify(secrets, null, 2);
  // mode 0o600 on tmp creation closes the visibility window before the
  // post-rename chmod; renameSync preserves the source inode (and its mode).
  writeFileSync(tmp, data, { encoding: "utf-8", mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (e) {
    // Cleanup tmp on rename failure so we don't leak credentials in a stale tmp.
    try {
      unlinkSync(tmp);
    } catch {
      // tmp already cleaned up by the FS — best-effort.
    }
    throw e;
  }
  // Belt-and-suspenders: chmod the destination — covers FS paths where rename
  // onto an existing path preserved the destination's prior (possibly looser) mode.
  chmodSync(path, 0o600);
}
