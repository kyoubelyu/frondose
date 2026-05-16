/** P-27: invite token store at ~/.mai/server/invites.sqlite.
 *  Distinct lifecycle (short TTL, high churn) from workers.sqlite. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database as DB } from "better-sqlite3";
import Database from "better-sqlite3";
import { z } from "zod";

export const inviteRowSchema = z.object({
  token_sha256: z.string().length(64),
  persona_id: z.string().min(1),
  hostname_hint: z.string().nullable(),
  expires_at: z.number().int(),
  status: z.enum(["pending", "consumed", "expired"]),
  worker_id_assigned: z.string().nullable(),
  created_at: z.number().int(),
});
export type InviteRow = z.infer<typeof inviteRowSchema>;

export function openInvitesDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
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
        CREATE TABLE IF NOT EXISTS invites (
          token_sha256 TEXT PRIMARY KEY,
          persona_id TEXT NOT NULL,
          hostname_hint TEXT,
          expires_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          worker_id_assigned TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_invites_expires ON invites(expires_at, status);
      `);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(1);
    })();
  }
}

export function insertInvite(
  db: DB,
  tokenSha256: string,
  personaId: string,
  hostnameHint: string | null,
  expiresAt: number,
): void {
  db.prepare(`
    INSERT INTO invites (token_sha256, persona_id, hostname_hint, expires_at, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(tokenSha256, personaId, hostnameHint, expiresAt, Date.now());
}

/** Returns pending+unexpired row, or null. */
export function lookupPendingInvite(
  db: DB,
  tokenSha256: string,
): { persona_id: string; hostname_hint: string | null; expires_at: number } | null {
  const row = db
    .prepare(`
      SELECT persona_id, hostname_hint, expires_at
      FROM invites
      WHERE token_sha256 = ? AND status = 'pending' AND expires_at > ?
    `)
    .get(tokenSha256, Date.now()) as
    | { persona_id: string; hostname_hint: string | null; expires_at: number }
    | undefined;
  return row ?? null;
}

/** Returns any row regardless of status (for 404 vs 410 discrimination). */
export function lookupInviteAny(db: DB, tokenSha256: string): { status: string; expires_at: number } | null {
  const row = db.prepare(`SELECT status, expires_at FROM invites WHERE token_sha256 = ?`).get(tokenSha256) as
    | { status: string; expires_at: number }
    | undefined;
  return row ?? null;
}

/** Atomic consume — single-row UPDATE with status='pending' guard.
 *  Returns true iff this call transitioned the row from pending → consumed. */
export function consumeInvite(db: DB, tokenSha256: string, workerId: string): boolean {
  const r = db
    .prepare(`
      UPDATE invites SET status='consumed', worker_id_assigned=?
      WHERE token_sha256 = ? AND status = 'pending' AND expires_at > ?
    `)
    .run(workerId, tokenSha256, Date.now());
  return r.changes === 1;
}

export function markInviteExpired(db: DB, tokenSha256: string): void {
  db.prepare(`UPDATE invites SET status='expired' WHERE token_sha256 = ? AND status = 'pending'`).run(tokenSha256);
}

export function listInvitesByPersona(
  db: DB,
  personaId: string,
): Array<{ token_sha256: string; status: string; expires_at: number }> {
  return db
    .prepare(`SELECT token_sha256, status, expires_at FROM invites WHERE persona_id = ? ORDER BY created_at DESC`)
    .all(personaId) as Array<{ token_sha256: string; status: string; expires_at: number }>;
}
