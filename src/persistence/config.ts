/** P-24: non-secret operator config at ~/.mai/agent/config.json (plan §6.2).
 *
 * Migration: on first read where config.json is absent, reads
 * ~/.mai/agent/telegram.json for {enabled, boundUserId, proxyUrl} and writes
 * config.json with those values (only if any of the three is non-default).
 * Legacy telegram.json is NOT deleted (P-25 GC).
 *
 * P-28: config.json schema v1 → v2. v2 absorbs the worker `identity` record
 * (folded from identity.json) and `soul.override` (folded from the formerly
 * write-only soul_band_override.txt). `readConfig` version-dispatches on the
 * RAW JSON's `schema_version` BEFORE any Zod parse (D-5).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type IdentityRecord, identityRecordSchema } from "./identitySchema.js";

export const DEFAULT_CONFIG_PATH = (): string => join(homedir(), ".mai", "agent", "config.json");

// Step-3b round-2 C-1: server.token MOVED to secrets.json. config.json.server
// holds only the public URL.
// P-26: `bind_address` (Tailscale-private listen addr; default null → 127.0.0.1)
//        and `poll_interval_s` (worker long-poll cadence; 5..120 sec, default 30)
//        added as optional fields. Existing P-24 configs parse unchanged.
const serverSubSchema = z.object({
  url: z.string().url().nullable().default(null),
  bind_address: z.string().nullable().default(null),
  poll_interval_s: z.number().int().min(5).max(120).default(30),
  // P-29: web dashboard listener port (additive; existing configs Zod-fill the default).
  web_port: z.number().int().min(1024).max(65535).default(8090),
  // P-30: SSH terminal — user (null → OS user of the server process) + port.
  ssh_user: z.string().min(1).nullable().default(null),
  ssh_port: z.number().int().min(1).max(65535).default(22),
  // P-36 F-D2 stub: REST API listener port (additive; existing configs Zod-fill the default).
  rest_port: z.number().int().min(1024).max(65535).default(3031),
});

const workerSubSchema = z.object({
  id: z.string().min(1).nullable().default(null),
  hostname: z.string().min(1).nullable().default(null),
  label: z.string().min(1).nullable().default(null),
  input_mode: z.enum(["cdp", "hardware"]).default("cdp"), // P-32: additive; existing configs get default "cdp"
});

const telegramSubSchema = z.object({
  enabled: z.boolean().default(false),
  boundUserId: z.number().int().nullable().default(null),
  proxyUrl: z.string().nullable().default(null),
});

// P-28: replaces the write-only soul_band_override.txt. When `override` is
// non-null, main.ts uses it as the WHOLE soul band instead of composeSoulBand.
const soulSubSchema = z.object({
  override: z.string().max(3000).nullable().default(null),
});

export const configJsonSchemaV2 = z.object({
  schema_version: z.literal(2),
  server: serverSubSchema.default({ url: null, bind_address: null, poll_interval_s: 30 }),
  worker: workerSubSchema.default({ id: null, hostname: null, label: null }),
  telegram: telegramSubSchema.default({ enabled: false, boundUserId: null, proxyUrl: null }),
  identity: identityRecordSchema.optional(), // P-28: folded from identity.json
  soul: soulSubSchema.default({ override: null }), // P-28: folded from soul_band_override.txt
});
export type ConfigJsonV2 = z.infer<typeof configJsonSchemaV2>;

// D-6: deprecated aliases — keep existing `configJsonSchema` / `ConfigJson` imports compiling.
export const configJsonSchema = configJsonSchemaV2;
export type ConfigJson = ConfigJsonV2;

// P-28: v1 schema — internal, migration input only.
const configJsonSchemaV1 = z.object({
  schema_version: z.literal(1),
  server: serverSubSchema.default({ url: null, bind_address: null, poll_interval_s: 30 }),
  worker: workerSubSchema.default({ id: null, hostname: null, label: null }),
  telegram: telegramSubSchema.default({ enabled: false, boundUserId: null, proxyUrl: null }),
});
type ConfigJsonV1 = z.infer<typeof configJsonSchemaV1>;

const DEFAULT_CONFIG_V2: ConfigJsonV2 = {
  schema_version: 2,
  server: { url: null, bind_address: null, poll_interval_s: 30, web_port: 8090, ssh_user: null, ssh_port: 22, rest_port: 3031 },
  worker: { id: null, hostname: null, label: null, input_mode: "cdp" }, // P-32: input_mode added
  telegram: { enabled: false, boundUserId: null, proxyUrl: null },
  soul: { override: null },
  // identity intentionally omitted (optional).
};

export function readConfig(path: string = DEFAULT_CONFIG_PATH()): ConfigJsonV2 {
  if (!existsSync(path)) {
    // First-run: migrate from legacy telegram.json (P-24 path), now returns v2.
    const migrated = migrateTelegramIntoConfig();
    if (migrated.telegram.enabled || migrated.telegram.boundUserId !== null || migrated.telegram.proxyUrl !== null) {
      writeConfig(migrated, path);
    }
    return migrated;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    process.stderr.write(`[mai] config.json corrupt or invalid: ${e instanceof Error ? e.message : String(e)}\n`);
    return DEFAULT_CONFIG_V2;
  }

  // D-5: version-dispatch on RAW JSON before any Zod parse.
  const ver = (raw as { schema_version?: unknown }).schema_version;
  if (ver === 1) {
    const migrated = migrateV1toV2(raw, path);
    writeConfig(migrated, path); // overwrite on disk with v2 — migration persisted (G-P28.5)
    return migrated;
  }

  try {
    return configJsonSchemaV2.parse(raw);
  } catch (e) {
    process.stderr.write(`[mai] config.json invalid: ${e instanceof Error ? e.message : String(e)}\n`);
    return DEFAULT_CONFIG_V2;
  }
}

/** v1 → v2: fold sibling identity.json + soul_band_override.txt into the config.
 *  Legacy files are NOT deleted (P-29 GC). Identity/soul paths are derived from
 *  the config's OWN directory so worker (~/.mai/agent) and server (~/.mai/server)
 *  configs migrate against their own siblings (G-P28.7). */
function migrateV1toV2(rawV1: unknown, configPath: string): ConfigJsonV2 {
  // Parse v1 leniently — on failure fall back to a hardcoded default (C-1: do NOT
  // call .parse() in the fallback — it could itself throw and escape readConfig).
  const v1 = configJsonSchemaV1.safeParse(rawV1);
  const base: ConfigJsonV1 = v1.success
    ? v1.data
    : {
        schema_version: 1,
        server: { url: null, bind_address: null, poll_interval_s: 30, web_port: 8090, ssh_user: null, ssh_port: 22, rest_port: 3031 },
        worker: { id: null, hostname: null, label: null, input_mode: "cdp" as const },
        telegram: { enabled: false, boundUserId: null, proxyUrl: null },
      };

  const dir = dirname(configPath);

  // Fold identity.json (sibling). safeParse → undefined on shape mismatch
  // (server's identity.json is a ServerIdentity, not an IdentityRecord — G-P28.7).
  let identity: IdentityRecord | undefined;
  const identityPath = join(dir, "identity.json");
  if (existsSync(identityPath)) {
    try {
      const parsed = identityRecordSchema.safeParse(JSON.parse(readFileSync(identityPath, "utf-8")));
      if (parsed.success) identity = parsed.data;
    } catch {
      // leave undefined — corrupt legacy identity.json
    }
  }

  // Fold soul_band_override.txt (sibling).
  let soulOverride: string | null = null;
  const overridePath = join(dir, "soul_band_override.txt");
  if (existsSync(overridePath)) {
    try {
      soulOverride = readFileSync(overridePath, "utf-8").trim() || null;
    } catch {
      // leave null
    }
  }

  return {
    schema_version: 2,
    server: base.server,
    worker: base.worker,
    telegram: base.telegram,
    identity,
    soul: { override: soulOverride },
  };
}

export function writeConfig(cfg: ConfigJsonV2, path: string = DEFAULT_CONFIG_PATH()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf-8");
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp already cleaned up — best-effort.
    }
    throw e;
  }
  // No chmod — config.json carries no secrets (server.token lives in secrets.json).
}

/** Read legacy ~/.mai/agent/telegram.json and extract {enabled, boundUserId, proxyUrl}.
 *
 * Step-3b C-2 fix: emit stderr warning on parse error (was silent). Mirrors
 * `tryReadJson` in secrets.ts so operators see why their telegram settings
 * could not be migrated.
 *
 * P-28: returns ConfigJsonV2 (spreads DEFAULT_CONFIG_V2).
 */
export function migrateTelegramIntoConfig(
  tcPath: string = join(homedir(), ".mai", "agent", "telegram.json"),
): ConfigJsonV2 {
  if (!existsSync(tcPath)) return DEFAULT_CONFIG_V2;
  try {
    const raw = JSON.parse(readFileSync(tcPath, "utf-8")) as Record<string, unknown>;
    return {
      ...DEFAULT_CONFIG_V2,
      telegram: {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : false,
        boundUserId: typeof raw.boundUserId === "number" ? raw.boundUserId : null,
        proxyUrl: typeof raw.proxyUrl === "string" ? raw.proxyUrl : null,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `[mai] telegram.json migration parse error: ${msg}; settings not migrated — run \`mai telegram\` to reconfigure.\n`,
    );
    return DEFAULT_CONFIG_V2;
  }
}

/** P-24 NEW: write config-level telegram fields (enabled / boundUserId / proxyUrl).
 *
 * Re-export shim from telegramConfig.ts (canonical location per plan §6.4).
 * Scaffold tests import from config.ts (validator's Step-4a placement);
 * config.ts re-exports the real impl so both import paths resolve.
 */
export { writeTelegramConfigFields } from "./telegramConfig.js";
