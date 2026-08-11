/** P-24: non-secret operator config at ~/.frondose/agent/config.json (plan §6.2).
 *
 * Only the current schema-v2 file is accepted. Missing, invalid, and obsolete
 * files yield current defaults in memory without read-time writes or migration.
 */
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { identityRecordSchema } from "./identitySchema.js";
import { readJsonFileSync } from "./jsonFile.js";
import { DATA_DIR_NAME, getHomeBase } from "./paths.js";

export const DEFAULT_CONFIG_PATH = (): string => join(getHomeBase(), DATA_DIR_NAME, "agent", "config.json");
// P-OPEN-SOURCE-SPLIT §13.1: public GitHub Releases default (mirrors updater.rs).
// Explicit null or blank disables updates; any other explicit URL is an operator override.
const DEFAULT_UPDATE_SERVER_URL = "https://github.com/kyoubelyu/frondose/releases/latest/download";

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

// A non-null override replaces the composed Soul band.
const soulSubSchema = z.object({
  override: z.string().max(3000).nullable().default(null),
});

const autoSubSchema = z.object({
  intervalMinutes: z.number().int().min(15).max(1440).default(15),
});

export const configJsonSchemaV2 = z.object({
  schema_version: z.literal(2),
  server: serverSubSchema.default({ url: null, bind_address: null, poll_interval_s: 30 }),
  worker: workerSubSchema.default({ id: null, hostname: null, label: null }),
  telegram: telegramSubSchema.default({ enabled: false, boundUserId: null, proxyUrl: null }),
  identity: identityRecordSchema.optional(),
  soul: soulSubSchema.default({ override: null }),
  // P-58d.1 [3b/CMR-1]: app-native update endpoint. Plaintext, NOT a secret. LENIENT
  // here on purpose — NO .url(): operators hand-edit this field, and readConfig falls
  // through to DEFAULT_CONFIG_V2 on ANY schema failure, so a single typo here must NOT
  // reset all other config. URL shape is validated where it matters:
  // serve/settings.ts settingsPatchSchema (.url(), write-time) + the Rust
  // endpoint.parse() guard. .trim() drops stray whitespace; readConfig maps blank →
  // null (disabled). No schema_version bump (default-value-only change; old configs
  // Zod-fill the public URL).
  updateServerUrl: z.string().trim().nullable().default(DEFAULT_UPDATE_SERVER_URL),
  // P-ZH-1: operator-picked language for the UI chrome + agent reply-language override.
  // "auto" (default) = today's behavior (navigator-detected UI locale, mirror-the-operator
  // replies). Additive optional, NO schema_version bump — old configs Zod-fill "auto".
  language: z.enum(["auto", "en", "zh"]).default("auto"),
  auto: autoSubSchema.optional().default({ intervalMinutes: 15 }),
});
export type ConfigJsonV2 = z.infer<typeof configJsonSchemaV2>;

const DEFAULT_CONFIG_V2: ConfigJsonV2 = {
  schema_version: 2,
  server: {
    url: null,
    bind_address: null,
    poll_interval_s: 30,
    web_port: 8090,
    ssh_user: null,
    ssh_port: 22,
    rest_port: 3031,
  },
  worker: { id: null, hostname: null, label: null, input_mode: "cdp" }, // P-32: input_mode added
  telegram: { enabled: false, boundUserId: null, proxyUrl: null },
  soul: { override: null },
  updateServerUrl: DEFAULT_UPDATE_SERVER_URL, // P-58d.1 / P-OPEN-SOURCE-SPLIT §13.1
  language: "auto", // P-ZH-1
  auto: { intervalMinutes: 15 },
  // identity intentionally omitted (optional).
};

export function readConfig(path: string = DEFAULT_CONFIG_PATH()): ConfigJsonV2 {
  if (!existsSync(path)) {
    return DEFAULT_CONFIG_V2;
  }

  let raw: unknown;
  try {
    raw = readJsonFileSync(path);
  } catch (e) {
    process.stderr.write(`[frondose] config.json corrupt or invalid: ${e instanceof Error ? e.message : String(e)}\n`);
    return DEFAULT_CONFIG_V2;
  }

  try {
    const parsed = configJsonSchemaV2.parse(raw);
    // Blank (after trim) means the operator cleared the field → disabled.
    if (parsed.updateServerUrl === "") {
      parsed.updateServerUrl = null;
    }
    return parsed;
  } catch (e) {
    process.stderr.write(`[frondose] config.json invalid: ${e instanceof Error ? e.message : String(e)}\n`);
    return DEFAULT_CONFIG_V2;
  }
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

/** P-24 NEW: write config-level telegram fields (enabled / boundUserId / proxyUrl).
 *
 * Re-export shim from telegramConfig.ts (canonical location per plan §6.4).
 * Scaffold tests import from config.ts (validator's Step-4a placement);
 * config.ts re-exports the real impl so both import paths resolve.
 */
export { writeTelegramConfigFields } from "./telegramConfig.js";
