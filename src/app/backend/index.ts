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

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import type { Database as DB } from "better-sqlite3";
import { HookRunner } from "../../agent/hooks.js";
import { resolveMaxSteps } from "../../agent/maxSteps.js";
import { resolveModelOrNull } from "../../agent/modelResolver.js";
import { BOUNDARY, BOUNDARY_RESUME, boundaryLanguageDirective } from "../../agent/systemPrompt/boundary.js";
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
import { clearWatchdogKills, DATA_DIR_NAME, getHomeBase, readWatchdogKillTimestamps } from "../../persistence/paths.js";
import { findDraftForDeclinedStep, findPendingPostDraftId, markDraftRejected } from "../../persistence/sales/drafts.js";
import {
  type AutoRunRow,
  countOutboundSince,
  countSuccessfulConnects,
  DEFAULT_SALES_DB_PATH,
  getCurrentAutoRun,
  lastOutboundAt,
  resolveOutboundGuardrails,
  utcStartOfDay,
} from "../../persistence/salesDb.js";
import { readTelegramConfig, writeTelegramConfig } from "../../persistence/telegramConfig.js";
import { type AppMode, modeFromState } from "../../tauri/ui/mode.js";
import { personNameFromInviteLabel } from "../../tools/browser/outboundGuard.js";
import type { ControlSignals } from "../../tools/index.js";
import { makeAllTools } from "../../tools/index.js";
import { getSalesDb } from "../../tools/sales/_dbHandle.js";
import { downloadTelegramFile } from "../../tools/telegram/inboundMedia.js";
import { telegramFetch } from "../../tools/telegram/transport.js";
import type { ServeDeps, ServeEmitter, ServeState, SseFrame } from "./context.js";
import { createCronDriver } from "./cron.js";
import { createOverlayDispatcher } from "./dispatch.js";
import { removeFile } from "./http.js";
import { createPassiveHandlers } from "./passive.js";
import { PassiveRateLimiter, passiveRateLimiterOptsFromEnv } from "./passiveRateLimit.js";
import { createRequestHandler, ensureOverlaySubscription } from "./routes.js";
import { makeTakeoverVisualDriver } from "./takeover.js";
import {
  createTelegramChannel,
  type TelegramAuditEvent,
  type TelegramMedia,
  type TelegramUpdate,
} from "./telegramChannel.js";
import { reapKillCappedRun, reapOrphanIfIdle } from "./turn/reaper.js";
import { createTurnRunner } from "./turn.js";
import { clearCurrentTurnIfOwned } from "./turnOwnership.js";
import { pushWorkflowToOverlay } from "./workflowOverlay.js";

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

/**
 * P-AUTO-6: connect-surface integrity. Pure DB-lookup seam that decides whether a click on the
 * search/network sidebar "Invite <Name> to connect" must be blocked because a personalized
 * connect_note was drafted for that exact person. The sidebar invite sends with NO modal, so
 * a note-intended draft would be silently discarded if the click went through.
 *
 * Returns block:true ONLY when:
 *   - surface is "search" OR "network" (profile is the sanctioned note-modal path);
 *   - the label parses to a non-null person name;
 *   - that name matches a raw_candidates row (NOCASE);
 *   - a lead exists for that candidate;
 *   - the lead has a connect_note draft in status ∈ ('draft','approved','revised').
 *
 * Exported alongside isAutoOutboundAuthorized so it can be unit-tested against a seeded temp DB.
 */
export function connectNoteRequiredForLabel(
  db: DB,
  label: string,
  surface: string,
): { block: boolean; reason?: string } {
  if (surface !== "search" && surface !== "network") return { block: false };
  const name = personNameFromInviteLabel(label);
  if (!name) return { block: false };
  // Fail-closed over-block on homonyms (plan §4): block if ANY candidate matching the normalized
  // name has a lead with an unsent connect_note draft. One JOIN scans ALL same-named rows so a
  // draft on a same-named other is never missed (the prior 3 single-row .get()s checked only one).
  const draft = db
    .prepare(
      `SELECT 1 FROM raw_candidates rc
         JOIN leads l ON l.candidate_id = rc.id
         JOIN message_drafts d ON d.lead_id = l.id
        WHERE rc.person_name = ? COLLATE NOCASE
          AND d.kind = 'connect_note'
          AND d.status IN ('draft','approved','revised')
        LIMIT 1`,
    )
    .get(name);
  if (!draft) return { block: false };
  return {
    block: true,
    reason: `a connect_note draft exists for "${name}", but the sidebar "Invite … to connect" sends with NO note. Open ${name}'s profile and use the Connect modal to attach the saved note — or delete/mark the draft if a note-less invite is intended.`,
  };
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
  // P-AUTO-8 (M1): split into a fragment-free band (for `system`, consumed only by cron's
  // runOneTurn branch — cron.ts:107 prepends soulModeFragment("auto") to the PROMPT) and a
  // with-mode band (for `systemResume`, which keeps the boot-mode fragment so an in-flight
  // workflow resumes under the mode it opened on). Operator turns + passive turns use the new
  // `composeOperatorSystem` closure to compose a fresh 3-band system per turn with the fragment
  // INSIDE the Soul band (before Checkpoint) — preserving the Boundary -> Soul -> Checkpoint
  // invariant (CLAUDE.md §1 Product Contract).
  const soulBandPlain = resolveSoulBand(cfg.soul.override, identity);
  const soulBandWithMode = `${soulBandPlain}\n\n${soulModeFragment(bootMode)}`;
  // P-ZH-1: appended to the Boundary band content, never reordering bands ("" for "auto" —
  // composition is byte-identical to before this field existed).
  const languageDirective = boundaryLanguageDirective(cfg.language);
  const boundaryBand = `${BOUNDARY}${languageDirective}`;
  const boundaryResumeBand = `${BOUNDARY_RESUME}${languageDirective}`;
  const system = composeSystemPrompt({ boundary: boundaryBand, soul: soulBandPlain, checkpoint: CHECKPOINT });
  const systemResume = composeSystemPrompt({
    boundary: boundaryResumeBand,
    soul: soulBandWithMode,
    checkpoint: CHECKPOINT_RESUME,
  });
  const composeOperatorSystem = (mode: AppMode): string =>
    composeSystemPrompt({
      boundary: boundaryBand,
      soul: `${soulBandPlain}\n\n${soulModeFragment(mode)}`,
      checkpoint: CHECKPOINT,
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
    // (frondose_set_passive_mode → POST /agent/passive-mode) OR FRONDOSE_PASSIVE_SUGGEST=on env.
    passiveEnabled: passiveEnabledAtBoot,
    autoRunId: null,
    // P-AUTO-12 (b): cron no-progress tracking — in-memory only.
    cronNoProgressRunId: null,
    cronNoProgressTurns: 0,
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
  const tools = makeAllTools(session, { memoryDbPath, identityPath, schedulePath, salesDbPath }, control, hookRunner);

  const emitter: ServeEmitter = new EventEmitter();
  const workflow = createWorkflowController({
    emitFrame: (frame) => {
      emitter.emit("sse-frame", frame);
      pushWorkflowToOverlay(state, session, workflow, frame);
    },
    writeWorkflowAudit: (event) => writeWorkflowAudit(auditPath, event),
    recoverPostDraftId: () => findPendingPostDraftId(getSalesDb(salesDbPath)),
    // [P-FIX-MARK-SENT-STALE-DRAFT] Retire a declined step's draft (draft → rejected) so its
    // stale draftId can never be marked sent later; when the step carries no captured draftId
    // (the prescribed save→todo_write order drops it), resolve by semantic correlation —
    // pending draft whose lead is named in the step title.
    markDraftDeclined: (draftId) => {
      markDraftRejected(getSalesDb(salesDbPath), draftId);
    },
    findDraftForDeclinedStep: (stepTitle) => findDraftForDeclinedStep(getSalesDb(salesDbPath), stepTitle),
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
    // P-AUTO-13: hard click cap counts ACTUALLY-SENT connects only; guard-rejected/failed
    // connect_sent ledger rows stay visible in the summary but don't consume the budget.
    return {
      runId: row.id,
      maxConnects: row.maxConnects,
      connectSentCount: countSuccessfulConnects(db, row.id),
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
  // P-AUTO-6: per-call (NOT cached) so a freshly saved draft is reflected immediately. Decoupled
  // from the workflow controller (avoids the D-14 title hole + the cold-sweep null-workflow hole).
  session.connectNoteRequiredForLabel = (label, surface) =>
    connectNoteRequiredForLabel(getSalesDb(salesDbPath), label, surface);
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
  let reaperInterval: ReturnType<typeof setInterval> | null = null;
  const expectedToken = Buffer.from(opts.bearerToken, "utf-8");
  const deps: ServeDeps = {
    model,
    system,
    systemResume,
    composeOperatorSystem,
    tools,
    maxSteps,
    auditWriter,
    session,
    schedulePath,
    salesDbPath,
    memoryDbPath,
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

  // [P-OPEN-SOURCE-SPLIT §9.4/§13.3] Inbound Telegram — App-owned adapter over the
  // shared turn owner. Configured boot creates exactly one poller; unconfigured
  // boot constructs nothing and performs zero network calls. submitTurn enters
  // the same scheduler-owned turn path as the UI (/agent/turn) — same
  // state.currentTurn owner, Pi loop, system bands, workflow, audit, abort,
  // retry and approval semantics. A busy turn throws turn_busy (the adapter
  // defers the update and does not advance offset).
  const telegramJsonPath =
    frondoseEnv("TELEGRAM_CONFIG_PATH") ?? join(getHomeBase(), DATA_DIR_NAME, "agent", "telegram.json");
  const telegramToken = frondoseEnv("TELEGRAM_TOKEN");
  const telegramCfg = readTelegramConfig(telegramJsonPath);
  let telegramChannel: ReturnType<typeof createTelegramChannel> | undefined;
  if (telegramCfg.enabled && telegramCfg.boundUserId !== null && Boolean(telegramToken)) {
    const token = telegramToken as string;
    const allowlistRoot = frondoseEnv("UPLOAD_ALLOWLIST") ?? join(getHomeBase(), DATA_DIR_NAME, "agent", "uploads");
    // Transport opts mirror the retired CLI poller: proxy + sticky fallback IP
    // (TELEGRAM_PROXY env wins over config.json.telegram.proxyUrl).
    const telegramTransportOpts = (signal?: AbortSignal) => ({
      signal,
      fallbackIp: telegramCfg.stickyFallbackIp ?? undefined,
      proxyUrl: process.env.TELEGRAM_PROXY ?? telegramCfg.proxyUrl ?? undefined,
    });
    const submitTelegramTurn = async (
      input: { source: "telegram"; text: string; media: string[] },
      _signal: AbortSignal,
    ): Promise<{ finalText: string }> => {
      if (state.currentTurn !== null) throw new Error("turn_busy");
      const turnId = randomBytes(4).toString("hex");
      const abortController = new AbortController();
      state.currentTurn = { turnId, abortController };
      // Media arrives as allowlisted local paths; surface them in the prompt so
      // the turn owner can reference the attachments (no media param on runOneTurn).
      const prompt = input.media.length > 0 ? `${input.text}\n\n[attachments: ${input.media.join(", ")}]` : input.text;
      const chunks: string[] = [];
      const onFrame = (frame: SseFrame): void => {
        if (frame.type === "text" && frame.turnId === turnId) chunks.push(frame.chunk ?? "");
      };
      emitter.on("sse-frame", onFrame);
      try {
        state.messages.push({ role: "user", content: prompt });
        state.lastTurnUserPrompt = prompt;
        await turn.runOneTurn({
          turnId,
          abortController,
          userPrompt: prompt,
          isRetryable: false,
          isCronTurn: false,
        });
        return { finalText: chunks.join("").trim() };
      } finally {
        emitter.off("sse-frame", onFrame);
        clearCurrentTurnIfOwned(state, turnId);
      }
    };
    telegramChannel = createTelegramChannel({
      configured: true,
      readOffset: () => readTelegramConfig(telegramJsonPath).lastUpdateOffset,
      commitOffset: (offset) => {
        const cfg = readTelegramConfig(telegramJsonPath);
        writeTelegramConfig({ ...cfg, lastUpdateOffset: offset }, telegramJsonPath);
      },
      pollUpdates: async (signal, offset) => {
        const url = `https://api.telegram.org/bot${token}/getUpdates`;
        const res = await telegramFetch(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ offset, timeout: telegramCfg.pollTimeoutSec, allowed_updates: ["message"] }),
            signal,
          },
          telegramTransportOpts(signal),
        );
        if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`);
        const data = (await res.json()) as {
          ok: boolean;
          result?: Array<{
            update_id: number;
            message?: {
              text?: string;
              photo?: Array<{ file_id: string; file_unique_id?: string }>;
              document?: { file_id: string; file_unique_id?: string };
            };
          }>;
        };
        if (!data.ok) throw new Error("getUpdates ok:false");
        return (data.result ?? []).map((u): TelegramUpdate => {
          const media: TelegramMedia[] = [];
          for (const p of u.message?.photo ?? []) {
            media.push({ kind: "photo", fileId: p.file_id, fileUniqueId: p.file_unique_id });
          }
          if (u.message?.document) {
            media.push({
              kind: "document",
              fileId: u.message.document.file_id,
              fileUniqueId: u.message.document.file_unique_id,
            });
          }
          return { updateId: u.update_id, text: u.message?.text, media: media.length > 0 ? media : undefined };
        });
      },
      downloadMedia: async (media: TelegramMedia, _signal) => {
        const result = await downloadTelegramFile(
          token,
          media.fileId,
          media.fileUniqueId ?? media.fileId,
          allowlistRoot,
          (u, init) => telegramFetch(u, init, telegramTransportOpts()),
        );
        return result.localPath;
      },
      submitTurn: submitTelegramTurn,
      sendReply: async (text, signal) => {
        // A terminal turn with no text (e.g. tolerant boot without an LLM key)
        // still sends exactly one reply so the operator knows it finished — the
        // offset is committed only after a successful send (T-RETIRE.Telegram.1f).
        const replyText = text.length > 0 ? text : "(turn completed — no text response)";
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        const res = await telegramFetch(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: telegramCfg.boundUserId, text: replyText }),
            signal,
          },
          telegramTransportOpts(signal),
        );
        if (!res.ok) throw new Error(`sendMessage HTTP ${res.status}`);
        // The Bot API answers HTTP 200 with {"ok":false} for API-level rejections
        // (blocked chat, message too long, empty text) — treat those as failures so
        // the offset is NOT committed and the update is retained (T-RETIRE.Telegram.1f).
        const data = (await res.json()) as { ok?: boolean };
        if (!data.ok) throw new Error("sendMessage ok:false");
      },
      writeAudit: (event: TelegramAuditEvent) => {
        const line = JSON.stringify({ type: event.type, updateId: event.updateId, ts: Date.now() });
        writeFileSync(auditPath, `${line}\n`, { flag: "a" });
      },
      waitForNextPoll: (signal) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, telegramCfg.pollBackoffSec * 1000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        }),
    });
    telegramChannel.start();
  }

  cronInterval = setInterval(() => {
    void cron.tick();
  }, 60_000);
  cronInterval.unref();

  // [P-AUTO-L3FIX-5] Independent orphan-run reaper. The per-turn-finally reaper
  // (runOne.ts) + cron's cap-close both need a turn/cron active; when cron self-
  // halts (D-RUN-1 SSE-disconnect) and no turn runs, a past-cap `running` row is
  // never closed (capstone: orphaned 17min past a 12min cap, abort=not_found).
  // This closes it based on audit IDLENESS, NOT cron/turn state. REAP_IDLE_MS
  // (360s) > the 45s raceCdp click bound + the 300s sleep max, so it can never
  // close a run mid-outbound (only the CDP connect_sent click is running-gated)
  // or during a legit long sleep. See reapOrphanIfIdle.
  const REAP_IDLE_MS = 360_000;
  const WATCHDOG_KILL_CAP = 3;
  const auditIdleMs = (): number => {
    try {
      return Date.now() - statSync(auditPath).mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };
  const maybeReapKillCappedRun = (): void => {
    reapKillCappedRun(
      getSalesDb(salesDbPath),
      state,
      false,
      deps.emitFrame,
      auditIdleMs(),
      REAP_IDLE_MS,
      readWatchdogKillTimestamps(),
      WATCHDOG_KILL_CAP,
      clearWatchdogKills,
    );
  };
  const maybeReapOrphanRun = (): void => {
    reapOrphanIfIdle(getSalesDb(salesDbPath), state, false, deps.emitFrame, auditIdleMs(), REAP_IDLE_MS);
  };
  maybeReapKillCappedRun();
  maybeReapOrphanRun(); // boot reap: close a pre-existing orphan from a prior crash/watchdog-restart
  reaperInterval = setInterval(() => {
    maybeReapKillCappedRun();
    maybeReapOrphanRun();
  }, 60_000);
  reaperInterval.unref();

  const server = createServer((req, res) => {
    void routes.handleRequest(req, res);
  });

  const shutdown = async (signal: string) => {
    process.stdout.write(`[mai serve] ${signal} - shutting down\n`);
    if (state.currentTurn) state.currentTurn.abortController.abort();
    // [P-OPEN-SOURCE-SPLIT §9.4] Sidecar shutdown aborts and awaits the in-flight
    // Telegram poll/media/turn/reply before releasing resources.
    if (telegramChannel) await telegramChannel.stop();
    if (state.unsubscribeContextId) state.unsubscribeContextId();
    if (state.unsubscribeOverlayEvents) state.unsubscribeOverlayEvents();
    if (cronInterval) {
      clearInterval(cronInterval);
      cronInterval = null;
    }
    if (reaperInterval) {
      clearInterval(reaperInterval);
      reaperInterval = null;
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
