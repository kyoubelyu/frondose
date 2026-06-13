/** P-23: `mai telegram poll` — long-running launchd-supervised daemon (plan §6.3).
 *
 * Builds the same agent stack as runRepl (without readline), then runs
 * startDaemonPoller. Daemon hibernates `handleTelegramTurn` whenever `repl.pid`
 * is alive; Chrome boot is gated by `chromeAcquireGuard` so daemon yields to
 * REPL on conflict.
 */
import path from "node:path";
import type { CoreMessage } from "ai";
import { resolveModel } from "../../agent/modelResolver.js";
import { frondoseEnv } from "../../env.js";
import { BOUNDARY } from "../../agent/systemPrompt/boundary.js";
import { CHECKPOINT } from "../../agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../../agent/systemPrompt/compose.js";
import { composeSoulBand } from "../../agent/systemPrompt/soul.js";
import { TurnLock } from "../../agent/turnSemaphore.js";
import { createLinkedinSession } from "../../linkedin/index.js";
import { makeAuditWriter } from "../../persistence/audit.js";
import { bootMigrateOrExit } from "../../persistence/dataDirMigration.js";
import { readIdentity } from "../../persistence/identity.js";
import { DATA_DIR_NAME, getHomeBase } from "../../persistence/paths.js";
import { isAlive, isPidAlive, readPid, removePid, writePid } from "../../persistence/processLock.js";
import { appendMessagesShared, sharedSessionPath } from "../../persistence/sharedSession.js";
import { readTelegramConfig } from "../../persistence/telegramConfig.js";
import { makeAllTools } from "../../tools/index.js";
import { type PollerHandle, startDaemonPoller, type TelegramTurnDeps } from "../replTelegram.js";

const TELEGRAM_PID = (): string => path.join(getHomeBase(), DATA_DIR_NAME, "agent", "telegram.pid");
const REPL_PID = (): string => path.join(getHomeBase(), DATA_DIR_NAME, "agent", "repl.pid");

export async function runTelegramDaemon(): Promise<void> {
  bootMigrateOrExit(getHomeBase());

  // (1) PID mutex — refuse if another daemon is alive; reap stale otherwise.
  const ourPidPath = TELEGRAM_PID();
  const existing = readPid(ourPidPath);
  if (existing !== null && isAlive(existing)) {
    process.stderr.write(`[telegram daemon] already running, PID ${existing}\n`);
    process.exit(1);
  }
  writePid(ourPidPath);

  // (2) Cleanup hooks: clear pidfile on any exit path.
  const cleanup = (): void => removePid(ourPidPath);
  process.once("exit", cleanup);
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  // (3) Required env + cfg validation.
  if (!process.env.TELEGRAM_TOKEN) {
    process.stderr.write("[telegram daemon] TELEGRAM_TOKEN unset; exit\n");
    cleanup();
    process.exit(1);
  }
  const tcPath = frondoseEnv("TELEGRAM_CONFIG_PATH") ?? path.join(getHomeBase(), DATA_DIR_NAME, "agent", "telegram.json");
  const cfg = readTelegramConfig(tcPath);
  if (cfg.boundUserId === null) {
    process.stderr.write("[telegram daemon] boundUserId null; run `mai telegram bind` first\n");
    cleanup();
    process.exit(1);
  }

  // (4) Build agent stack — identical signature to runRepl setup.
  const identityPath = frondoseEnv("IDENTITY_PATH") ?? path.join(getHomeBase(), DATA_DIR_NAME, "agent", "identity.json");
  const memoryDbPath = frondoseEnv("MEMORY_DB_PATH") ?? path.join(getHomeBase(), DATA_DIR_NAME, "agent", "memory.sqlite");
  const auditPath = frondoseEnv("AUDIT_PATH") ?? path.join(getHomeBase(), DATA_DIR_NAME, "agent", "audit.jsonl");
  const cdpPort = frondoseEnv("CDP_PORT") ? parseInt(frondoseEnv("CDP_PORT") ?? "", 10) : 9222;
  const profileDir = frondoseEnv("PROFILE_DIR") ?? path.join(getHomeBase(), DATA_DIR_NAME, "agent", "chrome-profile");

  const identity = readIdentity(identityPath);
  const model = resolveModel({});
  const system = composeSystemPrompt({
    boundary: BOUNDARY,
    soul: composeSoulBand(identity),
    checkpoint: CHECKPOINT,
  });

  // Shared session — daemon ALWAYS appends here.
  const sessionFilePath = sharedSessionPath();
  const messages: CoreMessage[] = [];

  const linkedinSession = createLinkedinSession({
    port: cdpPort,
    profileDir,
    // P-23 §6.5: refuse Chrome boot while REPL holds the lock.
    chromeAcquireGuard: () => !isPidAlive(REPL_PID()),
  });
  const abortController = new AbortController();
  const control = { requestStop: () => abortController.abort(), auditPath };
  const auditWriter = makeAuditWriter(auditPath);
  const tools = makeAllTools(linkedinSession, { memoryDbPath, identityPath }, control, undefined);

  const turnLock = new TurnLock();
  const deps: TelegramTurnDeps = {
    model,
    system,
    messages,
    tools,
    sessionFile: { path: sessionFilePath },
    abortSignal: abortController.signal,
    onStepFinish: auditWriter,
    out: process.stdout,
    configPath: tcPath,
    uploadAllowlistRoot: frondoseEnv("UPLOAD_ALLOWLIST") ?? path.join(getHomeBase(), DATA_DIR_NAME, "agent", "uploads"),
    // P-23 §6.7: daemon always uses the shared-session writer.
    appendMessages: appendMessagesShared,
  };

  // (5) Start the daemon-mode poller (REPL-pause + cross-process lock gates).
  process.stdout.write(`[telegram daemon] up, PID ${process.pid}, session ${sessionFilePath}\n`);
  const abort = new AbortController();
  const handle: PollerHandle = await startDaemonPoller(cfg, deps, turnLock, abort);
  void handle; // referenced for type-symmetry with §6.3 sketch

  // (6) Keep the event loop alive until abort.
  await new Promise<void>((resolve) => {
    abort.signal.addEventListener("abort", () => resolve());
  });
  cleanup();
}
