/** P-28: server credential library at ~/.mai/server/credentials.sqlite.
 *  ONE DB file, two tables (llm_keys, google_accounts). FIRST credential-bearing
 *  SQLite store in the codebase → file is chmod 600 (mirrors secrets.json).
 *
 *  CREDENTIAL PLACEHOLDER POLICY (C-5): Any inline example, doc-comment, or test
 *  fixture touching this module MUST use obvious placeholders ONLY
 *  ("sk-PLACEHOLDER", "PLACEHOLDER", "https://2fa.show/PLACEHOLDER"). NEVER a real
 *  API key, real password, or live SMS/2FA URL. */
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database as DB } from "better-sqlite3";
import Database from "better-sqlite3";
import { z } from "zod";

// ─── Row schemas (§4.3) ───────────────────────────────────────────────────────

export const llmKeyRowSchema = z.object({
  id: z.string().min(1),
  provider_type: z.enum(["anthropic", "openai"]),
  base_url: z.string().nullable(),
  api_key: z.string().min(1),
  label: z.string().nullable(),
  assigned_count: z.number().int(),
  created_at: z.number().int(),
});
export type LlmKeyRow = z.infer<typeof llmKeyRowSchema>;

export const googleAccountRowSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(1),
  recovery_email: z.string().nullable(),
  phone: z.string().nullable(),
  sms_link: z.string().nullable(),
  twofa_link: z.string().nullable(),
  label: z.string().nullable(),
  assigned_count: z.number().int(),
  created_at: z.number().int(),
});
export type GoogleAccountRow = z.infer<typeof googleAccountRowSchema>;

// ─── DB open + schema migration ───────────────────────────────────────────────

export function openCredentialsDb(path: string): DB {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
    // C-4: best-effort restrict the server dir so WAL -wal/-shm sidecars are
    // protected. Non-fatal — the dir is the operator's own.
    try {
      chmodSync(dirname(path), 0o700);
    } catch {
      // non-fatal
    }
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  runMigrations(db);
  // R-2: credentials.sqlite holds plaintext keys/passwords → chmod 600.
  if (path !== ":memory:") chmodSync(path, 0o600);
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
        CREATE TABLE IF NOT EXISTS llm_keys (
          id TEXT PRIMARY KEY,
          provider_type TEXT NOT NULL,
          base_url TEXT,
          api_key TEXT NOT NULL,
          label TEXT,
          assigned_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS google_accounts (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          password TEXT NOT NULL,
          recovery_email TEXT,
          phone TEXT,
          sms_link TEXT,
          twofa_link TEXT,
          label TEXT,
          assigned_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
      `);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(1);
    })();
  }
}

// ─── llm_keys CRUD ────────────────────────────────────────────────────────────

export function addLlmKey(
  db: DB,
  e: {
    id: string;
    provider_type: "anthropic" | "openai";
    base_url: string | null;
    api_key: string;
    label: string | null;
  },
): void {
  db.prepare(`
    INSERT INTO llm_keys (id, provider_type, base_url, api_key, label, assigned_count, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `).run(e.id, e.provider_type, e.base_url, e.api_key, e.label, Date.now());
}

export function getLlmKey(db: DB, id: string): LlmKeyRow | null {
  const row = db.prepare(`SELECT * FROM llm_keys WHERE id = ?`).get(id) as LlmKeyRow | undefined;
  return row ?? null;
}

export function listLlmKeys(db: DB): LlmKeyRow[] {
  return db.prepare(`SELECT * FROM llm_keys ORDER BY id`).all() as LlmKeyRow[];
}

export function removeLlmKey(db: DB, id: string): boolean {
  return db.prepare(`DELETE FROM llm_keys WHERE id = ?`).run(id).changes === 1;
}

export function incrementLlmKeyAssignedCount(db: DB, id: string): void {
  db.prepare(`UPDATE llm_keys SET assigned_count = assigned_count + 1 WHERE id = ?`).run(id);
}

// ─── google_accounts CRUD ────────────────────────────────────────────────────

export function addGoogleAccount(
  db: DB,
  e: {
    id: string;
    email: string;
    password: string;
    recovery_email: string | null;
    phone: string | null;
    sms_link: string | null;
    twofa_link: string | null;
    label: string | null;
  },
): void {
  db.prepare(`
    INSERT INTO google_accounts
      (id, email, password, recovery_email, phone, sms_link, twofa_link, label, assigned_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(e.id, e.email, e.password, e.recovery_email, e.phone, e.sms_link, e.twofa_link, e.label, Date.now());
}

export function getGoogleAccount(db: DB, id: string): GoogleAccountRow | null {
  const row = db.prepare(`SELECT * FROM google_accounts WHERE id = ?`).get(id) as GoogleAccountRow | undefined;
  return row ?? null;
}

export function listGoogleAccounts(db: DB): GoogleAccountRow[] {
  return db.prepare(`SELECT * FROM google_accounts ORDER BY id`).all() as GoogleAccountRow[];
}

export function removeGoogleAccount(db: DB, id: string): boolean {
  return db.prepare(`DELETE FROM google_accounts WHERE id = ?`).run(id).changes === 1;
}

export function incrementGoogleAccountAssignedCount(db: DB, id: string): void {
  db.prepare(`UPDATE google_accounts SET assigned_count = assigned_count + 1 WHERE id = ?`).run(id);
}
