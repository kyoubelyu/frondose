/** P-25: `mai server daemon` — launchd-invoked. Telegram-only; no readline.
 *  Mirrors src/cli/subcommands/telegramDaemon.ts but uses server-specific
 *  paths, identity, and tool set (mode="server", 14 tools). */
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreMessage } from "ai";
import { frondoseEnv } from "../env.js";
import { resolveModelOrNull } from "../agent/modelResolver.js";
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
import { isAlive, readPid, removePid, writePid } from "../persistence/processLock.js";
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
// Step-3b C-3 fix: import serverSessionFile so daemon uses the auto-mkdir helper.
import { serverSessionFile } from "../persistence/serverSession.js";
import { readTelegramConfig } from "../persistence/telegramConfig.js";
import { openWorkersDb } from "../persistence/workersRegistry.js";
import { makeAllTools } from "../tools/index.js";
import { drainDueJobs, type RunCronTurnDeps } from "./replCron.js";
import { type PollerHandle, startDaemonPoller, type TelegramTurnDeps } from "./replTelegram.js";
import { startServerHttp } from "./serverHttp.js";
import { startWebHttp } from "./serverWeb.js";

export interface DaemonHandles {
  httpServer: Server;
  webServer: Server;
  abort: () => void;
  drainPoller: PollerHandle | null;
}

let captureFn: ((handles: DaemonHandles) => void) | null = null;

/** @internal — test-only DI hook. */
export function __captureDaemonHandles(fn: ((handles: DaemonHandles) => void) | null): void {
  captureFn = fn;
}

/** @internal — test-only DI hook reset. */
export function __resetCaptureDaemonHandles(): void {
  captureFn = null;
}

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
      "[server daemon] TELEGRAM_TOKEN unset (did FRONDOSE_SERVER_TELEGRAM_TOKEN propagate via plist?); exit\n",
    );
    cleanup();
    process.exit(1);
  }
  // Step-5a D-SRV.DAEMON.CONFIGPATH: pass SERVER_CONFIG_PATH() so boundUserId is
  // read from ~/.frondose/server/config.json (not the worker's ~/.frondose/agent/config.json).
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

  // Step-3b C-2: ONE AbortController drives both agent loop + Telegram poller.
  const abortController = new AbortController();
  const control = { requestStop: () => abortController.abort(), auditPath: SERVER_AUDIT_PATH() };
  const auditWriter = makeAuditWriter(SERVER_AUDIT_PATH());

  // P-26: open server-side DB handles ONCE per daemon boot. Threaded both into
  //   `makeAllTools` (for list_workers + send_worker_message) AND into the HTTP
  //   listener handlers below.
  const workersDb = openWorkersDb(SERVER_WORKERS_DB_PATH());
  const serverInboxDb = openServerInboxDb(SERVER_INBOX_DB_PATH());
  // P-28: credential library handle (LLM keys + Google accounts).
  const credentialsDb = openCredentialsDb(SERVER_CREDENTIALS_DB_PATH());
  const serverCfg = readConfig(SERVER_CONFIG_PATH());

  // mode="server" — 20 tools (P-31+).
  const tools = makeAllTools(
    undefined, // no session
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
    undefined, // no hookRunner at P-26
    { mode: "server" },
  );

  // P-26: server-side HTTP listener (Tailscale-private; defaults to 127.0.0.1).
  const httpServer = startServerHttp(
    { workersDb, serverInboxDb },
    serverCfg.server.bind_address ?? null,
    serverCfg.server.rest_port, // P-36 F-D2: configurable REST port (default 3031)
  );
  // Best-effort HTTP teardown on shutdown (registered alongside pid cleanup).
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
  const messages: CoreMessage[] = [];
  // Step-3b C-3 fix: serverSessionFile() auto-creates ~/.frondose/server/sessions/.
  const sessionFile = { path: serverSessionFile() };
  let pollerHandle: PollerHandle | null = null;

  // P-36 F-B (B2): resolve the LLM WITHOUT throwing — the REST + web listeners
  // are already bound above, so a bad LLM config degrades the orchestrator agent
  // rather than crashing the fleet-coordination plane.
  const model = resolveModelOrNull();
  if (model) {
    const system = composeSystemPrompt({
      boundary: SERVER_BOUNDARY,
      soul: composeServerSoulBand(identity),
      checkpoint: CHECKPOINT,
    });
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
      uploadAllowlistRoot: frondoseEnv("UPLOAD_ALLOWLIST") ?? path.join(getHomeBase(), DATA_DIR_NAME, "agent/uploads"),
      // P-26 Step-5a B-26R-1: prepend pending worker events to each Telegram-driven
      // user turn (capped at MAX_PER_DRAIN=20 rows per call inside drainServerInbox).
      inboxPrefix: () => drainServerInbox(serverInboxDb),
    };

    // P-31 (D-4): server cron tick — boot drain + 60 s interval, turnLock-serialized.
    // The boot drain runs before the hold-Promise below so a due job fires at startup.
    const cronDeps: RunCronTurnDeps = {
      model,
      system,
      messages,
      tools,
      sessionFile: sessionFile.path,
      abortSignal: abortController.signal,
      onStepFinish: auditWriter,
      out: process.stdout,
    };
    await turnLock.run(() => drainDueJobs(SERVER_SCHEDULE_PATH(), abortController.signal, cronDeps));
    const cronTick = setInterval(() => {
      void turnLock.run(() => drainDueJobs(SERVER_SCHEDULE_PATH(), abortController.signal, cronDeps));
    }, 60_000);
    cronTick.unref();

    process.stdout.write(`[server daemon] up, PID ${process.pid}, session ${sessionFile.path}\n`);
    // Step-3b C-2: pass unified abortController to poller; SIGTERM path handles
    // process.exit(0) directly (see handler above).
    pollerHandle = await startDaemonPoller(cfg, deps, turnLock, abortController);
  } else {
    process.stdout.write(
      `[server daemon] up, PID ${process.pid} — orchestrator agent DISABLED (LLM auth error above). ` +
        "REST + web listeners are up; workers can heartbeat/register/poll. " +
        "Fix the LLM auth and restart `mai server`.\n",
    );
  }
  if (captureFn) {
    captureFn({
      httpServer,
      webServer,
      abort: () => abortController.abort(),
      drainPoller: pollerHandle,
    });
  }
  await new Promise<void>((resolve) => {
    abortController.signal.addEventListener("abort", () => resolve());
  });
}
