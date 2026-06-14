import { randomBytes } from "node:crypto";
import { soulModeFragment } from "../../../agent/systemPrompt/soul.js";
import { callInOverlay } from "../../../overlay/inject.js";
import {
  countAutoLedgerByAction,
  DEFAULT_AUTO_RUN_MAX_CONNECTS,
  endAutoRun,
  getAutoRun,
  getCurrentAutoRun,
  insertAutoRun,
} from "../../../persistence/salesDb.js";
import { computeCronRunId, findDueJobs, markRan, readSchedule, writeSchedule } from "../../../persistence/schedule.js";
import { getSalesDb } from "../../../tools/sales/_dbHandle.js";
import type { ServeDeps, ServeState } from "./context.js";
import type { createTurnRunner } from "./turn.js";

export function createCronDriver(
  state: ServeState,
  deps: ServeDeps,
  turn: ReturnType<typeof createTurnRunner>,
): {
  tick(): Promise<void>;
} {
  async function tick(): Promise<void> {
    if (!state.cronEnabled) return;
    if (state.currentTurn !== null) return;
    let records: ReturnType<typeof readSchedule>;
    try {
      records = readSchedule(deps.schedulePath);
    } catch {
      return;
    }
    const due = findDueJobs(records, new Date());
    if (due.length === 0) return;
    due.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const next = due[0];
    if (!next) return;
    const fireDate = new Date(next.nextRunAt);
    const cronRunId = computeCronRunId(next, fireDate);
    const localHH = fireDate.getHours().toString().padStart(2, "0");
    const localMM = fireDate.getMinutes().toString().padStart(2, "0");
    const escapeTask = (task: string): string =>
      task.replace(/\\/g, "\\\\").replace(/\r/g, "").replace(/\n/g, " ").replace(/"/g, '\\"');
    const trimmed = next.task.trim();
    const taskLine = trimmed.length > 0 ? `\n(scheduled task: "${escapeTask(trimmed)}")` : "";

    // P-SP-E: Auto run lifecycle integration.
    // 1. Parse optional [AUTO_DURATION=N] / [AUTO_CONNECTS=N] directives from task text (OQ-E8).
    // 2. Check existing running row; if duration exceeded, force-close (OQ-E4 safety net).
    // 3. Start a new row (or resume existing) via insertAutoRun (idempotent — checks existing first).
    // 4. Inject [AUTO_RUN_ID=...] [ELAPSED=N/Mmin] [CONNECTS_USED=N/M] into cronPrompt.
    const durMatch = trimmed.match(/\[AUTO_DURATION=(\d+)\]/);
    const connMatch = trimmed.match(/\[AUTO_CONNECTS=(\d+)\]/);
    const requestedDuration = durMatch ? Number.parseInt(durMatch[1] ?? "", 10) : undefined;
    // P-AUTO-1+2 B-5: no [AUTO_CONNECTS=N] directive in the task text → fall back to
    // DEFAULT_AUTO_RUN_MAX_CONNECTS (5), NOT null. Operator authors an explicit cap by adding
    // the directive; the constant keeps cron-fired runs LinkedIn-safe by default.
    const requestedConnects = connMatch ? Number.parseInt(connMatch[1] ?? "", 10) : DEFAULT_AUTO_RUN_MAX_CONNECTS;
    const salesDb = getSalesDb(deps.salesDbPath);
    let activeRun = getCurrentAutoRun(salesDb);
    if (activeRun) {
      const elapsedMin = Math.floor((Date.now() - activeRun.startedAt) / 60000);
      if (elapsedMin > activeRun.maxDurationMinutes) {
        endAutoRun(salesDb, activeRun.id, {
          status: "stopped_by_agent",
          summary: "Duration cap reached by server safety net",
          counters: countAutoLedgerByAction(salesDb, activeRun.id),
        });
        deps.emitFrame({
          type: "auto-run-completed",
          runId: activeRun.id,
          status: "stopped_by_agent",
          summary: "Duration cap reached by server safety net",
          finalCounters: countAutoLedgerByAction(salesDb, activeRun.id),
          endedAt: Date.now(),
          ts: Date.now(),
        });
        state.autoRunId = null;
        state.lastEmittedAutoCounters = null;
        activeRun = null;
      }
    }
    if (!activeRun) {
      activeRun = insertAutoRun(salesDb, {
        maxDurationMinutes: requestedDuration ?? 480,
        maxConnects: requestedConnects,
      });
      state.autoRunId = activeRun.id;
      state.lastEmittedAutoCounters = null;
      deps.emitFrame({
        type: "auto-run-started",
        runId: activeRun.id,
        maxDurationMinutes: activeRun.maxDurationMinutes,
        maxConnects: activeRun.maxConnects,
        startedAt: activeRun.startedAt,
        ts: Date.now(),
      });
    } else {
      state.autoRunId = activeRun.id;
    }
    const elapsedNow = Math.floor((Date.now() - activeRun.startedAt) / 60000);
    const counters = countAutoLedgerByAction(salesDb, activeRun.id);
    const connectsUsed = counters.connect_sent ?? 0;
    const capStr = activeRun.maxConnects === null ? "none" : String(activeRun.maxConnects);
    const autoRunLine = `\n[AUTO_RUN_ID=${activeRun.id}]\n[ELAPSED=${elapsedNow}/${activeRun.maxDurationMinutes}min]\n[CONNECTS_USED=${connectsUsed}/${capStr}]`;

    const cronPrompt = `${soulModeFragment("auto")}\n\n[TIME ${localHH}:${localMM}]\n[CRON_RUN_ID=${cronRunId}]${autoRunLine}${taskLine}`;
    const turnId = randomBytes(4).toString("hex");
    const abortController = new AbortController();
    state.currentTurn = { turnId, abortController };
    deps.emitFrame({ type: "turn-started", turnId, source: "cron" });
    const taskHint = trimmed.length > 0 ? trimmed.slice(0, 60) : undefined;
    deps.emitFrame({
      type: "cron-tick",
      cronRunId,
      taskHint,
      ts: Date.now(),
    });
    const ctxId = state.overlayContextId;
    const client = deps.session.getClient();
    if (ctxId !== undefined && client) {
      void callInOverlay(
        client.handle,
        ctxId,
        `function() { if (window.__maiShowCronBanner) window.__maiShowCronBanner(${JSON.stringify(taskHint ?? "")}); }`,
      );
    }
    state.messages.push({ role: "user", content: cronPrompt });
    // P-57c: cron-fired turns are not retryable in M-1; lastTurnUserPrompt is not set here.
    try {
      await turn.runOneTurn({
        turnId,
        abortController,
        userPrompt: cronPrompt,
        isRetryable: false,
        isCronTurn: true,
      });
      // P-SP-E: emit progress frame after each turn (OQ-E6 option c).
      const postRun = getCurrentAutoRun(salesDb);
      if (postRun) {
        const currentCounters = countAutoLedgerByAction(salesDb, postRun.id);
        const postElapsed = Math.floor((Date.now() - postRun.startedAt) / 60000);
        if (JSON.stringify(currentCounters) !== JSON.stringify(state.lastEmittedAutoCounters)) {
          deps.emitFrame({
            type: "auto-run-progress",
            runId: postRun.id,
            elapsedMinutes: postElapsed,
            counters: currentCounters,
            ts: Date.now(),
          });
          state.lastEmittedAutoCounters = currentCounters;
        }
      } else if (state.autoRunId !== null) {
        // P-SP-E *(REVISED per CONCERN-MR-2, 3b round-1 — concrete auto-run-completed emission)*:
        // Agent called end_auto_run during the turn — the tool body cannot emit SSE (no emitter
        // access), so the cron post-turn handler detects the closure: getCurrentAutoRun returned
        // null but state.autoRunId is still set; fetch the now-ended row by id and emit the
        // auto-run-completed frame with full payload BEFORE clearing state.autoRunId.
        const endedRow = getAutoRun(salesDb, state.autoRunId);
        if (endedRow) {
          const finalCounters = countAutoLedgerByAction(salesDb, endedRow.id);
          deps.emitFrame({
            type: "auto-run-completed",
            runId: endedRow.id,
            status: endedRow.status as "completed" | "stopped_by_agent" | "stopped_by_user" | "blocked",
            summary: endedRow.summary,
            finalCounters,
            endedAt: endedRow.endedAt ?? Date.now(),
            ts: Date.now(),
          });
        }
        state.autoRunId = null;
        state.lastEmittedAutoCounters = null;
      }
      const all = readSchedule(deps.schedulePath);
      const idx = all.findIndex((record) => record.id === next.id);
      if (idx >= 0) {
        const target = all[idx];
        if (target !== undefined) {
          const updated = markRan(target, fireDate);
          if (updated === null) all.splice(idx, 1);
          else all[idx] = updated;
          writeSchedule(deps.schedulePath, all);
        }
      }
    } catch (e) {
      deps.emitFrame({
        type: "error",
        turnId,
        message: e instanceof Error ? e.message : String(e),
        retryable: false,
      });
    } finally {
      state.currentTurn = null;
      deps.emitFrame({ type: "cron-done", cronRunId, ts: Date.now() });
      const doneCtxId = state.overlayContextId;
      const doneClient = deps.session.getClient();
      if (doneCtxId !== undefined && doneClient) {
        void callInOverlay(
          doneClient.handle,
          doneCtxId,
          "function() { if (window.__maiHideCronBanner) window.__maiHideCronBanner(); }",
        );
      }
    }
  }

  return { tick };
}
