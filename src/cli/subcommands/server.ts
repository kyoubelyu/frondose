/** P-25: top-level `mai server` action dispatcher.
 *  Routes sub-actions from src/cli/main.ts to the appropriate implementation. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { frondoseEnv } from "../../env.js";
import { type ConfigJson, readConfig } from "../../persistence/config.js";
import { DATA_DIR_NAME, getHomeBase } from "../../persistence/paths.js";
import { isAlive, readPid } from "../../persistence/processLock.js";
import { readServerIdentity, writeServerIdentity } from "../../persistence/serverIdentity.js";
import {
  SERVER_CONFIG_PATH,
  SERVER_IDENTITY_PATH,
  SERVER_LOGS_DIR,
  SERVER_PID_PATH,
} from "../../persistence/serverPaths.js";
import { writeTelegramConfigFields } from "../../persistence/telegramConfig.js";
import { runServerIdentityInit } from "../server-identity-init.js";
import { runServerDaemon } from "../serverDaemon.js";
import { runServerRepl } from "../serverRepl.js";
import { isInteractive, printNoninteractiveGuidance, realPrompter } from "./_prompts.js";
import { installServerLaunchAgent, serverPlistPath, uninstallServerLaunchAgent } from "./serverLaunchd.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ServerAction =
  | "repl"
  | "daemon"
  | "install"
  | "uninstall"
  | "status"
  | "bind"
  | "identity-init"
  | "soul-show"
  | "soul-edit"
  | "soul-reset";

export interface ServerSubcommandOpts {
  yes?: boolean;
  reset?: boolean;
  userId?: number;
  /** DI: override worker identity path for testing */
  workerIdentityPath?: string;
  /** DI: override server identity path for testing */
  serverIdentityPath?: string;
  /** DI: override server config path for testing */
  serverConfigPath?: string;
  /** DI: override server telegram config path for testing */
  telegramConfigPath?: string;
  /** DI: override server pid path for testing */
  pidPath?: string;
  /** DI: override prompter */
  prompter?: typeof realPrompter;
}

// ─── Dispatcher ────────────────────────────────────────────────────────────────

export async function runServerSubcommand(action: ServerAction, opts: ServerSubcommandOpts): Promise<void> {
  switch (action) {
    case "repl":
      return runServerRepl();
    case "daemon":
      return runServerDaemon();
    case "install":
      return runServerInstall(opts);
    case "uninstall":
      return runServerUninstall(opts);
    case "status":
      return runServerStatus(opts);
    case "bind":
      return runServerBind(opts);
    case "identity-init":
      return runServerIdentityInitAction(opts);
    case "soul-show":
      return runServerSoulShow(opts);
    case "soul-edit":
      return runServerSoulEdit(opts);
    case "soul-reset":
      return runServerSoulReset(opts);
  }
}

// ─── Status ────────────────────────────────────────────────────────────────────

async function runServerStatus(opts: ServerSubcommandOpts): Promise<void> {
  const pidPath = opts.pidPath ?? SERVER_PID_PATH();
  const pid = readPid(pidPath);
  const alive = pid !== null && isAlive(pid);
  process.stdout.write(`pid: ${pid ?? "none"} (alive=${alive})\n`);

  const plPath = serverPlistPath();
  const plistInstalled = existsSync(plPath);
  process.stdout.write(`plist: ${plistInstalled ? "installed" : "not installed"}\n`);

  let boundUserId: number | null = null;
  try {
    const cfg = readConfig(opts.serverConfigPath ?? SERVER_CONFIG_PATH());
    boundUserId = cfg.telegram.boundUserId ?? null;
  } catch {
    // ignore
  }
  process.stdout.write(`bound_user_id: ${boundUserId ?? "none"}\n`);

  // Tail last line of server-daemon.err.log
  const logsDir = SERVER_LOGS_DIR();
  const errLog = path.join(logsDir, "server-daemon.err.log");
  if (existsSync(errLog)) {
    try {
      const lines = readFileSync(errLog, "utf-8").split(/\r?\n/).filter(Boolean);
      const lastLine = lines.at(-1) ?? "";
      process.stdout.write(`last_error_log: ${lastLine}\n`);
    } catch {
      // ignore
    }
  }
}

// ─── Bind ──────────────────────────────────────────────────────────────────────

async function runServerBind(opts: ServerSubcommandOpts): Promise<void> {
  const token = frondoseEnv("SERVER_TELEGRAM_TOKEN");
  if (!token) {
    process.stderr.write(
      "[server bind] FRONDOSE_SERVER_TELEGRAM_TOKEN env var is unset. " +
        "Set it to your server bot token before running `mai server bind`.\n",
    );
    process.exit(1);
  }

  let userId = opts.userId;
  if (userId === undefined) {
    if (isInteractive()) {
      // Minimal interactive path: prompt user to provide user_id directly
      // (full interactive senders-list flow deferred to post-P-25 polish).
      const prompter = opts.prompter ?? realPrompter;
      const raw = await prompter.input("Enter your Telegram user_id: ");
      userId = Number(raw.trim());
    } else {
      printNoninteractiveGuidance("server bind", "<user_id>", "<user_id-from-DM-to-server-bot>");
      process.exit(1);
    }
  }

  if (userId === undefined || Number.isNaN(userId)) {
    printNoninteractiveGuidance("server bind", "<user_id>", "<user_id-from-DM-to-server-bot>");
    process.exit(1);
  }

  const configPath = opts.serverConfigPath ?? SERVER_CONFIG_PATH();
  writeTelegramConfigFields({ boundUserId: userId }, configPath);
  process.stdout.write(`[server] boundUserId set to ${userId}\n`);
}

// ─── Install ───────────────────────────────────────────────────────────────────

async function runServerInstall(opts: ServerSubcommandOpts): Promise<void> {
  if (process.platform !== "darwin") {
    process.stderr.write("[server install] macOS-only — launchd unavailable elsewhere\n");
    process.exit(1);
  }
  const token = frondoseEnv("SERVER_TELEGRAM_TOKEN");
  if (!token) {
    process.stderr.write("[server install] FRONDOSE_SERVER_TELEGRAM_TOKEN env var must be set\n");
    process.exit(1);
  }
  const configPath = opts.serverConfigPath ?? SERVER_CONFIG_PATH();
  let cfg: ConfigJson | { telegram: { boundUserId: null } };
  try {
    cfg = readConfig(configPath);
  } catch {
    cfg = { telegram: { boundUserId: null } };
  }
  if (!cfg.telegram.boundUserId) {
    process.stderr.write("[server install] run `mai server bind <user_id>` first\n");
    process.exit(1);
  }

  const args = {
    nodeBin: process.execPath,
    maiEntry: realpathSync(process.argv[1] ?? process.execPath),
    home: os.homedir(),
    env: { TELEGRAM_TOKEN: token, FRONDOSE_MODEL: frondoseEnv("MODEL") },
  };
  const prompter = opts.prompter ?? realPrompter;
  const result = await installServerLaunchAgent(args, {
    yes: opts.yes ?? false,
    consent: async () => prompter.confirm("[server install] Install server daemon plist?", false),
  });
  if (result.cancelled) {
    process.stdout.write("[server install] cancelled\n");
    return;
  }
  process.stdout.write("[server install] daemon installed and running\n");
  process.stdout.write(`  Plist: ${serverPlistPath()}\n  Logs:  ${SERVER_LOGS_DIR()}/server-daemon.{out,err}.log\n`);
}

// ─── Uninstall ─────────────────────────────────────────────────────────────────

async function runServerUninstall(_opts: ServerSubcommandOpts): Promise<void> {
  uninstallServerLaunchAgent();
  process.stdout.write("[server uninstall] daemon stopped and plist removed\n");
}

// ─── Identity init ─────────────────────────────────────────────────────────────

async function runServerIdentityInitAction(opts: ServerSubcommandOpts): Promise<void> {
  const prompter = opts.prompter ?? realPrompter;
  await runServerIdentityInit(
    {
      serverIdentityPath: opts.serverIdentityPath ?? SERVER_IDENTITY_PATH(),
      workerIdentityPath: opts.workerIdentityPath ?? path.join(getHomeBase(), DATA_DIR_NAME, "agent", "identity.json"),
      reset: opts.reset ?? false,
    },
    prompter,
  );
}

// ─── Soul show/edit/reset ──────────────────────────────────────────────────────

async function runServerSoulShow(opts: ServerSubcommandOpts): Promise<void> {
  const { composeServerSoulBand } = await import("../../agent/systemPrompt/serverSoul.js");
  const identityPath = opts.serverIdentityPath ?? SERVER_IDENTITY_PATH();
  const identity = readServerIdentity(identityPath);
  if (!identity) {
    process.stderr.write("[server soul] identity not initialized; run `mai server identity init` first\n");
    process.exit(1);
  }
  process.stdout.write(composeServerSoulBand(identity));
  process.stdout.write("\n");
}

async function runServerSoulEdit(_opts: ServerSubcommandOpts): Promise<void> {
  const editor = process.env.EDITOR ?? "vi";
  const { spawnSync } = await import("node:child_process");
  spawnSync(editor, [SERVER_IDENTITY_PATH()], { stdio: "inherit" });
}

async function runServerSoulReset(_opts: ServerSubcommandOpts): Promise<void> {
  // TODO P-25: re-prompt priorities + traits from interactive flow.
  const identity = readServerIdentity(SERVER_IDENTITY_PATH());
  if (!identity) {
    process.stderr.write("[server soul reset] identity not initialized; run `mai server identity init` first\n");
    process.exit(1);
  }
  writeServerIdentity(
    { ...identity, priorities: [], traits: [], updatedAt: new Date().toISOString() },
    SERVER_IDENTITY_PATH(),
  );
  process.stdout.write("[server soul] priorities + traits reset\n");
}
