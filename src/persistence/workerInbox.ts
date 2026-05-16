/** P-26: worker-side inbox (~/.mai/agent/inbox.sqlite).
 *
 *  PERSISTENCE LAYER — DB CRUD ONLY (Step-3b B-1 split). No `runAgentLoop`
 *  import, no message injection. The orchestrator (`drainWorkerInbox`) lives
 *  in `src/cli/workerInbox.ts` (mirrors `drainDueJobs` in replCron.ts).
 *
 *  POST-N5: canonical export is `enqueueWorkerInbox` (NOT
 *  `enqueueWorkerInboxMessage`). Validator-locked name; do not alias.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Database as DB } from "better-sqlite3";
import Database from "better-sqlite3";

export const WORKER_INBOX_DB_PATH = (): string => join(homedir(), ".mai", "agent", "inbox.sqlite");

export function openWorkerInboxDb(path: string): DB {
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
        CREATE TABLE IF NOT EXISTS worker_inbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          source TEXT NOT NULL DEFAULT 'server'
        );
        CREATE INDEX IF NOT EXISTS idx_worker_inbox_status ON worker_inbox(status, ts ASC);
      `);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(1);
    })();
  }
}

/** POST-N5: canonical name `enqueueWorkerInbox`. Returns the inserted row id. */
export function enqueueWorkerInbox(db: DB, content: string, ts: number = Date.now()): number {
  const r = db.prepare(`INSERT INTO worker_inbox (ts, content) VALUES (?, ?)`).run(ts, content);
  return Number(r.lastInsertRowid);
}

export function peekPendingWorkerInboxMessages(db: DB): Array<{ id: number; content: string; ts: number }> {
  return db.prepare(`SELECT id, content, ts FROM worker_inbox WHERE status='pending' ORDER BY ts ASC`).all() as Array<{
    id: number;
    content: string;
    ts: number;
  }>;
}

/** P-28.5 D-6: DELETE drained rows — inbox content may carry plaintext
 *  credentials (server-dispatched Google login) and nothing reads a consumed row.
 *  Replaces P-26's markWorkerInboxMessagesConsumed (UPDATE status='consumed'). */
export function deleteWorkerInboxMessages(db: DB, ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`DELETE FROM worker_inbox WHERE id IN (${placeholders})`).run(...ids);
}
