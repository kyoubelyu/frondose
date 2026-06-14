import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import {
  countAutoLedgerByAction,
  countOutboundSince,
  countSuccessfulConnects,
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
      "the ledger (DENSIFIED — connect_sent/message_sent/follow_up_sent/comment_posted are " +
      "always present as numbers), PLUS connectsRemaining (= run.maxConnects - SUCCESSFUL " +
      "connect_sent rows, clamped at 0; null when run.maxConnects is null OR no run is active), " +
      "PLUS dailyOutbound (cross-run LinkedIn-safety quota + inter-outbound cooldown). Returns " +
      "{ run: null, counters: {connect_sent:0,message_sent:0,follow_up_sent:0,comment_posted:0}, " +
      "connectsRemaining: null, dailyOutbound } when no Auto run is active. Use this before any " +
      "outbound action in Auto mode to verify caps + the daily quota + cooldown. " +
      "NOTE: counters.connect_sent counts ALL connect attempts (including guard-skipped and " +
      "failed); connectsRemaining reflects ONLY successfully-sent connects against the cap — " +
      "they can legitimately differ when an attempt was guard-rejected or failed.",
    parameters: getAutoRunStateParams,
    execute: async (_input) => {
      try {
        const db = getSalesDb(salesDbPath);
        const dailyOutbound = dailyOutboundSnapshot(db);
        const run = getCurrentAutoRun(db);
        // P-AUTO-9: densify the LOCAL counters so every key is always a number. The shared
        // countAutoLedgerByAction helper is unchanged (3 other callers). Mirrors the hard
        // click-cap gate's `counters.connect_sent ?? 0` at serve.ts:258 — same truth for the
        // agent's advisory and the runtime block.
        if (!run) {
          const counters = { connect_sent: 0, message_sent: 0, follow_up_sent: 0, comment_posted: 0 };
          return ok("get_auto_run_state", { run: null, counters, connectsRemaining: null, dailyOutbound });
        }
        const counters = {
          connect_sent: 0,
          message_sent: 0,
          follow_up_sent: 0,
          comment_posted: 0,
          ...countAutoLedgerByAction(db, run.id),
        };
        // P-AUTO-13: mirror the hard click-cap gate (serve.ts:autoRun) — only ACTUALLY-SENT
        // connects consume the budget. counters.connect_sent stays the densified all-rows
        // view so the operator's summary still sees skipped/failed attempts.
        const connectsRemaining =
          run.maxConnects === null ? null : Math.max(0, run.maxConnects - countSuccessfulConnects(db, run.id));
        return ok("get_auto_run_state", { run, counters, connectsRemaining, dailyOutbound });
      } catch (e) {
        return failFromError("get_auto_run_state", e);
      }
    },
  });
}
