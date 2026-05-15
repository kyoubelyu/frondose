/** P-25: `mai server daemon` — launchd-invoked. Telegram-only; no readline.
 *  Mirrors src/cli/subcommands/telegramDaemon.ts but uses server-specific
 *  paths, identity, and tool set (mode="server", 14 tools). */
import os from "node:os";
import path from "node:path";
import type { CoreMessage } from "ai";
import { resolveModel } from "../agent/modelResolver.js";
import { CHECKPOINT } from "../agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../agent/systemPrompt/compose.js";
import { SERVER_BOUNDARY } from "../agent/systemPrompt/serverBoundary.js";
import { composeServerSoulBand } from "../agent/systemPrompt/serverSoul.js";
import { TurnLock } from "../agent/turnSemaphore.js";
import { makeAuditWriter } from "../persistence/audit.js";
import { isAlive, readPid, removePid, writePid } from "../persistence/processLock.js";
import { readServerIdentity } from "../persistence/serverIdentity.js";
import {
  SERVER_AUDIT_PATH,
  SERVER_CONFIG_PATH,
  SERVER_IDENTITY_PATH,
  SERVER_MEMORY_DB_PATH,
  SERVER_PID_PATH,
  SERVER_TELEGRAM_CONFIG_PATH,
} from "../persistence/serverPaths.js";
// Step-3b C-3 fix: import serverSessionFile so daemon uses the auto-mkdir helper.
import { serverSessionFile } from "../persistence/serverSession.js";
import { readTelegramConfig } from "../persistence/telegramConfig.js";
import { makeAllTools } from "../tools/index.js";
import { startDaemonPoller, type TelegramTurnDeps } from "./replTelegram.js";

export async function runServerDaemon(): Promise<void> {
  const pidPath = SERVER_PID_PATH();
  const existing = readPid(pidPath);
  if (existing !== null && isAlive(existing)) {
    process.stderr.write(`[server daemon] already running, PID ${existing}\n`);
    process.exit(1);
  }
  writePid(pidPath);
  const cleanup = () => removePid(pidPath);
  process.on("exit", cleanup);
  // Step-3b C-2 fix: unified SIGTERM + SIGINT path — no second abort controller.
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  if (!process.env.TELEGRAM_TOKEN) {
    process.stderr.write(
      "[server daemon] TELEGRAM_TOKEN unset (did MAI_SERVER_TELEGRAM_TOKEN propagate via plist?); exit\n",
    );
    cleanup();
    process.exit(1);
  }
  // Step-5a D-SRV.DAEMON.CONFIGPATH: pass SERVER_CONFIG_PATH() so boundUserId is
  // read from ~/.mai/server/config.json (not the worker's ~/.mai/agent/config.json).
  const cfg = readTelegramConfig(SERVER_TELEGRAM_CONFIG_PATH(), SERVER_CONFIG_PATH());
  if (cfg.boundUserId === null) {
    process.stderr.write("[server daemon] boundUserId null; run `mai server bind` first\n");
    cleanup();
    process.exit(1);
  }

  const identity = readServerIdentity(SERVER_IDENTITY_PATH());
  if (!identity) {
    process.stderr.write("[server daemon] server identity.json missing; run `mai server identity init`\n");
    cleanup();
    process.exit(1);
  }

  const model = resolveModel({});
  const system = composeSystemPrompt({
    boundary: SERVER_BOUNDARY,
    soul: composeServerSoulBand(identity),
    checkpoint: CHECKPOINT,
  });

  // Step-3b C-2: ONE AbortController drives both agent loop + Telegram poller.
  const abortController = new AbortController();
  const control = { requestStop: () => abortController.abort(), auditPath: SERVER_AUDIT_PATH() };
  const auditWriter = makeAuditWriter(SERVER_AUDIT_PATH());

  // P-25 mode="server" — 14 tools, no LinkedIn, list_workers stub included.
  const tools = makeAllTools(
    undefined, // no session
    { memoryDbPath: SERVER_MEMORY_DB_PATH(), identityPath: SERVER_IDENTITY_PATH() },
    control,
    undefined, // no hookRunner at P-25
    { mode: "server" },
  );

  const turnLock = new TurnLock();
  const messages: CoreMessage[] = [];
  // Step-3b C-3 fix: serverSessionFile() auto-creates ~/.mai/server/sessions/.
  const sessionFile = { path: serverSessionFile() };
  const deps: TelegramTurnDeps = {
    model,
    system,
    messages,
    tools,
    sessionFile,
    abortSignal: abortController.signal,
    onStepFinish: auditWriter,
    out: process.stdout,
    configPath: SERVER_TELEGRAM_CONFIG_PATH(),
    uploadAllowlistRoot: process.env.MAI_UPLOAD_ALLOWLIST ?? path.join(os.homedir(), ".mai/agent/uploads"),
  };

  process.stdout.write(`[server daemon] up, PID ${process.pid}, session ${sessionFile.path}\n`);
  // Step-3b C-2: pass unified abortController to poller; SIGTERM path handles
  // process.exit(0) directly (see handler above). startDaemonPoller returns the
  // handle synchronously (kicks off a fire-and-forget loop internally), so this
  // function would return immediately without the hold-Promise below — main.ts
  // would then `process.exit(0)` and kill the daemon. The hold-Promise keeps
  // the event loop alive until `stop` tool aborts the controller OR the SIGTERM
  // handler exits the process directly.
  await startDaemonPoller(cfg, deps, turnLock, abortController);
  await new Promise<void>((resolve) => {
    abortController.signal.addEventListener("abort", () => resolve());
  });
}
