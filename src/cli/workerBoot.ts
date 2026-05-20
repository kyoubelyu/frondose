import { existsSync, unlinkSync } from "node:fs";
import os from "node:os";
import type { CoreMessage } from "ai";
import { HookRunner } from "../agent/hooks.js";
import { resolveMaxSteps } from "../agent/maxSteps.js";
import { resolveModel } from "../agent/modelResolver.js";
import { BOUNDARY } from "../agent/systemPrompt/boundary.js";
import { CHECKPOINT } from "../agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../agent/systemPrompt/compose.js";
import { resolveSoulBand } from "../agent/systemPrompt/soul.js";
import { TurnLock } from "../agent/turnSemaphore.js";
import { createLinkedinSession } from "../linkedin/index.js";
import { makeAuditWriter } from "../persistence/audit.js";
import { DEFAULT_CONFIG_PATH, readConfig } from "../persistence/config.js";
import { type IdentityRecord, readIdentity } from "../persistence/identity.js";
import { setSafeModeServerUrl } from "../persistence/safeModeState.js";
import { readSecrets } from "../persistence/secrets.js";
import { continueRecent, loadMessages } from "../persistence/session.js";
import { loadMessagesShared, sharedSessionPath } from "../persistence/sharedSession.js";
import { readTelegramConfig } from "../persistence/telegramConfig.js";
import { WORKER_INBOX_DB_PATH } from "../persistence/workerInbox.js";
import type { ControlSignals } from "../tools/index.js";
import { makeAllTools } from "../tools/index.js";
import { promptFreeAxesAndPersist, runIdentityBootstrap } from "./identity-init.js";
import { runOneShot, runRepl } from "./repl.js";
import { startWorkerHeartbeat } from "./workerHeartbeat.js";
import { startWorkerServerPoll } from "./workerServerPoll.js";

export interface BootWorkerInputs {
  cdpPort: number;
  profileDir: string;
  memoryDbPath: string;
  identityPath: string;
  auditPath: string;
  schedulePath: string;
  telegramConfigPath: string;
  opts: {
    model?: string;
    prompt?: string;
    newSession: boolean;
    cwd: string;
    resetIdentity: boolean;
    maxSteps?: string;
  };
}

export type WorkerBootInputs = BootWorkerInputs;

export async function bootWorker(inputs: BootWorkerInputs): Promise<void> {
  const { cdpPort, profileDir, memoryDbPath, identityPath, auditPath, schedulePath, telegramConfigPath, opts } = inputs;

  // P-4 identity bootstrap (BEFORE Chrome boot — readline owns stdin).
  if (opts.resetIdentity && existsSync(identityPath)) unlinkSync(identityPath);
  if (!existsSync(identityPath)) await runIdentityBootstrap(identityPath);

  // A-6 / D-1: ONE readConfig() at the top of bootWorker, threaded through.
  const cfg = readConfig(DEFAULT_CONFIG_PATH());

  // A-7 / D-2: ONE readIdentity() initially; re-read only if axes prompt fires.
  let identity: IdentityRecord | null = readIdentity(identityPath);
  if (identity && !identity.freeAxes) {
    if (process.stdin.isTTY && !opts.prompt) {
      await promptFreeAxesAndPersist(identityPath);
      identity = readIdentity(identityPath);
    } else {
      process.stderr.write(
        "[mai] freeAxes not yet picked — using methodology defaults. Run `mai soul reset` to set them.\n",
      );
    }
  }

  const model = resolveModel({ cli: opts.model });
  const maxSteps = resolveMaxSteps(opts.maxSteps);

  const system = composeSystemPrompt({
    boundary: BOUNDARY,
    soul: resolveSoulBand(cfg.soul.override, identity),
    checkpoint: CHECKPOINT,
  });

  const tgCfgForSession = readTelegramConfig(telegramConfigPath);
  const usingShared = tgCfgForSession.enabled;
  const sessionFile = usingShared ? sharedSessionPath() : continueRecent(opts.cwd, { newSession: opts.newSession });
  const messages: CoreMessage[] = usingShared ? loadMessagesShared(sessionFile) : loadMessages(sessionFile);

  const linkedinSession = createLinkedinSession({
    port: cdpPort,
    profileDir,
    inputMode: cfg.worker.input_mode,
  });

  const heartbeatInterval = setInterval(() => {
    linkedinSession.heartbeat().catch(() => {
      /* best-effort */
    });
  }, 30_000);
  heartbeatInterval.unref();

  const abortController = new AbortController();
  const control: ControlSignals = {
    requestStop: () => abortController.abort(),
    auditPath,
  };
  const auditWriter = makeAuditWriter(auditPath);
  const hookRunner = new HookRunner();

  const workerSecrets = readSecrets();
  const workerId = identity?.fullName ?? os.hostname();
  if (cfg.server.url) {
    if (workerSecrets.server?.token) {
      setSafeModeServerUrl(cfg.server.url);
      const coords = {
        serverUrl: cfg.server.url,
        token: workerSecrets.server.token,
        workerId,
      };
      startWorkerHeartbeat(coords, abortController.signal);
      startWorkerServerPoll(coords, WORKER_INBOX_DB_PATH(), abortController.signal, cfg.server.poll_interval_s * 1000);
    } else {
      process.stderr.write("[mai] config.server.url set but secrets.server.token missing — server features disabled\n");
    }
  }

  const turnLock = new TurnLock();
  const tools = makeAllTools(linkedinSession, { memoryDbPath, identityPath, schedulePath }, control, hookRunner, {
    mode: "worker",
    workerId,
  });

  if (typeof opts.prompt === "string" && opts.prompt.length > 0) {
    await runOneShot({
      model,
      system,
      messages,
      tools,
      maxSteps,
      sessionFile,
      cwd: opts.cwd,
      prompt: opts.prompt,
      abortSignal: abortController.signal,
      onStepFinish: auditWriter,
      turnLock,
      telegramConfigPath,
    });
    process.exit(0);
  }

  await runRepl({
    model,
    system,
    messages,
    tools,
    maxSteps,
    linkedinSession,
    sessionFile,
    cwd: opts.cwd,
    abortController,
    abortSignal: abortController.signal,
    onStepFinish: auditWriter,
    schedulePath,
    turnLock,
    telegramConfigPath,
    control,
  });
  process.exit(0);
}
