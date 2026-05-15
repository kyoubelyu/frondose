/** P-24: consolidated secrets store at ~/.mai/agent/secrets.json (plan §6.1).
 *
 * Atomicity invariant: every write goes through tmp+rename+chmod 600.
 * tmp file is also created with mode 0o600 to minimize the visibility window
 * during the brief moment between writeFileSync and the post-rename chmod.
 *
 * Read invariant: if secrets.json exists, it WINS — legacy auth/github/search
 * files are never consulted. If secrets.json is absent, the function migrates
 * in-memory from legacy files (B-3 env-overridable for tests), writes
 * secrets.json atomically, and returns the merged shape.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type AuthJson, DEFAULT_AUTH_PATH, migrateProviderEntry } from "./auth.js";
import { DEFAULT_GITHUB_CONFIG_PATH } from "./github.js";
import { DEFAULT_SEARCH_CONFIG_PATH } from "./search.js";

// Inline provider schema — duplicated from auth.ts to break the secrets.ts ↔
// auth.ts top-level circular import (TDZ on z.object construction). Identical
// shape; the function-level imports above (DEFAULT_AUTH_PATH, migrateProviderEntry)
// are safe because they are not accessed at module-init time.
const providerEntrySchema = z.object({
  key: z.string().min(1),
  baseUrl: z.string().url().optional(),
  type: z.enum(["openai", "anthropic"]).optional(),
});

export const DEFAULT_SECRETS_PATH = (): string => join(homedir(), ".mai", "agent", "secrets.json");

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
  server: z.object({ token: z.string().min(1).optional() }).optional(),
});
export type SecretsJson = z.infer<typeof secretsJsonSchema>;

const EMPTY_SECRETS: SecretsJson = { schema_version: 1 };

function tryReadJson<T>(path: string, schema: z.ZodType<T>, label: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return schema.parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch (e) {
    process.stderr.write(
      `[mai] ${label} at ${path} corrupt or invalid: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
}

/** Legacy-path overrides forwarded to `legacyMerged()` on first-read fallback.
 *  Used by the auth/github/search shims to thread test-injected legacy paths
 *  through to the migration step — without this, tests that call
 *  `readAuth(tmpDir/auth.json)` would have `legacyMerged` reach back to the
 *  operator's real `~/.mai/auth.json` (test pollution). */
export interface LegacyPathOverrides {
  authPath?: string;
  githubPath?: string;
  searchPath?: string;
}

/** Read secrets.json with one-shot legacy fallback. */
export function readSecrets(path: string = DEFAULT_SECRETS_PATH(), legacy?: LegacyPathOverrides): SecretsJson {
  // (1) Happy path: new file exists.
  const fresh = tryReadJson(path, secretsJsonSchema, "secrets.json");
  if (fresh !== null) return migrateProviders(fresh);

  // (2) Legacy fallback — gather, merge, write, return.
  const merged = legacyMerged(
    legacy?.authPath ?? process.env.MAI_LEGACY_AUTH_PATH ?? DEFAULT_AUTH_PATH(),
    legacy?.githubPath ?? process.env.MAI_LEGACY_GITHUB_PATH ?? DEFAULT_GITHUB_CONFIG_PATH(),
    legacy?.searchPath ?? process.env.MAI_LEGACY_SEARCH_PATH ?? DEFAULT_SEARCH_CONFIG_PATH(),
  );
  // Check ALL meaningful legacy fields (P-21 `default` / `visionModel` flow
  // through `default` + `visionModel`; P-15 fields through github/search). If
  // none, skip the migration write and return empty defaults.
  if (
    merged.default === undefined &&
    merged.visionModel === undefined &&
    merged.providers === undefined &&
    merged.github === undefined &&
    merged.search === undefined
  ) {
    return EMPTY_SECRETS;
  }
  // One-shot migration write.
  writeSecrets(merged, path);
  return merged;
}

/** Internal: read legacy auth/github/search and synthesize a SecretsJson.
 *
 * Step-3b B-3 DI: each legacy path defaults to its standard location BUT is
 * overridable via MAI_LEGACY_*_PATH env vars. Test-only mechanism (NOT part
 * of operator contract — see plan §8 N-1).
 */
export function legacyMerged(
  authPath: string = process.env.MAI_LEGACY_AUTH_PATH ?? DEFAULT_AUTH_PATH(),
  githubPath: string = process.env.MAI_LEGACY_GITHUB_PATH ?? DEFAULT_GITHUB_CONFIG_PATH(),
  searchPath: string = process.env.MAI_LEGACY_SEARCH_PATH ?? DEFAULT_SEARCH_CONFIG_PATH(),
): SecretsJson {
  const authLegacy = tryReadJson(
    authPath,
    z.object({
      default: z.string().min(1).optional(),
      visionModel: z.string().min(1).optional(),
      providers: z.record(z.string().min(1), providerEntrySchema).optional(),
    }) as z.ZodType<AuthJson>,
    "auth.json",
  );
  const ghLegacy = tryReadJson(githubPath, githubSubSchema, "github.json");
  const searchLegacy = tryReadJson(searchPath, searchSubSchema, "search.json");

  const out: SecretsJson = { schema_version: 1 };
  if (authLegacy) {
    if (authLegacy.default) out.default = authLegacy.default;
    if (authLegacy.visionModel) out.visionModel = authLegacy.visionModel;
    if (authLegacy.providers) out.providers = authLegacy.providers;
  }
  if (ghLegacy && (ghLegacy.token || ghLegacy.repo)) out.github = ghLegacy;
  if (searchLegacy && (searchLegacy.braveApiKey || searchLegacy.tavilyApiKey)) {
    out.search = searchLegacy;
  }
  return migrateProviders(out);
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
