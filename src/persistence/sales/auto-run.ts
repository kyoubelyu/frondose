import { randomUUID } from "node:crypto";
import type { Database as DB } from "better-sqlite3";

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
    runId: string;
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

export function insertAutoRun(db: DB, input: { maxDurationMinutes?: number; maxConnects?: number | null }): AutoRunRow {
  const id = randomUUID();
  const startedAt = Date.now();
  const maxDurationMinutes = input.maxDurationMinutes ?? 480;
  const maxConnects = input.maxConnects ?? null;
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
