/** P-26: workers + lead_actions persistence under ~/.frondose/server/workers.sqlite.
 *
 * Step-3b C-6: only the CONSTANT-TIME `getWorkerByTokenHashConstantTime` is
 * exported. No non-CT helper is provided — preventing accidental auth lookup
 * via a single-row hash equality check that leaks timing.
 *
 * Per-migration `db.transaction()` wraps DDL + version row (P-25 B-1 pattern).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database as DB } from "better-sqlite3";
import Database from "better-sqlite3";
import { normalizeProfileUrl } from "./memory.js";

export function openWorkersDb(path: string): DB {
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
        CREATE TABLE IF NOT EXISTS workers (
          worker_id TEXT PRIMARY KEY,
          hostname TEXT,
          persona TEXT,
          token_hash TEXT NOT NULL,
          last_heartbeat INTEGER,
          status TEXT NOT NULL DEFAULT 'active',
          added_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lead_actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_url TEXT NOT NULL,
          action_type TEXT NOT NULL,
          worker_id TEXT NOT NULL,
          ts INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lead_actions_profile ON lead_actions(profile_url, ts DESC);
        CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);
      `);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(1);
    })();
  }
}

export function addWorker(db: DB, workerId: string, token: string, hostname?: string, persona?: string): void {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  db.prepare(
    `INSERT INTO workers (worker_id, hostname, persona, token_hash, last_heartbeat, status, added_at)
     VALUES (?, ?, ?, ?, NULL, 'active', ?)`,
  ).run(workerId, hostname ?? null, persona ?? null, tokenHash, Date.now());
}

export function rotateWorkerToken(db: DB, workerId: string, newToken: string): boolean {
  const tokenHash = createHash("sha256").update(newToken).digest("hex");
  const r = db.prepare(`UPDATE workers SET token_hash=? WHERE worker_id=?`).run(tokenHash, workerId);
  return r.changes === 1;
}

export function removeWorker(db: DB, workerId: string): boolean {
  const r = db.prepare(`DELETE FROM workers WHERE worker_id=?`).run(workerId);
  return r.changes === 1;
}

export function listWorkers(db: DB): Array<{
  worker_id: string;
  hostname: string | null;
  persona: string | null;
  status: string;
  last_heartbeat: number | null;
}> {
  return db
    .prepare(
      `SELECT worker_id, hostname, persona, status, last_heartbeat
       FROM workers ORDER BY worker_id`,
    )
    .all() as Array<{
    worker_id: string;
    hostname: string | null;
    persona: string | null;
    status: string;
    last_heartbeat: number | null;
  }>;
}

export function updateHeartbeat(
  db: DB,
  workerId: string,
  hostname: string | null,
  persona: string | null,
  ts: number,
): void {
  db.prepare(
    `UPDATE workers SET last_heartbeat=?,
       hostname=COALESCE(?, hostname),
       persona =COALESCE(?, persona)
     WHERE worker_id=?`,
  ).run(ts, hostname, persona, workerId);
}

/** Constant-time worker lookup by token hash. Iterates ALL active rows (does
 *  not break on match) and uses `crypto.timingSafeEqual` for the comparison.
 *  Caller MUST verify `status === 'active'` before granting access. */
export function getWorkerByTokenHashConstantTime(
  db: DB,
  tokenHash: string,
): { worker_id: string; status: string; token_hash: string } | null {
  const rows = db.prepare(`SELECT worker_id, status, token_hash FROM workers WHERE status='active'`).all() as Array<{
    worker_id: string;
    status: string;
    token_hash: string;
  }>;
  let matched: (typeof rows)[number] | null = null;
  const ours = Buffer.from(tokenHash, "hex");
  for (const r of rows) {
    const theirs = Buffer.from(r.token_hash, "hex");
    if (theirs.length === ours.length && timingSafeEqual(ours, theirs)) {
      matched = r;
      // do NOT break — finish loop for constant-time
    }
  }
  return matched;
}

export function queryRecentLeadAction(
  db: DB,
  personRef: string,
  since: number,
): { worker_id: string; ts: number } | null {
  const url = normalizeProfileUrl(personRef);
  const row = db
    .prepare(
      `SELECT worker_id, ts FROM lead_actions
       WHERE profile_url=? AND ts > ?
       ORDER BY ts DESC LIMIT 1`,
    )
    .get(url, since) as { worker_id: string; ts: number } | undefined;
  return row ?? null;
}

export function insertLeadAction(db: DB, personRef: string, actionType: string, workerId: string, ts: number): void {
  const url = normalizeProfileUrl(personRef);
  db.prepare(`INSERT INTO lead_actions (profile_url, action_type, worker_id, ts) VALUES (?, ?, ?, ?)`).run(
    url,
    actionType,
    workerId,
    ts,
  );
}

/** P-29 STUB: the single most-recent lead_action for a worker (dashboard "last action" column).
 *  builder implements at Step 4b — SELECT action_type, ts FROM lead_actions
 *  WHERE worker_id=? ORDER BY ts DESC LIMIT 1.  Returns null when no rows exist. */
export function getLastLeadActionByWorker(db: DB, workerId: string): { action_type: string; ts: number } | null {
  const row = db
    .prepare(
      `SELECT action_type, ts FROM lead_actions
       WHERE worker_id = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(workerId) as { action_type: string; ts: number } | undefined;
  return row ?? null;
}

// Re-export server-inbox helpers so callers can import everything via workersRegistry.
export { drainPendingWorkerInbox, enqueueWorkerPending, pendingWorkerInboxCount } from "./serverInbox.js";
