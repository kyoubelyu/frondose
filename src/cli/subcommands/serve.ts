// P-56a M-1 SCAFFOLD: HTTP-over-UDS bridge for the v0.5 Tauri desktop shell.
// P-56b extension: agent loop + SSE events + audit-tail + overlay contextId bridge.
//
// Endpoints:
//   GET  /health
//   GET  /identity
//   POST /chrome/ensure
//   POST /agent/turn
//   GET  /agent/events
//   POST /agent/abort
//   POST /agent/retry
//   GET  /audit/tail

import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import { dirname, join } from "node:path";
import { HookRunner } from "../../agent/hooks.js";
import { resolveMaxSteps } from "../../agent/maxSteps.js";
import { resolveModelOrNull } from "../../agent/modelResolver.js";
import { frondoseEnv } from "../../env.js";
import { BOUNDARY, BOUNDARY_RESUME } from "../../agent/systemPrompt/boundary.js";
import { CHECKPOINT, CHECKPOINT_RESUME } from "../../agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../../agent/systemPrompt/compose.js";
import { resolveSoulBand, soulModeFragment } from "../../agent/systemPrompt/soul.js";
import { createWorkflowController } from "../../agent/workflow/controller.js";
import { createLinkedinSession } from "../../linkedin/session.js";
import { makeAuditWriter, writeWorkflowAudit } from "../../persistence/audit.js";
import { DEFAULT_CONFIG_PATH, readConfig } from "../../persistence/config.js";
import { DEFAULT_IDENTITY_PATH, readIdentity } from "../../persistence/identity.js";
import { readMode } from "../../persistence/mode.js";
import { DATA_DIR_NAME, getHomeBase } from "../../persistence/paths.js";
import { countAutoLedgerByAction, DEFAULT_SALES_DB_PATH, getAutoRun } from "../../persistence/salesDb.js";
import { modeFromState } from "../../tauri/ui/mode.js";
import type { ControlSignals } from "../../tools/index.js";
import { makeAllTools } from "../../tools/index.js";
import { getSalesDb } from "../../tools/sales/_dbHandle.js";
import { PassiveRateLimiter, passiveRateLimiterOptsFromEnv } from "./passiveRateLimit.js";
import type { ServeDeps, ServeEmitter, ServeState, SseFrame } from "./serve/context.js";
import { createCronDriver } from "./serve/cron.js";
import { createOverlayDispatcher } from "./serve/dispatch.js";
import { removeSocket } from "./serve/http.js";
import { createPassiveHandlers } from "./serve/passive.js";
import { createRequestHandler, ensureOverlaySubscription } from "./serve/routes.js";
import { makeTakeoverVisualDriver } from "./serve/takeover.js";
import { createTurnRunner } from "./serve/turn.js";
import { pushWorkflowToOverlay } from "./serve/workflowOverlay.js";

export interface ServeOpts {
  sockPath: string;
  bearerToken: string;
}

const AUDIT_PATH = (): string => join(getHomeBase(), DATA_DIR_NAME, "agent", "audit.jsonl");
export async function runServeSubcommand(opts: ServeOpts): Promise<void> {
  const parentDir = dirname(opts.sockPath);
  mkdirSync(parentDir, { recursive: true });
  try {
    chmodSync(parentDir, 0o700);
  } catch (e) {
    process.stderr.write(
      `[mai serve] warn: chmod 0o700 on ${parentDir} failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }

  const cfg = readConfig(DEFAULT_CONFIG_PATH());
  const identity = readIdentity(DEFAULT_IDENTITY_PATH());
  // P-SP-C: derive the boot-time mode from the same two source-of-truth flags
  // used to initialize ServeState below — single read site keeps soul band +
  // initial state consistent. Runtime mode flips (via /agent/passive-mode or
  // /agent/cron-mode) update state.passiveEnabled / state.cronEnabled but do
  // NOT recompose the system prompt; the per-turn passive prompt carries the
  // Magical directives for the turn that fires.
  const cronEnabledAtBoot = readMode() === "auto";
  const passiveEnabledAtBoot = (frondoseEnv("PASSIVE_SUGGEST") ?? "off").toLowerCase() === "on";
  const bootMode = modeFromState({ cronEnabled: cronEnabledAtBoot, passiveEnabled: passiveEnabledAtBoot });
  const soulBand = `${resolveSoulBand(cfg.soul.override, identity)}\n\n${soulModeFragment(bootMode)}`;
  const system = composeSystemPrompt({ boundary: BOUNDARY, soul: soulBand, checkpoint: CHECKPOINT });
  const systemResume = composeSystemPrompt({
    boundary: BOUNDARY_RESUME,
    soul: soulBand,
    checkpoint: CHECKPOINT_RESUME,
  });
  // P-APP-8: tolerant boot. A missing or invalid LLM key must not crash the sidecar.
  // resolveModelOrNull writes one actionable stderr line and returns null; Settings
  // can hydrate deps.model later through reloadAgentDeps without a restart.
  const model = resolveModelOrNull({});
  const maxSteps = resolveMaxSteps(undefined);
  const profileDir = frondoseEnv("PROFILE_DIR") ?? join(getHomeBase(), DATA_DIR_NAME, "agent", "chrome-profile");
  const memoryDbPath = join(getHomeBase(), DATA_DIR_NAME, "agent", "memory.sqlite");
  const identityPath = DEFAULT_IDENTITY_PATH();
  const schedulePath = join(getHomeBase(), DATA_DIR_NAME, "agent", "schedule.jsonl");
  const salesDbPath = DEFAULT_SALES_DB_PATH();
  const auditPath = AUDIT_PATH();
  const auditWriter = makeAuditWriter(auditPath);
  const session = createLinkedinSession({
    port: 9222,
    profileDir,
    inputMode: cfg.worker.input_mode,
    onClientBooted: (client) => ensureOverlaySubscription(state, deps, dispatch.dispatchOverlayEvent, client),
  });
  const state: ServeState = {
    currentTurn: null,
    overlayContextId: undefined,
    unsubscribeContextId: undefined,
    unsubscribeOverlayEvents: undefined,
    cronEnabled: cronEnabledAtBoot,
    // P-57g (D-DOGFOOD-07): passive auto-react HIDDEN by default — opt in via MAI.app toggle
    // (frondose_set_passive_mode → POST /agent/passive-mode) OR MAI_PASSIVE_SUGGEST=on env.
    passiveEnabled: passiveEnabledAtBoot,
    autoRunId: null,
    lastTurnUserPrompt: null,
    lastFailedTurnPrompt: null,
    retryAttempts: 0,
    messages: [],
    passiveProfileCache: new Map(),
    passiveLimiter: new PassiveRateLimiter(passiveRateLimiterOptsFromEnv()),
    sseClients: new Set<ServerResponse>(),
  };
  // P-Y2.3: wire the Auto-mode takeover visual driver into the session so browser tools can paint the
  // agent cursor + element highlight before a click (Auto-gated inside the driver; no-op in Manual/headless).
  session.setVisualDriver?.(makeTakeoverVisualDriver(state, session));
  const control: ControlSignals = {
    requestStop: () => state.currentTurn?.abortController.abort(),
    auditPath,
  };
  const hookRunner = new HookRunner();
  const workerId = identity?.fullName ?? os.hostname();
  const tools = makeAllTools(session, { memoryDbPath, identityPath, schedulePath, salesDbPath }, control, hookRunner, {
    mode: "worker",
    workerId,
  });

  const emitter: ServeEmitter = new EventEmitter();
  const workflow = createWorkflowController({
    emitFrame: (frame) => {
      emitter.emit("sse-frame", frame);
      pushWorkflowToOverlay(state, session, workflow, frame);
    },
    writeWorkflowAudit: (event) => writeWorkflowAudit(auditPath, event),
  });
  session.canClickOutbound = (_label, _surface) => workflow.hasApprovedOutboundStep();
  session.autoRun = () => {
    if (state.autoRunId === null) return null;
    const db = getSalesDb(salesDbPath);
    const row = getAutoRun(db, state.autoRunId);
    if (!row || row.status !== "running") return null;
    const counters = countAutoLedgerByAction(db, row.id);
    return {
      runId: row.id,
      maxConnects: row.maxConnects,
      connectSentCount: counters.connect_sent ?? 0,
    };
  };
  const broadcast = (frame: SseFrame): void => {
    const data = `data: ${JSON.stringify(frame)}\n\n`;
    for (const res of state.sseClients) {
      try {
        res.write(data);
      } catch {
        // Zombie client; res.on("close") handles cleanup.
      }
    }
  };
  emitter.on("sse-frame", broadcast);
  emitter.on("overlay-event", (event) => broadcast({ type: "overlay-event", event }));

  let cronInterval: ReturnType<typeof setInterval> | null = null;
  const expectedToken = Buffer.from(opts.bearerToken, "utf-8");
  const deps: ServeDeps = {
    model,
    system,
    systemResume,
    tools,
    maxSteps,
    auditWriter,
    session,
    schedulePath,
    salesDbPath,
    auditPath,
    expectedToken,
    workflow,
    emitFrame: (frame) => emitter.emit("sse-frame", frame),
    emitOverlayEvent: (event) => emitter.emit("overlay-event", event),
  };
  const turn = createTurnRunner(state, deps);
  const passive = createPassiveHandlers(state, deps);
  const dispatch = createOverlayDispatcher(state, deps, turn, passive);
  const routes = createRequestHandler(state, deps, turn, dispatch);
  const cron = createCronDriver(state, deps, turn);

  cronInterval = setInterval(() => {
    void cron.tick();
  }, 60_000);
  cronInterval.unref();

  const server = createServer((req, res) => {
    void routes.handleRequest(req, res);
  });

  const shutdown = (signal: string) => {
    process.stdout.write(`[mai serve] ${signal} - shutting down\n`);
    if (state.currentTurn) state.currentTurn.abortController.abort();
    if (state.unsubscribeContextId) state.unsubscribeContextId();
    if (state.unsubscribeOverlayEvents) state.unsubscribeOverlayEvents();
    if (cronInterval) {
      clearInterval(cronInterval);
      cronInterval = null;
    }
    for (const res of state.sseClients) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    state.sseClients.clear();
    server.close(() => {
      removeSocket(opts.sockPath);
      process.exit(0);
    });
    setTimeout(() => {
      removeSocket(opts.sockPath);
      process.exit(0);
    }, 2000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.sockPath, () => {
      server.off("error", reject);
      chmodSync(opts.sockPath, 0o600);
      process.stdout.write(`[mai serve] listening on ${opts.sockPath}\n`);
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    server.on("close", () => resolve());
  });
}
