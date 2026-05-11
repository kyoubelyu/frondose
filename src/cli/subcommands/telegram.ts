/** P-11 D-9: `mai telegram on|off|status|test|bind <chat_id>` CLI subcommand handler. */
import { readTelegramConfig, writeTelegramConfig } from "../../persistence/telegramConfig.js";
import { telegramFetch } from "../../tools/telegram/transport.js";

export interface TelegramSubcommandOpts {
  /** Path to telegram.json. */
  tcPath: string;
  /** chat_id for bind action; ignored otherwise. */
  chatId?: number;
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
    if (cfg.boundChatId === null) {
      process.stdout.write("⚠ no boundChatId — run `mai telegram bind <chat_id>` first\n");
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
    process.stdout.write(`[telegram] boundChatId: ${cfg.boundChatId ?? "(unset)"}\n`);
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
    if (opts.chatId === undefined || Number.isNaN(opts.chatId)) {
      process.stderr.write("[telegram] bind: chat_id required (integer)\n");
      process.exit(1);
    }
    cfg.boundChatId = opts.chatId;
    writeTelegramConfig(cfg, opts.tcPath);
    process.stdout.write(`[telegram] boundChatId set to ${opts.chatId}\n`);
    return;
  }
  if (action === "test") {
    if (!process.env.TELEGRAM_TOKEN || cfg.boundChatId === null) {
      process.stderr.write("[telegram] test: TELEGRAM_TOKEN unset OR boundChatId null\n");
      process.exit(1);
    }
    try {
      const res = await telegramFetch(
        `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: cfg.boundChatId, text: "✓ mai telegram test OK" }),
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
