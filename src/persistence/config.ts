/** P-24: non-secret operator config at ~/.mai/agent/config.json (plan §6.2).
 *
 * Migration: on first read where config.json is absent, reads
 * ~/.mai/agent/telegram.json for {enabled, boundUserId, proxyUrl} and writes
 * config.json with those values (only if any of the three is non-default).
 * Legacy telegram.json is NOT deleted (P-25 GC).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

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
});

const workerSubSchema = z.object({
  id: z.string().min(1).nullable().default(null),
  hostname: z.string().min(1).nullable().default(null),
  label: z.string().min(1).nullable().default(null),
});

const telegramSubSchema = z.object({
  enabled: z.boolean().default(false),
  boundUserId: z.number().int().nullable().default(null),
  proxyUrl: z.string().nullable().default(null),
});

export const configJsonSchema = z.object({
  schema_version: z.literal(1),
  server: serverSubSchema.default({ url: null, bind_address: null, poll_interval_s: 30 }),
  worker: workerSubSchema.default({ id: null, hostname: null, label: null }),
  telegram: telegramSubSchema.default({ enabled: false, boundUserId: null, proxyUrl: null }),
});
export type ConfigJson = z.infer<typeof configJsonSchema>;

const DEFAULT_CONFIG: ConfigJson = {
  schema_version: 1,
  server: { url: null, bind_address: null, poll_interval_s: 30 },
  worker: { id: null, hostname: null, label: null },
  telegram: { enabled: false, boundUserId: null, proxyUrl: null },
};

export function readConfig(path: string = DEFAULT_CONFIG_PATH()): ConfigJson {
  if (existsSync(path)) {
    try {
      return configJsonSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
    } catch (e) {
      process.stderr.write(`[mai] config.json corrupt or invalid: ${e instanceof Error ? e.message : String(e)}\n`);
      return DEFAULT_CONFIG;
    }
  }
  // Migration from legacy telegram.json.{enabled,boundUserId,proxyUrl}.
  const migrated = migrateTelegramIntoConfig();
  // Only write if migration actually produced non-default content.
  if (migrated.telegram.enabled || migrated.telegram.boundUserId !== null || migrated.telegram.proxyUrl !== null) {
    writeConfig(migrated, path);
  }
  return migrated;
}

export function writeConfig(cfg: ConfigJson, path: string = DEFAULT_CONFIG_PATH()): void {
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
 */
export function migrateTelegramIntoConfig(
  tcPath: string = join(homedir(), ".mai", "agent", "telegram.json"),
): ConfigJson {
  if (!existsSync(tcPath)) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(tcPath, "utf-8")) as Record<string, unknown>;
    return {
      ...DEFAULT_CONFIG,
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
    return DEFAULT_CONFIG;
  }
}

/** P-24 NEW: write config-level telegram fields (enabled / boundUserId / proxyUrl).
 *
 * Re-export shim from telegramConfig.ts (canonical location per plan §6.4).
 * Scaffold tests import from config.ts (validator's Step-4a placement);
 * config.ts re-exports the real impl so both import paths resolve.
 */
export { writeTelegramConfigFields } from "./telegramConfig.js";
