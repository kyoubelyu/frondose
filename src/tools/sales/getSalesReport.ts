import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import {
  getAutoRunHistory,
  getConnectionRates,
  getFunnelSummary,
  getLeadQualityBySource,
  getMeetingBookedCount,
  getReplyRates,
  getSalesIntentRate,
  getScoreCalibration,
} from "../../persistence/salesAnalytics.js";
import { getSalesDb } from "./_dbHandle.js";

const getSalesReportParams = z.object({
  sinceMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Optional Unix-ms cutoff. Only events at or after this timestamp are counted. " +
        "Omit for all-time. Example: Date.now() - 7*86400000 for last 7 days.",
    ),
  autoRunHistoryLimit: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .default(20)
    .describe("Max auto-runs to return in history (most recent first)."),
});

export function makeGetSalesReportTool(salesDbPath: string) {
  return tool({
    description:
      "Return the operator-facing sales analytics report: 7 metrics + auto-run history. " +
      "Read-only. Computes from the durable sales kernel; safe to call anytime. " +
      "Use this when the operator asks about sales performance, when composing a Telegram " +
      "digest, or when validating Frondose is producing real outcomes. Metrics: funnel " +
      "summary (per-stage lead counts), meeting_booked count (primary KPI), sales_intent " +
      "DISTINCT count, connection-accepted rate, reply rate, positive-reply rate, lead " +
      "quality by source (7 source cohorts), score calibration (high/mid/low bands vs " +
      "advance-rate). 'Advanced' = any stage past connect_sent.",
    parameters: getSalesReportParams,
    execute: async (input) => {
      try {
        const parsed = getSalesReportParams.parse(input);
        const db = getSalesDb(salesDbPath);
        return ok("get_sales_report", {
          funnelSummary: getFunnelSummary(db, parsed.sinceMs),
          meetingBooked: getMeetingBookedCount(db, parsed.sinceMs),
          salesIntent: getSalesIntentRate(db, parsed.sinceMs),
          connectionRate: getConnectionRates(db, parsed.sinceMs),
          replyRate: getReplyRates(db, parsed.sinceMs),
          leadQualityBySource: getLeadQualityBySource(db, parsed.sinceMs),
          scoreCalibration: getScoreCalibration(db, parsed.sinceMs),
          autoRunHistory: getAutoRunHistory(db, parsed.autoRunHistoryLimit ?? 20, parsed.sinceMs),
          generatedAt: Date.now(),
          sinceMs: parsed.sinceMs ?? null,
        });
      } catch (e) {
        return failFromError("get_sales_report", e);
      }
    },
  });
}
