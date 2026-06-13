/** P-11 D-9 (v0.4.6 rename): `mai telegram on|off|status|test|bind|proxy` CLI subcommand handler.
 *  P-23 §6.8: `on/off/status` extended to install/uninstall launchd LaunchAgent
 *  + report daemon liveness via telegram.pid + tail err.log on `status`.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseModelSpec, resolveModelSpec } from "../../agent/modelResolver.js";
import { frondoseEnv } from "../../env.js";
import { DATA_DIR_NAME, getHomeBase } from "../../persistence/paths.js";
import { isPidAlive, readPid } from "../../persistence/processLock.js";
import {
  readTelegramConfig,
  writeTelegramConfig,
  writeTelegramConfigFields,
} from "../../persistence/telegramConfig.js";
import { telegramFetch } from "../../tools/telegram/transport.js";
import { isInteractive, type Prompter, printNoninteractiveGuidance, realPrompter } from "./_prompts.js";
import {
  type EnvSnapshot,
  installLaunchAgent,
  isDaemonInstalled,
  type PlistArgs,
  plistPath,
  uninstallLaunchAgent,
} from "./launchd.js";

export interface TelegramSubcommandOpts {
  /** Path to telegram.json. */
  tcPath: string;
  /** Telegram user_id for bind action; ignored otherwise. In a DM context this also serves as the chat_id for outbound sendMessage. */
  userId?: number;
  /** proxy URL for proxy action. */
  proxyUrl?: string;
  /** Clear proxy URL for proxy action. */
  unsetProxy?: boolean;
  /** P-23 §6.8: bypass install consent prompt (operator-facing --yes flag). */
  yes?: boolean;
}

/** P-23 §6.8: assemble env snapshot for launchd plist. Provider key picked
 *  from resolved default model spec → matching well-known env-var name. */
function buildEnvSnapshot(): EnvSnapshot {
  const env: EnvSnapshot = {
    // biome-ignore lint/style/noNonNullAssertion: caller checks process.env.TELEGRAM_TOKEN before this is called.
    TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN!,
  };
  if (process.env.TELEGRAM_PROXY) env.TELEGRAM_PROXY = process.env.TELEGRAM_PROXY;
  const model = frondoseEnv("MODEL");
  if (model) env.FRONDOSE_MODEL = model;
  // Resolve the model spec to determine which provider key to snapshot.
  try {
    const spec = resolveModelSpec({});
    const { provider } = parseModelSpec(spec);
    if (provider === "deepseek" && process.env.DEEPSEEK_API_KEY) {
      env.providerKeyName = "DEEPSEEK_API_KEY";
      env.providerKeyValue = process.env.DEEPSEEK_API_KEY;
    }
  } catch {
    // Spec parse failure shouldn't block install — operator can re-run if needed.
  }
  return env;
}

function buildConsentText(args: PlistArgs): string {
  return (
    `Install launchd LaunchAgent for persistent Telegram?\n` +
    `  Plist: ${plistPath(args.home)}\n` +
    `  Node:  ${args.nodeBin}\n` +
    `  Entry: ${args.maiEntry}\n` +
    `  TELEGRAM_TOKEN will be snapshotted into the plist (chmod 600).\n` +
    `Proceed?`
  );
}

/** P-23 §3.3: read last non-empty line from err.log, truncated to 120 chars. */
function tailLogLastLine(logPath: string): string | null {
  if (!existsSync(logPath)) return null;
  try {
    const raw = readFileSync(logPath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
    const last = lines.at(-1);
    if (!last) return null;
    return last.length > 120 ? `${last.slice(0, 120)}…` : last;
  } catch {
    return null;
  }
}

export async function runTelegramSubcommand(
  action: "on" | "off" | "status" | "test" | "bind" | "proxy",
  opts: TelegramSubcommandOpts,
  // P-13 D-3: optional Prompter for interactive `bind` path.
  prompter: Prompter = realPrompter,
): Promise<void> {
  const cfg = readTelegramConfig(opts.tcPath);
  if (action === "on") {
    // P-23 §6.8 / §3.1: install launchd LaunchAgent.
    if (process.platform !== "darwin") {
      process.stderr.write("[telegram on] macOS-only — daemon supervision requires launchd\n");
      process.exit(1);
    }
    const replPidPath = path.join(getHomeBase(), DATA_DIR_NAME, "agent", "repl.pid");
    if (isPidAlive(replPidPath)) {
      process.stderr.write("[telegram on] mai REPL is currently running — close it first (Close mai REPL first)\n");
      process.exit(1);
    }
    if (!process.env.TELEGRAM_TOKEN) {
      process.stderr.write("[telegram on] TELEGRAM_TOKEN env var must be set\n");
      process.exit(1);
    }
    if (cfg.boundUserId === null) {
      process.stderr.write("[telegram on] no boundUserId — run `mai telegram bind <user_id>` first\n");
      process.exit(1);
    }
    const env = buildEnvSnapshot();
    const args: PlistArgs = {
      nodeBin: process.execPath,
      maiEntry: realpathSync(process.argv[1] ?? ""),
      home: os.homedir(),
      env,
    };
    const result = await installLaunchAgent(args, {
      yes: opts.yes ?? false,
      consent: async () => prompter.confirm(buildConsentText(args), false),
    });
    if (result.cancelled) {
      process.stdout.write("[telegram on] cancelled\n");
      return;
    }
    // P-24 §6.7: enabled lives in config.json now; runtime telegram.json untouched.
    writeTelegramConfigFields({ enabled: true });
    process.stdout.write("[telegram on] daemon installed and running\n");
    process.stdout.write(`  Plist: ${plistPath()}\n  Logs:  ~/.frondose/agent/logs/telegram-daemon.{out,err}.log\n`);
    return;
  }
  if (action === "off") {
    // P-23 §6.8 / §3.2: uninstall launchd LaunchAgent, then flip flag.
    if (process.platform === "darwin") uninstallLaunchAgent();
    // P-24 §6.7: enabled lives in config.json now; runtime telegram.json untouched.
    writeTelegramConfigFields({ enabled: false });
    process.stdout.write("[telegram off] daemon stopped, plist removed, cfg disabled\n");
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
        `PROXY=${process.env.TELEGRAM_PROXY ?? cfg.proxyUrl ?? "(unset)"}\n`,
    );
    // P-23 §3.3: daemon plist + PID + log tail.
    const homeBase = getHomeBase();
    const launchdHome = os.homedir();
    const tgPidPath = path.join(homeBase, DATA_DIR_NAME, "agent", "telegram.pid");
    const installed = isDaemonInstalled(launchdHome);
    const daemonPid = readPid(tgPidPath);
    const daemonAlive = daemonPid !== null && isPidAlive(tgPidPath);
    process.stdout.write(`[telegram] daemon plist: ${plistPath(launchdHome)} (installed=${installed})\n`);
    process.stdout.write(`[telegram] daemon pid: ${daemonPid ?? "(none)"} (alive=${daemonAlive})\n`);
    const errLog = path.join(homeBase, DATA_DIR_NAME, "agent", "logs", "telegram-daemon.err.log");
    const tail = tailLogLastLine(errLog);
    process.stdout.write(`[telegram] log file: ${errLog} (last line: ${tail ?? "(empty)"})\n`);
    process.stdout.write("[telegram] running: false (CLI mode — no in-process poller)\n");
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
          {
            fallbackIp: cfg.stickyFallbackIp ?? undefined,
            proxyUrl: process.env.TELEGRAM_PROXY ?? cfg.proxyUrl ?? undefined,
          },
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
    // P-24 §6.7: boundUserId lives in config.json now.
    writeTelegramConfigFields({ boundUserId: userId });
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
          proxyUrl: process.env.TELEGRAM_PROXY ?? cfg.proxyUrl ?? undefined,
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
  if (action === "proxy") {
    // P-24 §6.7: proxyUrl lives in config.json now; resolve final value, then write.
    let nextProxy: string | null;
    if (opts.unsetProxy) {
      nextProxy = null;
    } else if (opts.proxyUrl !== undefined) {
      nextProxy = opts.proxyUrl || null;
    } else if (isInteractive()) {
      const raw = await prompter.input("Proxy URL (e.g. http://127.0.0.1:7890, leave blank to clear): ");
      nextProxy = raw.trim() || null;
    } else {
      printNoninteractiveGuidance("telegram proxy", "[url]", "http://127.0.0.1:7890");
      process.exit(1);
    }
    writeTelegramConfigFields({ proxyUrl: nextProxy });
    process.stdout.write(`[telegram] proxy ${nextProxy ? `set to ${nextProxy}` : "cleared"}\n`);
    return;
  }
}
