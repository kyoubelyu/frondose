/**
 * P-11 / D-4 / P-24: telegram.json schema + atomic read/write.
 *
 * P-24 split (plan §6.4): `enabled`/`boundUserId`/`proxyUrl` MOVED to
 * `config.json.telegram`. `telegram.json` now holds runtime-only state
 * (`lastUpdateOffset`/`stickyFallbackIp`/poll timeouts/`lastReceivedAt`).
 *
 * `readTelegramConfig` synthesizes the legacy-shape merged struct so the
 * ~12 existing callers (REPL poller, daemon, telegram subcommand, etc.)
 * see the same `TelegramConfig` shape as pre-P-24. Mutations to
 * `enabled`/`boundUserId`/`proxyUrl` go through the new
 * `writeTelegramConfigFields(...)` helper.
 *
 * The pre-P-24 export `telegramConfigSchema` is REMOVED (N-2 plan verification:
 * `grep -rn 'telegramConfigSchema' src/ tests/` showed only telegramConfig.ts
 * internal usage; no external imports). The replacement export is
 * `telegramRuntimeSchema`.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { DEFAULT_CONFIG_PATH, readConfig, writeConfig } from "./config.js";

export const telegramRuntimeSchema = z.object({
  lastUpdateOffset: z.number().int().min(0),
  stickyFallbackIp: z.string().nullable(),
  pollTimeoutSec: z.number().int().min(1).max(60),
  pollBackoffSec: z.number().int().min(1).max(60),
  // P-12 D-5: forward-compat — pre-P-12 files may lack this field.
  lastReceivedAt: z.string().nullable().optional().default(null),
});
export type TelegramRuntime = z.infer<typeof telegramRuntimeSchema>;

const DEFAULT_RUNTIME: TelegramRuntime = {
  lastUpdateOffset: 0,
  stickyFallbackIp: null,
  pollTimeoutSec: 30,
  pollBackoffSec: 5,
  lastReceivedAt: null,
};

/** PRESERVED: the legacy-shape TelegramConfig consumed by ~12 callers. */
export interface TelegramConfig extends TelegramRuntime {
  enabled: boolean;
  boundUserId: number | null;
  proxyUrl: string | null;
}

export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  ...DEFAULT_RUNTIME,
  enabled: false,
  boundUserId: null,
  proxyUrl: null,
};

function readRuntime(tcPath: string): TelegramRuntime {
  if (!existsSync(tcPath)) return { ...DEFAULT_RUNTIME };
  try {
    return telegramRuntimeSchema.parse(JSON.parse(readFileSync(tcPath, "utf-8")));
  } catch (e) {
    process.stderr.write(
      `[mai] telegram.json (runtime) invalid at ${tcPath}: ${e instanceof Error ? e.message : String(e)}; using defaults.\n`,
    );
    return { ...DEFAULT_RUNTIME };
  }
}

/** Read merged config + runtime. Existing callers see the same shape as pre-P-24. */
export function readTelegramConfig(tcPath: string, configPath: string = DEFAULT_CONFIG_PATH()): TelegramConfig {
  const runtime = readRuntime(tcPath);
  const cfg = readConfig(configPath);
  return { ...runtime, ...cfg.telegram };
}

/** Write runtime-only fields. Callers continue to pass the merged shape; this
 *  function projects the runtime subset out and writes only that. */
export function writeTelegramConfig(cfg: TelegramConfig, tcPath: string): void {
  const runtime: TelegramRuntime = {
    lastUpdateOffset: cfg.lastUpdateOffset,
    stickyFallbackIp: cfg.stickyFallbackIp,
    pollTimeoutSec: cfg.pollTimeoutSec,
    pollBackoffSec: cfg.pollBackoffSec,
    lastReceivedAt: cfg.lastReceivedAt ?? null,
  };
  const tmp = `${tcPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(runtime, null, 2), "utf-8");
  renameSync(tmp, tcPath);
}

/** P-24 NEW: write config-level telegram fields (enabled / boundUserId / proxyUrl)
 *  to config.json.telegram. Read-modify-write — preserves sibling fields. */
export function writeTelegramConfigFields(
  fields: Partial<{ enabled: boolean; boundUserId: number | null; proxyUrl: string | null }>,
  configPath: string = DEFAULT_CONFIG_PATH(),
): void {
  const cfg = readConfig(configPath);
  const next: typeof cfg = {
    ...cfg,
    telegram: { ...cfg.telegram, ...fields },
  };
  writeConfig(next, configPath);
}
