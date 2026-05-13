/**
 * P-11 / D-4: telegram.json schema + atomic read/write.
 * Separate from auth.json (no secrets — TELEGRAM_TOKEN stays env-only).
 * No chmod. tmp+rename atomic write.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";

export const telegramConfigSchema = z.object({
  enabled: z.boolean(),
  // P-12 v0.4.6 rename from boundChatId: .default(null) for backward compat
  // with P-11 / v0.4.5-era telegram.json files that still have boundChatId instead.
  boundUserId: z.number().int().nullable().default(null),
  lastUpdateOffset: z.number().int().min(0),
  stickyFallbackIp: z.string().nullable(),
  proxyUrl: z.string().nullable().default(null),
  pollTimeoutSec: z.number().int().min(1).max(60),
  pollBackoffSec: z.number().int().min(1).max(60),
  // P-12 D-5: optional + default(null) preserves forward-compat with pre-P-12 telegram.json.
  lastReceivedAt: z.string().nullable().optional().default(null),
});
export type TelegramConfig = z.infer<typeof telegramConfigSchema>;

export const DEFAULT_TELEGRAM_CONFIG: TelegramConfig = {
  enabled: false,
  boundUserId: null,
  lastUpdateOffset: 0,
  stickyFallbackIp: null,
  proxyUrl: null,
  pollTimeoutSec: 30,
  pollBackoffSec: 5,
  lastReceivedAt: null,
};

export function readTelegramConfig(path: string): TelegramConfig {
  if (!existsSync(path)) return { ...DEFAULT_TELEGRAM_CONFIG };
  try {
    const raw = readFileSync(path, "utf-8");
    return telegramConfigSchema.parse(JSON.parse(raw));
  } catch (e) {
    process.stderr.write(
      `[mai] telegram.json invalid at ${path} (${e instanceof Error ? e.message : String(e)}); using defaults.\n`,
    );
    return { ...DEFAULT_TELEGRAM_CONFIG };
  }
}

export function writeTelegramConfig(cfg: TelegramConfig, path: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf-8");
  renameSync(tmp, path);
}
