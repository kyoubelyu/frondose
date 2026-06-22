import { randomUUID } from "node:crypto";
import type { Database as DB } from "better-sqlite3";
import { frondoseEnv } from "../../env.js";

export type AutoRunStatus = "running" | "completed" | "stopped_by_user" | "stopped_by_agent" | "blocked";
export type AutoActionType = "connect_sent" | "message_sent" | "follow_up_sent" | "comment_posted";
export type AutoActionResult = "success" | "failed" | "skipped";

export interface AutoRunRow {
  id: string;
  startedAt: number;
  endedAt: number | null;
  maxDurationMinutes: number;
  maxConnects: number | null;
  status: AutoRunStatus;
  summary: string | null;
  counters: string | null;
}

export function getCurrentAutoRun(db: DB): AutoRunRow | null {
  const row = db
    .prepare(`
    SELECT id, started_at AS startedAt, ended_at AS endedAt,
           max_duration_minutes AS maxDurationMinutes,
           max_connects AS maxConnects, status, summary, counters
    FROM auto_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1
  `)
    .get() as AutoRunRow | undefined;
  return row ?? null;
}

export function getAutoRun(db: DB, id: string): AutoRunRow | null {
  const row = db
    .prepare(`
    SELECT id, started_at AS startedAt, ended_at AS endedAt,
           max_duration_minutes AS maxDurationMinutes,
           max_connects AS maxConnects, status, summary, counters
    FROM auto_runs WHERE id = ?
  `)
    .get(id) as AutoRunRow | undefined;
  return row ?? null;
}

export function appendAutoLedger(
  db: DB,
  input: {
    runId: string | null;
    actionType: AutoActionType;
    leadId?: string | null;
    result: AutoActionResult;
    countWeight?: number;
  },
): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO auto_run_ledger
      (id, run_id, action_type, lead_id, ts, count_weight, result)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.runId, input.actionType, input.leadId ?? null, Date.now(), input.countWeight ?? 1.0, input.result);
  return id;
}

export function countAutoLedgerByAction(db: DB, runId: string): Record<string, number> {
  const rows = db
    .prepare(`
    SELECT action_type AS actionType, COUNT(*) AS n
    FROM auto_run_ledger WHERE run_id = ? GROUP BY action_type
  `)
    .all(runId) as Array<{ actionType: string; n: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.actionType] = r.n;
  return out;
}

/** P-AUTO-13: count connect_sent ledger rows that ACTUALLY SENT (result='success').
 *  Used by the per-run cap consumers (click.ts hard gate via serve.ts; getAutoRunState
 *  advisory; cron prompt CONNECTS_USED injection) so guard-rejected/failed connect
 *  rows — which P-AUTO-13 now requires the agent to log — do NOT consume the connect
 *  budget. The shared countAutoLedgerByAction stays all-rows (the end_auto_run
 *  summary wants every attempt; its result breakdown is separate). Mirrors
 *  countOutboundSince's result='success' filter shape. */
export function countSuccessfulConnects(db: DB, runId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM auto_run_ledger
       WHERE run_id = ? AND action_type = 'connect_sent' AND result = 'success'`,
    )
    .get(runId) as { n: number };
  return row.n;
}

// LinkedIn-safety outbound guardrails: cross-run daily quota + cooldown (bound outbound ACROSS runs/days;
// env FRONDOSE_AUTO_DAILY_OUTBOUND_CAP / FRONDOSE_AUTO_OUTBOUND_COOLDOWN_MIN, 0 disables; hard-gated in click.ts).
export const DEFAULT_AUTO_DAILY_OUTBOUND_CAP = 15;
export const DEFAULT_AUTO_OUTBOUND_COOLDOWN_MIN = 5;
const OUTBOUND_IN_CLAUSE = ["connect_sent", "message_sent", "follow_up_sent"].map((a) => `'${a}'`).join(",");

export function resolveOutboundGuardrails(): { dailyCap: number; cooldownMs: number } {
  const cap = Number.parseInt(frondoseEnv("AUTO_DAILY_OUTBOUND_CAP") ?? "", 10);
  const cool = Number.parseInt(frondoseEnv("AUTO_OUTBOUND_COOLDOWN_MIN") ?? "", 10);
  return {
    dailyCap: Number.isInteger(cap) && cap >= 0 ? cap : DEFAULT_AUTO_DAILY_OUTBOUND_CAP,
    cooldownMs: (Number.isInteger(cool) && cool >= 0 ? cool : DEFAULT_AUTO_OUTBOUND_COOLDOWN_MIN) * 60_000,
  };
}

/** Count SUCCESSFUL outbound actions across ALL runs since `sinceMs` (the cross-run daily quota). */
export function countOutboundSince(db: DB, sinceMs: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM auto_run_ledger
       WHERE result = 'success' AND ts >= ? AND action_type IN (${OUTBOUND_IN_CLAUSE})`,
    )
    .get(sinceMs) as { n: number };
  return row.n;
}

/** Timestamp (ms) of the most recent SUCCESSFUL outbound action across all runs, or null. */
export function lastOutboundAt(db: DB): number | null {
  const row = db
    .prepare(
      `SELECT MAX(ts) AS ts FROM auto_run_ledger
       WHERE result = 'success' AND action_type IN (${OUTBOUND_IN_CLAUSE})`,
    )
    .get() as { ts: number | null };
  return row.ts ?? null;
}

/** P-AUTO-1+2 B-5: default cap for OMITTED (undefined) maxConnects; explicit `null` = opt-out (not collapsed). */
export const DEFAULT_AUTO_RUN_MAX_CONNECTS = 5;

/** P-AUTO-1+2: UTC start-of-day (ms) — deterministic cross-timezone daily-outbound window anchor. */
export function utcStartOfDay(nowMs?: number): number {
  const d = nowMs === undefined ? new Date() : new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function insertAutoRun(db: DB, input: { maxDurationMinutes?: number; maxConnects?: number | null }): AutoRunRow {
  const id = randomUUID();
  const startedAt = Date.now();
  const maxDurationMinutes = input.maxDurationMinutes ?? 480;
  const maxConnects = input.maxConnects === undefined ? DEFAULT_AUTO_RUN_MAX_CONNECTS : input.maxConnects;
  db.prepare(`
    INSERT INTO auto_runs
      (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters)
    VALUES (?, ?, NULL, ?, ?, 'running', NULL, NULL)
  `).run(id, startedAt, maxDurationMinutes, maxConnects);
  return {
    id,
    startedAt,
    endedAt: null,
    maxDurationMinutes,
    maxConnects,
    status: "running",
    summary: null,
    counters: null,
  };
}

export function updateAutoRunStatus(db: DB, id: string, status: AutoRunStatus): void {
  db.prepare(`UPDATE auto_runs SET status = ? WHERE id = ?`).run(status, id);
}

export function endAutoRun(
  db: DB,
  id: string,
  input: { status: AutoRunStatus; summary?: string | null; counters?: Record<string, number> | null },
): { alreadyEnded: boolean } {
  const existing = getAutoRun(db, id);
  if (!existing) throw new Error(`endAutoRun: no auto_runs row with id ${id}`);
  if (existing.endedAt !== null) return { alreadyEnded: true };
  const endedAt = Date.now();
  const summary = input.summary ?? null;
  const countersJson = input.counters !== undefined && input.counters !== null ? JSON.stringify(input.counters) : null;
  db.prepare(`
    UPDATE auto_runs
       SET status = ?, ended_at = ?, summary = ?, counters = ?
     WHERE id = ?
  `).run(input.status, endedAt, summary, countersJson, id);
  return { alreadyEnded: false };
}
