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
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { HookRunner } from "../../agent/hooks.js";
import { resolveMaxSteps } from "../../agent/maxSteps.js";
import { resolveModelOrNull } from "../../agent/modelResolver.js";
import { BOUNDARY, BOUNDARY_RESUME } from "../../agent/systemPrompt/boundary.js";
import { CHECKPOINT, CHECKPOINT_RESUME } from "../../agent/systemPrompt/checkpoint.js";
import { composeSystemPrompt } from "../../agent/systemPrompt/compose.js";
import { resolveSoulBand, soulModeFragment } from "../../agent/systemPrompt/soul.js";
import { createWorkflowController } from "../../agent/workflow/controller.js";
import { frondoseEnv } from "../../env.js";
import { createLinkedinSession } from "../../linkedin/session.js";
import { makeAuditWriter, writeWorkflowAudit } from "../../persistence/audit.js";
import { DEFAULT_CONFIG_PATH, readConfig } from "../../persistence/config.js";
import { DEFAULT_IDENTITY_PATH, readIdentity } from "../../persistence/identity.js";
import { readMode } from "../../persistence/mode.js";
import { DATA_DIR_NAME, getHomeBase } from "../../persistence/paths.js";
import {
  type AutoRunRow,
  countAutoLedgerByAction,
  countOutboundSince,
  DEFAULT_SALES_DB_PATH,
  getCurrentAutoRun,
  lastOutboundAt,
  resolveOutboundGuardrails,
  utcStartOfDay,
} from "../../persistence/salesDb.js";
import { type AppMode, modeFromState } from "../../tauri/ui/mode.js";
import type { ControlSignals } from "../../tools/index.js";
import { makeAllTools } from "../../tools/index.js";
import { getSalesDb } from "../../tools/sales/_dbHandle.js";
import { PassiveRateLimiter, passiveRateLimiterOptsFromEnv } from "./passiveRateLimit.js";
import type { ServeDeps, ServeEmitter, ServeState, SseFrame } from "./serve/context.js";
import { createCronDriver } from "./serve/cron.js";
import { createOverlayDispatcher } from "./serve/dispatch.js";
import { removeFile } from "./serve/http.js";
import { createPassiveHandlers } from "./serve/passive.js";
import { createRequestHandler, ensureOverlaySubscription } from "./serve/routes.js";
import { makeTakeoverVisualDriver } from "./serve/takeover.js";
import { createTurnRunner } from "./serve/turn.js";
import { pushWorkflowToOverlay } from "./serve/workflowOverlay.js";

export interface ServeOpts {
  /** WIN-1: path the sidecar writes its chosen loopback TCP port to (parent Tauri polls it). */
  portFile: string;
  bearerToken: string;
}

const AUDIT_PATH = (): string => join(getHomeBase(), DATA_DIR_NAME, "agent", "audit.jsonl");

/**
 * P-AUTO-1+2 (B-1 fix): pure mode-aware outbound authorization predicate.
 *
 * The load-bearing safety invariant: Manual and Magical turns MUST always require
 * `workflow.hasApprovedOutboundStep()` — a stale `running` auto_runs row from a prior
 * Auto run that wasn't cleanly ended (operator aborted, mode toggled to Manual/Magical,
 * /agent/turn force-released) MUST NOT authorize outbound past the manual approval gate.
 *
 * Returns true ONLY when the resolved runtime mode is Auto AND a running auto-run row
 * exists. Manual/Magical callers fall back to the workflow approval gate.
 */
export function isAutoOutboundAuthorized(opts: { resolvedMode: AppMode; runningRun: AutoRunRow | null }): boolean {
  return opts.resolvedMode === "auto" && opts.runningRun?.status === "running";
}
export async function runServeSubcommand(opts: ServeOpts): Promise<void> {
  // WIN-1: the port-file's parent dir holds only the chosen port (not a secret); the
  // bearer token + 127.0.0.1 bind are the guard — no chmod (cross-platform).
  mkdirSync(dirname(opts.portFile), { recursive: true });

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
  // P-AUTO-1+2 (B-1+B-2 fix): mode-aware outbound authorization, fail-closed.
  session.canClickOutbound = (_label, _surface) => {
    const resolvedMode = modeFromState({
      cronEnabled: state.cronEnabled,
      passiveEnabled: state.passiveEnabled,
    });
    if (resolvedMode === "auto") {
      // Auto: outbound is authorized EXCLUSIVELY by a running auto-run row. NO fallback to the
      // workflow approval gate — a stale auto workflow, or Auto with no running run, must NEVER
      // authorize outbound (B-1). An out-of-Auto mode flip drops to the branch below (B-2).
      const db = getSalesDb(salesDbPath);
      const runningRun = getCurrentAutoRun(db);
      return isAutoOutboundAuthorized({ resolvedMode, runningRun });
    }
    // Manual/Magical: a genuine per-step operator approval is required. hasApprovedOutboundStep
    // no longer honors a stale approvalMode==="auto" (B-2 — short-circuit removed, FIX 2).
    return workflow.hasApprovedOutboundStep();
  };
  // P-AUTO-1+2 (B-1 defense-in-depth): resolved-mode probe for the click-path hard gate so it
  // can independently require a running auto-run in Auto (in-tool backstop to canClickOutbound).
  session.resolvedMode = () => modeFromState({ cronEnabled: state.cronEnabled, passiveEnabled: state.passiveEnabled });
  // P-AUTO-1+2 (B-1 fix): DB-authoritative active-run probe. Drops the null-blind
  // short-circuit at the prior :141 (`if state.autoRunId === null return null`) — that
  // hid operator-started auto_runs rows because `start_auto_run` never sets
  // `state.autoRunId`. Now reads `getCurrentAutoRun(db)` directly so cron + operator
  // entry points both surface to every consumer (click guard, cap watcher, daily probe).
  session.autoRun = () => {
    const db = getSalesDb(salesDbPath);
    const row = getCurrentAutoRun(db);
    if (!row || row.status !== "running") return null;
    const counters = countAutoLedgerByAction(db, row.id);
    return {
      runId: row.id,
      maxConnects: row.maxConnects,
      connectSentCount: counters.connect_sent ?? 0,
    };
  };
  // P-AUTO-1+2 (§3.3): fresh-snapshot daily/cooldown probe consumed by the click-path
  // hard gate. Computes per-call (NOT cached per-turn) so a recently-sent outbound is
  // reflected immediately. UTC window anchor (utcStartOfDay) replaces the prior
  // local-midnight slice — deterministic cross-timezone behavior.
  session.dailyOutbound = () => {
    const db = getSalesDb(salesDbPath);
    const { dailyCap, cooldownMs } = resolveOutboundGuardrails();
    const sentToday = countOutboundSince(db, utcStartOfDay());
    const remaining = Math.max(0, dailyCap - sentToday);
    const lastTs = lastOutboundAt(db);
    const cooldownRemainingMs = lastTs === null ? 0 : Math.max(0, cooldownMs - (Date.now() - lastTs));
    return { remaining, cooldownRemainingMs };
  };
  // P-AUTO-1+2 (G-A2.Count): wire the sales DB path so click.ts can append the
  // deterministic connect_sent/success ledger row after a successful CDP dispatch.
  session.salesDbPath = salesDbPath;
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
      removeFile(opts.portFile);
      process.exit(0);
    });
    setTimeout(() => {
      removeFile(opts.portFile);
      process.exit(0);
    }, 2000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // WIN-1: bind an OS-assigned ephemeral port on loopback; write the chosen port to
    // the port-file ATOMICALLY (.tmp + rename) so the parent Tauri can read it.
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const port = (server.address() as AddressInfo).port;
      const tmp = `${opts.portFile}.tmp`;
      writeFileSync(tmp, String(port), "utf-8");
      renameSync(tmp, opts.portFile);
      process.stdout.write(`[mai serve] listening on 127.0.0.1:${port}\n`);
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    server.on("close", () => resolve());
  });
}
