/** P-11 D-9 (v0.4.6 rename): `mai telegram on|off|status|test|bind <user_id>` CLI subcommand handler. */
import { readTelegramConfig, writeTelegramConfig } from "../../persistence/telegramConfig.js";
import { telegramFetch } from "../../tools/telegram/transport.js";
import { isInteractive, type Prompter, printNoninteractiveGuidance, realPrompter } from "./_prompts.js";

export interface TelegramSubcommandOpts {
  /** Path to telegram.json. */
  tcPath: string;
  /** Telegram user_id for bind action; ignored otherwise. In a DM context this also serves as the chat_id for outbound sendMessage. */
  userId?: number;
}

export async function runTelegramSubcommand(
  action: "on" | "off" | "status" | "test" | "bind",
  opts: TelegramSubcommandOpts,
  // P-13 D-3: optional Prompter for interactive `bind` path.
  prompter: Prompter = realPrompter,
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
    // P-12 D-5: surface wire-level last-received timestamp (parity with REPL slash output).
    process.stdout.write(`[telegram] lastReceivedAt: ${cfg.lastReceivedAt ?? "(none)"}\n`);
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
    // P-13 D-7 5-step interactive flow when no positional userId + TTY.
    let userId = opts.userId;
    if (userId === undefined && isInteractive()) {
      // Step 1: env check (D-7).
      if (!process.env.TELEGRAM_TOKEN) {
        printNoninteractiveGuidance(
          "telegram bind",
          "TELEGRAM_TOKEN env var",
          "TELEGRAM_TOKEN=<bot-token> mai telegram bind <user_id>",
        );
        process.exit(1);
      }
      // Step 2: non-blocking getUpdates(timeout=0, limit=20) per D-7.
      const senders = new Map<number, string>();
      let fetchOk = false;
      try {
        const res = await telegramFetch(
          `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getUpdates`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ offset: 0, limit: 20, timeout: 0, allowed_updates: ["message"] }),
          },
          { fallbackIp: cfg.stickyFallbackIp ?? undefined, proxyUrl: process.env.TELEGRAM_PROXY },
        );
        const j = (await res.json()) as {
          ok: boolean;
          result?: Array<{ message?: { from?: { id: number; username?: string; first_name?: string } } }>;
        };
        if (j.ok) {
          fetchOk = true;
          for (const upd of j.result ?? []) {
            const from = upd.message?.from;
            if (!from || senders.has(from.id)) continue;
            const label = from.username ? `@${from.username}` : (from.first_name ?? `id${from.id}`);
            senders.set(from.id, `${label} (ID: ${from.id})`);
          }
        }
      } catch (_e) {
        // fetchOk stays false → fall through to step 4 fallback.
      }
      // Step 3 + 4: select or fallback (D-7).
      if (fetchOk && senders.size === 0) {
        process.stdout.write("No recent senders found. DM your bot first, then re-run `mai telegram bind`.\n");
        return;
      }
      if (fetchOk) {
        const selected = await prompter.telegramUserSelect(senders);
        if (selected !== null) userId = selected;
      } else {
        process.stdout.write("[telegram] getUpdates failed — falling back to manual input.\n");
        const raw = await prompter.input("Enter Telegram user_id (integer): ");
        const parsed = Number(raw.trim());
        if (!Number.isInteger(parsed) || parsed <= 0) {
          process.stderr.write(`[telegram bind] invalid user_id "${raw}" — must be positive integer.\n`);
          process.exit(1);
        }
        userId = parsed;
      }
    }
    if (userId === undefined || Number.isNaN(userId)) {
      printNoninteractiveGuidance("telegram bind", "<user_id>", "<user_id-from-DM-to-bot>");
      process.exit(1);
    }
    cfg.boundUserId = userId;
    writeTelegramConfig(cfg, opts.tcPath);
    process.stdout.write(`[telegram] boundUserId set to ${userId}\n`);
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
