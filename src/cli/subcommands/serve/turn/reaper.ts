import type { Database as DB } from "better-sqlite3";
import { countAutoLedgerByAction, endAutoRun, getCurrentAutoRun } from "../../../../persistence/salesDb.js";
import type { SseFrame } from "../context.js";

/**
 * P-AUTO-7: close an orphaned 'running' auto_runs row whose duration cap is exceeded, and emit the
 * completion frame EXACTLY ONCE in coordination with cron's post-turn handler (cron.ts:139-173).
 * Called from runOneTurn's finally on EVERY turn — self-skips when there is no running row or the
 * cap is not actually exceeded (so a silent-hang/operator-abort within budget is NOT reaped). The
 * cap recompute matches the D-16 watcher (runOne.ts:96-97). See plan §3.2 for the 12-cell matrix.
 */
export function reapExpiredAutoRun(
  db: DB,
  state: { autoRunId: string | null; lastEmittedAutoCounters?: Record<string, number> | null },
  isCronTurn: boolean,
  emitFrame: (frame: SseFrame) => void,
): void {
  try {
    const run = getCurrentAutoRun(db);
    if (!run || Date.now() - run.startedAt < run.maxDurationMinutes * 60_000) return;
    const counters = countAutoLedgerByAction(db, run.id);
    const res = endAutoRun(db, run.id, {
      status: "stopped_by_agent",
      summary: "Duration cap reached (auto-closed)",
      counters,
    });
    // EXACTLY-ONCE: stay silent ONLY on a cron turn whose tracked run is the one we reaped (cron's
    // post-handler will emit run.id + clear). Otherwise emit ourselves, then CLEAR state.autoRunId so
    // cron's post-handler (keys on state.autoRunId!==null) cannot also emit (closes the non-cron/
    // matched deferred-dup AND the impossible cron/mismatched wrong-run dup). res.alreadyEnded is
    // always false here (getCurrentAutoRun is running-only + synchronous endAutoRun) — defensive.
    const cronWillEmit = isCronTurn === true && state.autoRunId === run.id;
    if (res.alreadyEnded === false && !cronWillEmit) {
      emitFrame({
        type: "auto-run-completed",
        runId: run.id,
        status: "stopped_by_agent",
        summary: "Duration cap reached (auto-closed)",
        finalCounters: counters,
        endedAt: Date.now(),
        ts: Date.now(),
      });
      state.autoRunId = null;
      state.lastEmittedAutoCounters = null;
    }
  } catch {
    /* reaper must never crash turn teardown */
  }
}
