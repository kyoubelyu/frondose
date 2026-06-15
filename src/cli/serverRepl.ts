/** P-25: `mai server` foreground — readline REPL + Telegram poller + cron.
 *  Mirrors src/cli/repl.ts but uses server-specific paths, identity, tool set
 *  (mode="server", 14 tools), and boundary/soul constants.
 *
 *  Daemon-alive check: refuses to start if SERVER_PID_PATH() is alive
 *  (only one foreground process per server instance). */

import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { CoreMessage } from "ai";
import { runAgentLoop } from "../agent/loop.js";
import { resolveMaxSteps } from "../agent/maxSteps.js";
import { resolveModelOrNull } from "../agent/modelResolver.js";
import { frondoseEnv } from "../env.js";
import { CHECKPOINT } from "../agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../agent/systemPrompt/compose.js";
import { SERVER_BOUNDARY } from "../agent/systemPrompt/serverBoundary.js";
import { composeServerSoulBand } from "../agent/systemPrompt/serverSoul.js";
import { TurnLock } from "../agent/turnSemaphore.js";
import { makeAuditWriter } from "../persistence/audit.js";
import { readConfig } from "../persistence/config.js";
import { openCredentialsDb } from "../persistence/credentialLibrary.js";
import { openMemoryDatabase } from "../persistence/memory.js";
import { DATA_DIR_NAME, getHomeBase } from "../persistence/paths.js";
import { isAlive, readPid } from "../persistence/processLock.js";
import { readSecrets } from "../persistence/secrets.js";
import { readServerIdentity } from "../persistence/serverIdentity.js";
import { drainServerInbox, openServerInboxDb } from "../persistence/serverInbox.js";
import {
  SERVER_AUDIT_PATH,
  SERVER_CONFIG_PATH,
  SERVER_CREDENTIALS_DB_PATH,
  SERVER_IDENTITY_PATH,
  SERVER_INBOX_DB_PATH,
  SERVER_MEMORY_DB_PATH,
  SERVER_PERSONAS_DIR,
  SERVER_PID_PATH,
  SERVER_SCHEDULE_PATH,
  SERVER_SECRETS_PATH,
  SERVER_TELEGRAM_CONFIG_PATH,
  SERVER_WORKERS_CONFIG_DIR,
  SERVER_WORKERS_DB_PATH,
} from "../persistence/serverPaths.js";
import { appendServerSession, loadServerSession, serverSessionFile } from "../persistence/serverSession.js";
import { readTelegramConfig } from "../persistence/telegramConfig.js";
import { openWorkersDb } from "../persistence/workersRegistry.js";
import { makeAllTools } from "../tools/index.js";
import { drainDueJobs, type RunCronTurnDeps } from "./replCron.js";
import { startDaemonPoller, type TelegramTurnDeps } from "./replTelegram.js";
import { startServerHttp } from "./serverHttp.js";
import { startWebHttp } from "./serverWeb.js";

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

  const abortController = new AbortController();
  const auditPath = SERVER_AUDIT_PATH();
  const control = { requestStop: () => abortController.abort(), auditPath };
  const auditWriter = makeAuditWriter(auditPath);

  // P-26: open server-side DB handles ONCE per REPL boot. Threaded into
  // makeAllTools + the HTTP listener below.
  const workersDb = openWorkersDb(SERVER_WORKERS_DB_PATH());
  const serverInboxDb = openServerInboxDb(SERVER_INBOX_DB_PATH());
  // P-28: credential library handle (LLM keys + Google accounts).
  const credentialsDb = openCredentialsDb(SERVER_CREDENTIALS_DB_PATH());
  const serverCfg = readConfig(SERVER_CONFIG_PATH());

  // mode="server" — 20 tools (P-31+).
  const tools = makeAllTools(
    undefined,
    {
      memoryDbPath: SERVER_MEMORY_DB_PATH(),
      identityPath: SERVER_IDENTITY_PATH(),
      workersDbPath: SERVER_WORKERS_DB_PATH(),
      serverInboxDbPath: SERVER_INBOX_DB_PATH(),
      personasDir: SERVER_PERSONAS_DIR(),
      serverUrl: serverCfg.server.url ?? "",
      credentialsDbPath: SERVER_CREDENTIALS_DB_PATH(),
      schedulePath: SERVER_SCHEDULE_PATH(), // P-31: schedule_task tool + server cron tick
    },
    control,
    undefined,
    { mode: "server" },
  );

  // P-26: server-side HTTP listener (Tailscale-private; defaults to 127.0.0.1).
  const httpServer = startServerHttp(
    { workersDb, serverInboxDb },
    serverCfg.server.bind_address ?? null,
    serverCfg.server.rest_port, // P-36 F-D2: configurable REST port (default 3031)
  );
  process.once("exit", () => {
    try {
      httpServer.close();
    } catch {
      // already closed — ignore
    }
  });

  // P-29: operator web dashboard on port web_port (default 8090).
  const memoryDb = openMemoryDatabase(SERVER_MEMORY_DB_PATH());
  const webToken = readSecrets(SERVER_SECRETS_PATH()).server?.webToken;
  const webAssetRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web"); // dist/cli → dist/web
  const webServer = startWebHttp(
    {
      workersDb,
      memoryDb,
      credentialsDb, // P-41: replaces invitesDb (provision needs LLM keys)
      personasDir: SERVER_PERSONAS_DIR(),
      serverUrl: serverCfg.server.url ?? "",
      assetRoot: webAssetRoot,
      // P-30: SSH/VNC WebSocket bridge config.
      sshUser: serverCfg.server.ssh_user,
      sshPort: serverCfg.server.ssh_port,
      workersConfigDir: SERVER_WORKERS_CONFIG_DIR(),
    },
    serverCfg.server.web_port,
    serverCfg.server.bind_address ?? null,
    webToken,
  );
  process.once("exit", () => {
    try {
      webServer.close();
    } catch {
      // already closed — ignore
    }
  });

  const turnLock = new TurnLock();
  const sessionPath = serverSessionFile();
  const messages: CoreMessage[] = loadServerSession(sessionPath);

  const sessionFile = { path: sessionPath };

  // P-36 F-B (B2): resolve the LLM WITHOUT throwing — the REST + web listeners are
  // already bound above. A bad LLM config degrades (no orchestrator agent, no
  // readline turn loop) instead of crashing the fleet-coordination plane.
  const model = resolveModelOrNull();
  if (model) {
    const system = composeSystemPrompt({
      boundary: SERVER_BOUNDARY,
      soul: composeServerSoulBand(identity),
      checkpoint: CHECKPOINT,
    });
    // P-46 D-1b: `mai server` has no --max-steps flag — env-only (FRONDOSE_MAX_STEPS) or default 200.
    const serverMaxSteps = resolveMaxSteps();

    // Start Telegram poller if bound.
    // Step-5a D-SRV.DAEMON.CONFIGPATH: pass SERVER_CONFIG_PATH() so boundUserId is
    // read from ~/.frondose/server/config.json (not the worker's ~/.frondose/agent/config.json).
    const cfg = readTelegramConfig(SERVER_TELEGRAM_CONFIG_PATH(), SERVER_CONFIG_PATH());
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
      uploadAllowlistRoot: frondoseEnv("UPLOAD_ALLOWLIST") ?? path.join(getHomeBase(), DATA_DIR_NAME, "agent/uploads"),
    };
    // startDaemonPoller runs fire-and-forget; does not block readline.
    void startDaemonPoller(cfg, telegramDeps, turnLock, abortController);

    // P-31 (D-4): server cron tick — boot drain + 60 s interval, turnLock-serialized.
    const cronDeps: RunCronTurnDeps = {
      model,
      system,
      messages,
      tools,
      sessionFile: sessionFile.path,
      abortSignal: abortController.signal,
      onStepFinish: auditWriter,
      out: process.stdout,
      maxSteps: serverMaxSteps,
    };
    await turnLock.run(() => drainDueJobs(SERVER_SCHEDULE_PATH(), abortController.signal, cronDeps));
    const cronTick = setInterval(() => {
      void turnLock.run(() => drainDueJobs(SERVER_SCHEDULE_PATH(), abortController.signal, cronDeps));
    }, 60_000);
    cronTick.unref();

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
        // P-26 Step-5a B-26R-1: drain pending worker events from server_inbox and
        // prepend to the operator's user message so the server LLM sees fleet
        // activity as context BEFORE answering. Capped at MAX_PER_DRAIN=20 rows
        // per call; remaining rows surface in the next turn.
        const inboxPrefix = drainServerInbox(serverInboxDb);
        const userContent = inboxPrefix ? `${inboxPrefix}\n\n---\n\n${input}` : input;
        messages.push({ role: "user", content: userContent });
        await runAgentLoop({
          model,
          system,
          tools,
          messages,
          maxSteps: serverMaxSteps, // P-46 D-1b
          abortSignal: abortController.signal,
          onStepFinish: auditWriter,
        });
        appendServerSession(sessionPath, messages);
      });
    }

    rl.close();
    process.stdout.write("[server] session closed.\n");
  } else {
    process.stdout.write(
      "[server] orchestrator agent disabled (LLM auth error above). " +
        "REST + web listeners are up — workers can heartbeat/register/poll. " +
        "Fix the LLM auth and restart `mai server`.\n",
    );
    // Hold the process on the HTTP listeners until aborted.
    await new Promise<void>((resolve) => {
      abortController.signal.addEventListener("abort", () => resolve());
    });
  }
}
