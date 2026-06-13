import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import {
  countAutoLedgerByAction,
  countOutboundSince,
  getCurrentAutoRun,
  lastOutboundAt,
  resolveOutboundGuardrails,
} from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

/** LinkedIn-safety: cross-run daily-outbound quota + inter-outbound cooldown snapshot. */
function dailyOutboundSnapshot(db: ReturnType<typeof getSalesDb>) {
  const { dailyCap, cooldownMs } = resolveOutboundGuardrails();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const usedToday = countOutboundSince(db, startOfToday.getTime());
  const lastAt = lastOutboundAt(db);
  const cooldownRemainingMs = lastAt ? Math.max(0, cooldownMs - (Date.now() - lastAt)) : 0;
  return {
    usedToday,
    cap: dailyCap,
    remaining: Math.max(0, dailyCap - usedToday),
    lastOutboundAt: lastAt,
    cooldownMs,
    cooldownActive: cooldownRemainingMs > 0,
    cooldownRemainingMs,
  };
}

const getAutoRunStateParams = z
  .object({})
  .describe("No parameters — returns the currently-running Auto run (or null).");

export function makeGetAutoRunStateTool(salesDbPath: string) {
  return tool({
    description:
      "Return the current Auto-mode run (status='running') with its action counters from " +
      "the ledger, PLUS dailyOutbound (cross-run LinkedIn-safety quota + inter-outbound cooldown). " +
      "Returns { run: null, counters: {}, dailyOutbound } when no Auto run is active. Use this " +
      "before any outbound action in Auto mode to verify caps + the daily quota + cooldown.",
    parameters: getAutoRunStateParams,
    execute: async (_input) => {
      try {
        const db = getSalesDb(salesDbPath);
        const dailyOutbound = dailyOutboundSnapshot(db);
        const run = getCurrentAutoRun(db);
        if (!run) return ok("get_auto_run_state", { run: null, counters: {}, dailyOutbound });
        const counters = countAutoLedgerByAction(db, run.id);
        return ok("get_auto_run_state", { run, counters, dailyOutbound });
      } catch (e) {
        return failFromError("get_auto_run_state", e);
      }
    },
  });
}
