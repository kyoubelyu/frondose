import { countAutoLedgerByAction, getAutoRun } from "../../../../persistence/salesDb.js";
import { getSalesDb } from "../../../../tools/sales/_dbHandle.js";
import type { ServeDeps, ServeState } from "../context.js";

/**
 * P-WLC: an operator-driven Auto turn has NO cron post-turn handler
 * (that only runs for cron ticks — cron.ts), so the agent's clean
 * end_auto_run close previously reached the DB but emitted NO terminal
 * SSE frame — leaving the FE Auto stage stuck open. The tool body can't
 * emit SSE (no emitter at the tool layer — no-bash boundary), so observe
 * the result here and emit auto-run-completed. Cron turns are excluded to
 * avoid a double-emit with cron.ts's post-turn emitter. After a clean
 * close getCurrentAutoRun returns null, so the finally-block reaper
 * self-skips — no double-emit there either.
 *
 * Extracted (WLC 2026-07-02) out of runOne.ts's onStepFinish observer to
 * keep runOne.ts under its §4.2.1 LoC budget; behavior is byte-identical
 * to the inline block it replaced.
 */
export function emitAutoRunCompletedOnEndAutoRun(
  state: ServeState,
  deps: ServeDeps,
  tr: { toolName: string; result: unknown },
  isCronTurn: boolean,
): void {
  if (tr.toolName !== "end_auto_run" || isCronTurn) return;
  const env = tr.result as { ok?: boolean; data?: { runId?: string; alreadyEnded?: boolean } } | null | undefined;
  const runId = env?.data?.runId;
  if (env?.ok !== true || env.data?.alreadyEnded === true || typeof runId !== "string") return;
  const db = getSalesDb(deps.salesDbPath);
  const endedRow = getAutoRun(db, runId);
  if (!endedRow) return;
  const finalCounters = countAutoLedgerByAction(db, runId);
  deps.emitFrame({
    type: "auto-run-completed",
    runId,
    status: endedRow.status as "completed" | "stopped_by_agent" | "stopped_by_user" | "blocked",
    summary: endedRow.summary,
    finalCounters,
    endedAt: endedRow.endedAt ?? Date.now(),
    ts: Date.now(),
  });
  state.autoRunId = null;
  state.lastEmittedAutoCounters = null;
}
