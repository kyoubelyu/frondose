/** P-25: `mai server` foreground — readline REPL + Telegram poller + cron.
 *  Mirrors src/cli/repl.ts but uses server-specific paths, identity, tool set
 *  (mode="server", 14 tools), and boundary/soul constants.
 *
 *  Daemon-alive check: refuses to start if SERVER_PID_PATH() is alive
 *  (only one foreground process per server instance). */

import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { CoreMessage } from "ai";
import { runAgentLoop } from "../agent/loop.js";
import { resolveModel } from "../agent/modelResolver.js";
import { CHECKPOINT } from "../agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../agent/systemPrompt/compose.js";
import { SERVER_BOUNDARY } from "../agent/systemPrompt/serverBoundary.js";
import { composeServerSoulBand } from "../agent/systemPrompt/serverSoul.js";
import { TurnLock } from "../agent/turnSemaphore.js";
import { makeAuditWriter } from "../persistence/audit.js";
import { isAlive, readPid } from "../persistence/processLock.js";
import { readServerIdentity } from "../persistence/serverIdentity.js";
import {
  SERVER_AUDIT_PATH,
  SERVER_CONFIG_PATH,
  SERVER_IDENTITY_PATH,
  SERVER_MEMORY_DB_PATH,
  SERVER_PID_PATH,
  SERVER_TELEGRAM_CONFIG_PATH,
} from "../persistence/serverPaths.js";
import { appendServerSession, loadServerSession, serverSessionFile } from "../persistence/serverSession.js";
import { readTelegramConfig } from "../persistence/telegramConfig.js";
import { makeAllTools } from "../tools/index.js";
import { startDaemonPoller, type TelegramTurnDeps } from "./replTelegram.js";

export interface ServerReplDeps {
  /** Override stdin (test injection). */
  stdin?: NodeJS.ReadableStream;
}

export async function runServerRepl(deps: ServerReplDeps = {}): Promise<void> {
  // Refuse to start if server daemon is alive.
  const pidPath = SERVER_PID_PATH();
  const existingPid = readPid(pidPath);
  if (existingPid !== null && isAlive(existingPid)) {
    process.stderr.write(`[server] daemon already running, PID ${existingPid}; foreground server cannot start\n`);
    process.exit(1);
  }

  const identity = readServerIdentity(SERVER_IDENTITY_PATH());
  if (!identity) {
    process.stderr.write("[server] server identity.json missing; run `mai server identity init` first\n");
    process.exit(1);
  }

  const model = resolveModel({});
  const system = composeSystemPrompt({
    boundary: SERVER_BOUNDARY,
    soul: composeServerSoulBand(identity),
    checkpoint: CHECKPOINT,
  });

  const abortController = new AbortController();
  const auditPath = SERVER_AUDIT_PATH();
  const control = { requestStop: () => abortController.abort(), auditPath };
  const auditWriter = makeAuditWriter(auditPath);

  // P-25 mode="server" — 14 tools, no LinkedIn.
  const tools = makeAllTools(
    undefined,
    { memoryDbPath: SERVER_MEMORY_DB_PATH(), identityPath: SERVER_IDENTITY_PATH() },
    control,
    undefined,
    { mode: "server" },
  );

  const turnLock = new TurnLock();
  const sessionPath = serverSessionFile();
  const messages: CoreMessage[] = loadServerSession(sessionPath);

  // Start Telegram poller if bound.
  // Step-5a D-SRV.DAEMON.CONFIGPATH: pass SERVER_CONFIG_PATH() so boundUserId is
  // read from ~/.mai/server/config.json (not the worker's ~/.mai/agent/config.json).
  const cfg = readTelegramConfig(SERVER_TELEGRAM_CONFIG_PATH(), SERVER_CONFIG_PATH());
  const sessionFile = { path: sessionPath };
  const telegramDeps: TelegramTurnDeps = {
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
  // startDaemonPoller runs fire-and-forget; does not block readline.
  void startDaemonPoller(cfg, telegramDeps, turnLock, abortController);

  // Readline REPL.
  const rl = readline.createInterface({
    input: deps.stdin ?? process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY ?? false,
  });

  process.stdout.write("[server] mai-server ready. Type your message or /help\n");

  for await (const line of rl) {
    const input = line.trim();
    if (!input) continue;
    if (input === "/exit" || input === "/quit") break;

    await turnLock.run(async () => {
      messages.push({ role: "user", content: input });
      await runAgentLoop({
        model,
        system,
        tools,
        messages,
        abortSignal: abortController.signal,
        onStepFinish: auditWriter,
      });
      appendServerSession(sessionPath, messages);
    });
  }

  rl.close();
  process.stdout.write("[server] session closed.\n");
}
