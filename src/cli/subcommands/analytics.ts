import { existsSync } from "node:fs";
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
import { closeSalesDatabase, DEFAULT_SALES_DB_PATH, openSalesDatabase } from "../../persistence/salesDb.js";

export interface RunAnalyticsOpts {
  salesDbPath?: string;
}

function fmtRate(rate: number | null): string {
  return rate === null ? "n/a" : `${rate.toFixed(1)}%`;
}

function fmtPct(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 100)}%`;
}

export async function runAnalyticsSubcommand(opts: RunAnalyticsOpts = {}): Promise<void> {
  const salesDbPath = opts.salesDbPath ?? DEFAULT_SALES_DB_PATH();
  if (!existsSync(salesDbPath)) {
    process.stdout.write(`No sales.sqlite at ${salesDbPath}. Run any sales operation to initialize.\n`);
    return;
  }
  const db = openSalesDatabase(salesDbPath);
  try {
    const funnel = getFunnelSummary(db);
    const meeting = getMeetingBookedCount(db);
    const intentBundle = getSalesIntentRate(db);
    const conn = getConnectionRates(db);
    const reply = getReplyRates(db);
    const quality = getLeadQualityBySource(db);
    const calibration = getScoreCalibration(db);
    const history = getAutoRunHistory(db, 5);

    const funnelLine = [
      `discovered=${funnel.scored + funnel.qualified + funnel.connect_sent + funnel.connected + funnel.replied + funnel.sales_intent + funnel.meeting_booked + funnel.disqualified}`,
      `scored=${funnel.scored}`,
      `qualified=${funnel.qualified}`,
      `connect_sent=${funnel.connect_sent}`,
      `connected=${funnel.connected}`,
      `replied=${funnel.replied}`,
      `intent=${funnel.sales_intent}`,
      `meeting_booked=${funnel.meeting_booked}`,
    ].join("  ");
    process.stdout.write(`funnel:        ${funnelLine}\n`);

    const total = quality.reduce((s, q) => s + q.totalCandidates, 0);
    const sourcesLine =
      quality.length === 0
        ? "(no candidates)"
        : quality
            .map((q) => `${q.source}=${total > 0 ? Math.round((q.totalCandidates * 100) / total) : 0}%`)
            .join("  ");
    process.stdout.write(`sources:       ${sourcesLine}\n`);

    process.stdout.write(
      `rates:         connect-accepted=${fmtRate(conn.rate)}  reply=${fmtRate(reply.replyRate)}  positive-reply=${fmtRate(reply.positiveRate)}\n`,
    );

    const meetingLine = `meetings:      booked=${meeting}  sales-intent=${intentBundle.count}/${intentBundle.contacted} (${fmtRate(intentBundle.rate)})`;
    process.stdout.write(`${meetingLine}\n`);

    if (calibration.length > 0) {
      const calLine = calibration.map((c) => `${c.scoreBand}: ${fmtPct(c.advanceRate)} advance`).join("  ");
      process.stdout.write(`score-calibration:  ${calLine}\n`);
    }

    if (history.length > 0) {
      const completed = history.filter((h) => h.status !== "running").length;
      const durations = history.filter((h) => h.durationMinutes !== null).map((h) => h.durationMinutes ?? 0);
      const avgDur = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
      process.stdout.write(
        `auto-runs:     ${completed} completed  avg-duration=${avgDur}min  (${history.length} total recent)\n`,
      );
    }
  } finally {
    // P-SP-F MR-C-4 fix: release the cached handle via closeSalesDatabase so the path
    // entry is removed from openSalesDatabase's per-process cache map at salesDb.ts:16-28.
    // `db.close()` alone would close the better-sqlite3 handle but leave the stale entry in
    // the cache, breaking subsequent opens. CLI process exits immediately after this call,
    // but the explicit close is idiomatic + matches the test-helper convention at salesDb.ts:31-38.
    closeSalesDatabase(salesDbPath);
  }
}
