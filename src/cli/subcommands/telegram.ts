/** P-11 D-9 (v0.4.6 rename): `mai telegram on|off|status|test|bind <user_id>` CLI subcommand handler. */
import { readTelegramConfig, writeTelegramConfig } from "../../persistence/telegramConfig.js";
import { telegramFetch } from "../../tools/telegram/transport.js";

export interface TelegramSubcommandOpts {
  /** Path to telegram.json. */
  tcPath: string;
  /** Telegram user_id for bind action; ignored otherwise. In a DM context this also serves as the chat_id for outbound sendMessage. */
  userId?: number;
}

export async function runTelegramSubcommand(
  action: "on" | "off" | "status" | "test" | "bind",
  opts: TelegramSubcommandOpts,
): Promise<void> {
  const cfg = readTelegramConfig(opts.tcPath);
  if (action === "on") {
    cfg.enabled = true;
    writeTelegramConfig(cfg, opts.tcPath);
    process.stdout.write("[telegram] enabled (poller starts on next `mai` REPL launch)\n");
    if (!process.env.TELEGRAM_TOKEN) {
      process.stdout.write("⚠ TELEGRAM_TOKEN env var is unset — set it before launching the REPL\n");
    }
    if (cfg.boundUserId === null) {
      process.stdout.write("⚠ no boundUserId — run `mai telegram bind <user_id>` first\n");
    }
    return;
  }
  if (action === "off") {
    cfg.enabled = false;
    writeTelegramConfig(cfg, opts.tcPath);
    process.stdout.write("[telegram] disabled\n");
    return;
  }
  if (action === "status") {
    process.stdout.write(`[telegram] enabled: ${cfg.enabled}\n`);
    process.stdout.write(`[telegram] boundUserId: ${cfg.boundUserId ?? "(unset)"}\n`);
    process.stdout.write(`[telegram] lastUpdateOffset: ${cfg.lastUpdateOffset}\n`);
    process.stdout.write(`[telegram] stickyFallbackIp: ${cfg.stickyFallbackIp ?? "(none)"}\n`);
    process.stdout.write(
      `[telegram] env: TOKEN=${process.env.TELEGRAM_TOKEN ? "set" : "unset"}, ` +
        `CHAT_ID=${process.env.TELEGRAM_CHAT_ID ? "set" : "unset"}, ` +
        `PROXY=${process.env.TELEGRAM_PROXY ?? "(unset)"}\n`,
    );
    process.stdout.write("[telegram] running: false (CLI mode — no poller)\n");
    return;
  }
  if (action === "bind") {
    if (opts.userId === undefined || Number.isNaN(opts.userId)) {
      process.stderr.write("[telegram] bind: user_id required (integer)\n");
      process.exit(1);
    }
    cfg.boundUserId = opts.userId;
    writeTelegramConfig(cfg, opts.tcPath);
    process.stdout.write(`[telegram] boundUserId set to ${opts.userId}\n`);
    return;
  }
  if (action === "test") {
    if (!process.env.TELEGRAM_TOKEN || cfg.boundUserId === null) {
      process.stderr.write("[telegram] test: TELEGRAM_TOKEN unset OR boundUserId null\n");
      process.exit(1);
    }
    try {
      const res = await telegramFetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // In a DM context chat_id == user_id (same numeric value per Telegram Bot API).
          body: JSON.stringify({ chat_id: cfg.boundUserId, text: "✓ mai telegram test OK" }),
        },
        {
          fallbackIp: cfg.stickyFallbackIp ?? undefined,
          proxyUrl: process.env.TELEGRAM_PROXY,
          onFallbackSuccess: (ip) => {
            cfg.stickyFallbackIp = ip;
            writeTelegramConfig(cfg, opts.tcPath);
          },
        },
      );
      process.stdout.write(`[telegram] test → HTTP ${res.status}\n`);
    } catch (e) {
      process.stderr.write(`[telegram] test failed: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
  }
}
