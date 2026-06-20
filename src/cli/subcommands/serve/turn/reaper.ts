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

/**
 * P-AUTO-L3FIX-5: independent orphan-run closer. Closes a past-cap `running`
 * auto_run when the agent has been IDLE (no tool step written to the audit log)
 * longer than `reapIdleMs` — regardless of cron-mode (D-RUN-1 SSE-halt) or an
 * active turn. Fixes the capstone orphan: a turn ended cleanly (heartbeat
 * absent, abort=not_found) but the run stayed `running` past its cap because the
 * per-turn-finally reaper + cron cap-close both need a turn/cron active.
 *
 * `auditIdleMs` is INJECTED (the caller stats audit.jsonl mtime) so this stays
 * pure + unit-testable. The idle gate is the safety invariant: `reapIdleMs`
 * (360s) > the 45s `raceCdp` deadline that bounds the CDP `connect_sent` click
 * (`click.ts:372`, the ONLY ledger write gated on a running run) AND > the
 * `sleep` tool's 300s max — so the reaper can never close a run with an in-flight
 * running-only ledger write or a legit long sleep. `record_auto_action` appends
 * by run existence (not running-status), so it survives a close. Delegates the
 * actual past-cap close + exactly-once emit to `reapExpiredAutoRun`.
 */
export function reapOrphanIfIdle(
  db: DB,
  state: { autoRunId: string | null; lastEmittedAutoCounters?: Record<string, number> | null },
  isCronTurn: boolean,
  emitFrame: (frame: SseFrame) => void,
  auditIdleMs: number,
  reapIdleMs: number,
): void {
  if (auditIdleMs < reapIdleMs) return;
  reapExpiredAutoRun(db, state, isCronTurn, emitFrame);
}

/**
 * P-AUTO-L3FIX-7: close a run that the Rust watchdog has force-restarted >= `cap`
 * times (kill->respawn churn). `killTimestamps` is injected so the marker-file
 * read stays outside this pure helper, matching `auditIdleMs` in the orphan reaper.
 */
export function reapKillCappedRun(
  db: DB,
  state: { autoRunId: string | null; lastEmittedAutoCounters?: Record<string, number> | null },
  isCronTurn: boolean,
  emitFrame: (frame: SseFrame) => void,
  auditIdleMs: number,
  reapIdleMs: number,
  killTimestamps: number[],
  cap: number,
  clearKills: () => void,
): void {
  try {
    if (auditIdleMs < reapIdleMs) return;
    const run = getCurrentAutoRun(db);
    if (!run) {
      if (killTimestamps.length > 0) clearKills();
      return;
    }
    const kills = killTimestamps.filter((ts) => ts >= run.startedAt).length;
    if (kills === 0) {
      if (killTimestamps.length > 0) clearKills();
      return;
    }
    if (kills < cap) return;
    const counters = countAutoLedgerByAction(db, run.id);
    const summary = `Watchdog restart cap reached (${kills}x; auto-closed)`;
    const res = endAutoRun(db, run.id, { status: "stopped_by_agent", summary, counters });
    const cronWillEmit = isCronTurn === true && state.autoRunId === run.id;
    if (res.alreadyEnded === false && !cronWillEmit) {
      emitFrame({
        type: "auto-run-completed",
        runId: run.id,
        status: "stopped_by_agent",
        summary,
        finalCounters: counters,
        endedAt: Date.now(),
        ts: Date.now(),
      });
      state.autoRunId = null;
      state.lastEmittedAutoCounters = null;
    }
    clearKills();
  } catch {
    /* reaper must never crash */
  }
}
