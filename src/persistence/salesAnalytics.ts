// P-SP-F: pure-read aggregation queries over the durable sales kernel. All 7 metrics
// compute from the V1 schema (no migration needed). Empty-DB graceful: counts -> 0,
// rates -> null (NOT NaN/Infinity) per OQ-F6.

import type { Database as DB } from "better-sqlite3";

export interface FunnelSummary {
  scored: number;
  qualified: number;
  connect_sent: number;
  connected: number;
  replied: number;
  sales_intent: number;
  meeting_booked: number;
  disqualified: number;
}

export interface RateBundle {
  sent: number;
  accepted: number;
  rate: number | null;
}

export interface ReplyRateBundle {
  sent: number;
  replied: number;
  positiveReplied: number;
  replyRate: number | null;
  positiveRate: number | null;
}

export interface QualityBySourceRow {
  source: string;
  totalCandidates: number;
  totalLeads: number;
  engaged: number;
  meetingsBooked: number;
}

export interface ScoreCalibrationRow {
  scoreBand: "high (70-100)" | "mid (40-69)" | "low (0-39)";
  leads: number;
  advanced: number;
  advanceRate: number | null;
  avgScore: number | null;
}

export interface AutoRunSummaryRow {
  id: string;
  startedAt: number;
  endedAt: number | null;
  durationMinutes: number | null;
  status: string;
  summary: string | null;
  counters: Record<string, number> | null;
}

const STAGES = [
  "scored",
  "qualified",
  "connect_sent",
  "connected",
  "replied",
  "sales_intent",
  "meeting_booked",
  "disqualified",
] as const;

export function getFunnelSummary(db: DB, sinceMs?: number): FunnelSummary {
  const sinceClause = sinceMs !== undefined ? `WHERE created_at >= ${sinceMs}` : "";
  const rows = db.prepare(`SELECT stage, COUNT(*) AS n FROM leads ${sinceClause} GROUP BY stage`).all() as Array<{
    stage: string;
    n: number;
  }>;
  const out: FunnelSummary = {
    scored: 0,
    qualified: 0,
    connect_sent: 0,
    connected: 0,
    replied: 0,
    sales_intent: 0,
    meeting_booked: 0,
    disqualified: 0,
  };
  for (const row of rows) {
    if ((STAGES as readonly string[]).includes(row.stage)) {
      (out as unknown as Record<string, number>)[row.stage] = row.n;
    }
  }
  return out;
}

export function getMeetingBookedCount(db: DB, sinceMs?: number): number {
  const sinceClause = sinceMs !== undefined ? `AND ts >= ${sinceMs}` : "";
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM lead_timeline WHERE event_type = 'meeting_booked' ${sinceClause}`)
    .get() as { n: number };
  return row.n;
}

export interface SalesIntentBundle {
  count: number;
  contacted: number;
  rate: number | null;
}

/** P-SP-F BLOCKER-2 fix: returns count + contacted + rate. Rate is null when
 *  no leads have been contacted (empty-DB graceful per OQ-F6). `contacted` =
 *  distinct leads that received at least one outbound (connect_sent OR message_sent). */
export function getSalesIntentRate(db: DB, sinceMs?: number): SalesIntentBundle {
  const sinceClause = sinceMs !== undefined ? `AND ts >= ${sinceMs}` : "";
  const intentRow = db
    .prepare(
      `SELECT COUNT(DISTINCT lead_id) AS n FROM lead_timeline WHERE event_type = 'sales_intent_detected' ${sinceClause}`,
    )
    .get() as { n: number };
  const contactedRow = db
    .prepare(
      `SELECT COUNT(DISTINCT lead_id) AS n FROM lead_timeline WHERE event_type IN ('connect_sent','message_sent') ${sinceClause}`,
    )
    .get() as { n: number };
  const rate = contactedRow.n > 0 ? Math.round((intentRow.n * 1000) / contactedRow.n) / 10 : null;
  return { count: intentRow.n, contacted: contactedRow.n, rate };
}

export function getConnectionRates(db: DB, sinceMs?: number): RateBundle {
  const sinceClause = sinceMs !== undefined ? `AND ts >= ${sinceMs}` : "";
  const sentRow = db
    .prepare(`SELECT COUNT(*) AS n FROM lead_timeline WHERE event_type = 'connect_sent' ${sinceClause}`)
    .get() as { n: number };
  const acceptedRow = db
    .prepare(`SELECT COUNT(*) AS n FROM lead_timeline WHERE event_type = 'connected' ${sinceClause}`)
    .get() as { n: number };
  const rate = sentRow.n > 0 ? Math.round((acceptedRow.n * 1000) / sentRow.n) / 10 : null;
  return { sent: sentRow.n, accepted: acceptedRow.n, rate };
}

export function getReplyRates(db: DB, sinceMs?: number): ReplyRateBundle {
  const sinceClause = sinceMs !== undefined ? `AND ts >= ${sinceMs}` : "";
  const sentRow = db
    .prepare(`SELECT COUNT(*) AS n FROM lead_timeline WHERE event_type = 'message_sent' ${sinceClause}`)
    .get() as { n: number };
  const repliedRow = db
    .prepare(`SELECT COUNT(*) AS n FROM lead_timeline WHERE event_type = 'replied' ${sinceClause}`)
    .get() as { n: number };
  const positiveRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM leads WHERE stage IN ('sales_intent','meeting_booked')` +
        (sinceMs !== undefined ? ` AND updated_at >= ${sinceMs}` : ""),
    )
    .get() as { n: number };
  const replyRate = sentRow.n > 0 ? Math.round((repliedRow.n * 1000) / sentRow.n) / 10 : null;
  const positiveRate = repliedRow.n > 0 ? Math.round((positiveRow.n * 1000) / repliedRow.n) / 10 : null;
  return {
    sent: sentRow.n,
    replied: repliedRow.n,
    positiveReplied: positiveRow.n,
    replyRate,
    positiveRate,
  };
}

export function getLeadQualityBySource(db: DB, sinceMs?: number): QualityBySourceRow[] {
  const sinceClause = sinceMs !== undefined ? `WHERE rc.observed_at >= ${sinceMs}` : "";
  const rows = db
    .prepare(`
      SELECT
        rc.source AS source,
        COUNT(rc.id) AS totalCandidates,
        COUNT(l.id) AS totalLeads,
        COUNT(CASE WHEN l.stage IN ('connected','replied','sales_intent','meeting_booked') THEN 1 END) AS engaged,
        COUNT(CASE WHEN l.stage = 'meeting_booked' THEN 1 END) AS meetingsBooked
      FROM raw_candidates rc
      LEFT JOIN leads l ON l.candidate_id = rc.id
      ${sinceClause}
      GROUP BY rc.source
      ORDER BY meetingsBooked DESC, totalLeads DESC
    `)
    .all() as QualityBySourceRow[];
  return rows;
}

export function getScoreCalibration(db: DB, sinceMs?: number): ScoreCalibrationRow[] {
  const sinceClause = sinceMs !== undefined ? `AND ls.created_at >= ${sinceMs}` : "";
  const rows = db
    .prepare(`
      SELECT
        CASE
          WHEN ls.total_score >= 70 THEN 'high (70-100)'
          WHEN ls.total_score >= 40 THEN 'mid (40-69)'
          ELSE 'low (0-39)'
        END AS scoreBand,
        COUNT(*) AS leads,
        COUNT(CASE WHEN l.stage IN ('connected','replied','sales_intent','meeting_booked') THEN 1 END) AS advanced,
        AVG(ls.total_score) AS avgScore
      FROM lead_scores ls
      JOIN leads l ON l.id = ls.lead_id
      WHERE ls.lead_id IS NOT NULL ${sinceClause}
      GROUP BY scoreBand
      ORDER BY avgScore DESC
    `)
    .all() as Array<{ scoreBand: string; leads: number; advanced: number; avgScore: number | null }>;
  return rows.map((r) => ({
    scoreBand: r.scoreBand as ScoreCalibrationRow["scoreBand"],
    leads: r.leads,
    advanced: r.advanced,
    advanceRate: r.leads > 0 ? Math.round((r.advanced * 1000) / r.leads) / 1000 : null,
    avgScore: r.avgScore,
  }));
}

export function getAutoRunHistory(db: DB, limit: number = 20, sinceMs?: number): AutoRunSummaryRow[] {
  // P-SP-F MR-C-2 fix: sinceMs filters by auto_runs.started_at >= sinceMs (consistent
  // with the other 7 metrics' sinceMs convention). Omit for all-time.
  const sinceClause = sinceMs !== undefined ? `WHERE started_at >= ${sinceMs}` : "";
  const rows = db
    .prepare(`
      SELECT id, started_at AS startedAt, ended_at AS endedAt,
             status, summary, counters
      FROM auto_runs
      ${sinceClause}
      ORDER BY started_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
    id: string;
    startedAt: number;
    endedAt: number | null;
    status: string;
    summary: string | null;
    counters: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationMinutes: r.endedAt !== null ? Math.round((r.endedAt - r.startedAt) / 60000) : null,
    status: r.status,
    summary: r.summary,
    counters: r.counters !== null ? (JSON.parse(r.counters) as Record<string, number>) : null,
  }));
}
