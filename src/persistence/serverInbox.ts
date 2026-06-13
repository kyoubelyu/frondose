/** P-26: server-side event inbox (~/.frondose/server/inbox.sqlite).
 *  Two tables: server_inbox (worker→server events) + worker_pending
 *  (server→worker push queue, keyed by worker_id).
 *
 *  Step-3b C-4 / POST-C1: `drainServerInbox` caps row count at MAX_PER_DRAIN=20
 *  per call. Remaining rows stay `pending` and surface in subsequent drains.
 *  T-SINBOX.4 asserts 180 pending remain after a 200-row drain.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database as DB } from "better-sqlite3";
import Database from "better-sqlite3";

export function openServerInboxDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  runMigrations(db);
  return db;
}

function runMigrations(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const cur =
    (
      db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
        | { version: number }
        | undefined
    )?.version ?? 0;
  if (cur < 1) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS server_inbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          worker_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          data TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE INDEX IF NOT EXISTS idx_server_inbox_status ON server_inbox(status, ts ASC);
        CREATE TABLE IF NOT EXISTS worker_pending (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          worker_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
        );
        CREATE INDEX IF NOT EXISTS idx_worker_pending ON worker_pending(worker_id, status, ts ASC);
      `);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(1);
    })();
  }
}

export function enqueueServerInbox(db: DB, workerId: string, type: string, data: unknown): number {
  const r = db
    .prepare(`INSERT INTO server_inbox (ts, worker_id, event_type, data) VALUES (?, ?, ?, ?)`)
    .run(Date.now(), workerId, type, JSON.stringify(data));
  return Number(r.lastInsertRowid);
}

/** Step-3b C-4 / POST-C1: cap ROW COUNT per drain (not display chars). The
 *  previous design (mark ALL rows drained but display only ~2000 chars)
 *  silently dropped events beyond the truncation. New design: process at most
 *  MAX_PER_DRAIN rows per turn; remaining rows stay `pending` and are picked
 *  up by the next drain call. Events appear in order, batched, until empty. */
export function drainServerInbox(db: DB): string | null {
  const MAX_PER_DRAIN = 20;
  const rows = db
    .prepare(
      `SELECT id, ts, worker_id, event_type, data FROM server_inbox
       WHERE status='pending' ORDER BY ts ASC LIMIT ?`,
    )
    .all(MAX_PER_DRAIN) as Array<{
    id: number;
    ts: number;
    worker_id: string;
    event_type: string;
    data: string;
  }>;
  if (rows.length === 0) return null;
  const lines: string[] = ["[Worker events since last conversation]"];
  for (const r of rows) {
    const ageMin = Math.round((Date.now() - r.ts) / 60_000);
    lines.push(`• ${r.worker_id}: ${r.event_type} (${ageMin}m ago) data=${r.data}`);
  }
  // Count remaining pending rows BEYOND this batch (informational footer).
  const remainingRow = db.prepare(`SELECT COUNT(*) AS c FROM server_inbox WHERE status='pending'`).get() as {
    c: number;
  };
  const remaining = remainingRow.c - rows.length;
  if (remaining > 0) {
    lines.push(`... ${remaining} more events queued (will surface in next turn)`);
  }
  lines.push("[End worker events]");
  // Mark ONLY this batch drained — remaining rows stay pending.
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE server_inbox SET status='drained' WHERE id IN (${placeholders})`).run(...ids);
  return lines.join("\n");
}

export function enqueueWorkerPending(db: DB, workerId: string, content: string): number {
  const r = db
    .prepare(`INSERT INTO worker_pending (worker_id, ts, content) VALUES (?, ?, ?)`)
    .run(workerId, Date.now(), content);
  return Number(r.lastInsertRowid);
}

export function pendingWorkerInboxCount(db: DB, workerId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM worker_pending WHERE worker_id=? AND status='pending'`)
    .get(workerId) as { c: number };
  return row.c;
}

/** Long-poll: spin until `timeoutMs` deadline or a row appears.
 *  1s tick balances responsiveness and CPU. Returns array of message rows
 *  (atomically marked `consumed`) or [] on timeout. */
export async function drainPendingWorkerInbox(
  db: DB,
  workerId: string,
  timeoutMs: number,
): Promise<Array<{ id: number; content: string; ts: number }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = db
      .prepare(
        `SELECT id, content, ts FROM worker_pending
         WHERE worker_id=? AND status='pending' ORDER BY ts ASC LIMIT 10`,
      )
      .all(workerId) as Array<{ id: number; content: string; ts: number }>;
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(",");
      // P-28.5 D-6: DELETE consumed rows — they may carry plaintext credentials
      // (dispatch_google_login) and nothing ever reads a 'consumed' row.
      db.prepare(`DELETE FROM worker_pending WHERE id IN (${placeholders})`).run(...ids);
      return rows;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return [];
}
