import type { Database as DB } from "better-sqlite3";

/**
 * P-AUTO-12 part (b) — durable-funnel-progress high-water mark.
 * Returns the MAX timestamp across the three tables that capture front-funnel
 * progress with NO run_id column (lead_timeline.ts, message_drafts.created_at,
 * raw_candidates.last_seen_at). The caller pairs the pre/post-runOneTurn
 * snapshot with countAutoLedgerByAction (outbound) to form the four-way
 * progress predicate from plan §3.2.1.
 *
 * COALESCE-to-zero on empty tables — a brand-new install returns
 * {timelineMax:0, draftsMax:0, candidatesMax:0}; a first INSERT produces a
 * Date.now()-magnitude timestamp >> 0, so the predicate fires correctly.
 *
 * Three separate prepared statements (better-sqlite3 caches them). Synchronous
 * + sub-millisecond on indexed scans (idx_timeline_candidate,
 * idx_drafts_lead, idx_raw_candidates_status).
 */
export function cronProgressHighWaterMark(db: DB): {
  timelineMax: number;
  draftsMax: number;
  candidatesMax: number;
} {
  const t = db.prepare("SELECT COALESCE(MAX(ts), 0) AS m FROM lead_timeline").get() as { m: number };
  const d = db.prepare("SELECT COALESCE(MAX(created_at), 0) AS m FROM message_drafts").get() as { m: number };
  const c = db.prepare("SELECT COALESCE(MAX(last_seen_at), 0) AS m FROM raw_candidates").get() as { m: number };
  return { timelineMax: t.m, draftsMax: d.m, candidatesMax: c.m };
}
