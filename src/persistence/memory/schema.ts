import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database as DB } from "better-sqlite3";
import Database from "better-sqlite3";
import { DATA_DIR_NAME, getHomeBase } from "../paths.js";

export const DEFAULT_MEMORY_DB_PATH = (): string => join(getHomeBase(), DATA_DIR_NAME, "agent", "memory.sqlite");

/** Open the memory DB, run migrations, return the handle. Synchronous (better-sqlite3 is sync). */
export function openMemoryDatabase(path: string = DEFAULT_MEMORY_DB_PATH()): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  runMemoryMigrations(db);
  return db;
}

/** Close the DB handle. Idempotent. */
export function closeMemoryDatabase(db: DB): void {
  db.close();
}

/** Current memory schema version. Exported as a stable contract for diagnostics
 *  (e.g. tests asserting the latest applied version exists in `schema_version`).
 *  P-39: bumped 2 → 3 (FTS5 + scores + general memory). */
export const CURRENT_SCHEMA_VERSION = 3;

/**
 * P-25 Step-3b B-1 fix: each migration step is wrapped in its own
 * `db.transaction()` that covers BOTH the DDL and the version-row INSERT.
 * Without this, a crash between `applyVN(db)` and the version INSERT would
 * leave the DB in "VN-with-newer-columns / version=N-1" state; the next
 * startup would re-run `applyVN`, and SQLite's non-IF-NOT-EXISTS
 * `ALTER TABLE ADD COLUMN` would throw "duplicate column", permanently
 * breaking the operator's memory.sqlite.
 *
 * better-sqlite3's `db.transaction()` provides rollback-on-throw + supports
 * DDL inside transactions on SQLite >= 3.7.11 (bundled SQLite is 3.43.x).
 */
function runMemoryMigrations(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as
    | { version: number }
    | undefined;
  const current = row?.version ?? 0;
  if (current < 1) {
    db.transaction(() => {
      applyV1(db);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(1);
    })();
  }
  if (current < 2) {
    db.transaction(() => {
      applyV2(db);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(2);
    })();
  }
  if (current < 3) {
    db.transaction(() => {
      applyV3(db);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(3);
    })();
  }
}

function applyV1(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_memory_events (
      id TEXT PRIMARY KEY,
      profile_url TEXT NOT NULL,
      person_name TEXT NOT NULL,
      interaction TEXT NOT NULL,
      summary TEXT NOT NULL,
      notes TEXT,
      avoid TEXT,
      next_action TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_person_memory_profile_url ON person_memory_events (profile_url, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_person_memory_person_name ON person_memory_events (person_name, created_at DESC);
  `);
}

/** P-25: 4 nullable attribution columns. P-26 worker→server sync populates;
 *  worker's own writes leave these NULL (attribution is meaningless on the
 *  local DB). Existing rows get NULL; existing SELECT projections ignore
 *  the extra columns (backward-compat). */
function applyV2(db: DB): void {
  db.exec(`
    ALTER TABLE person_memory_events ADD COLUMN source_worker_id TEXT;
    ALTER TABLE person_memory_events ADD COLUMN source_hostname TEXT;
    ALTER TABLE person_memory_events ADD COLUMN source_persona TEXT;
    ALTER TABLE person_memory_events ADD COLUMN ts INTEGER;
  `);
}

/** P-39: searchable + rankable memory.
 *  (a) person_scores  — per-person 0–10 lead rating, separate from the event log.
 *  (b) general_memory — non-person key/value store ("随时储存读取").
 *  (c) memory_fts     — FTS5 external-content index over person_memory_events.
 *  (d) backfill the FTS index from existing rows — runs BEFORE the triggers are
 *      created (so the AI trigger does not also fire on the backfill rows).
 *  (e) AI/AD/AU triggers keep memory_fts in sync with future row changes.
 *  The whole block runs inside the caller's db.transaction(); a crash mid-V3
 *  rolls back EVERY statement (incl. CREATE VIRTUAL TABLE) → clean retry. The
 *  CREATE statements are all CREATE … IF NOT EXISTS — no ALTER, no duplicate
 *  hazard; the backfill runs exactly once (gated by the schema_version check). */
function applyV3(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_scores (
      profile_url TEXT PRIMARY KEY,
      score INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS general_memory (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      person_name, summary, notes, interaction,
      content=person_memory_events, content_rowid=rowid
    );
  `);

  // One-time backfill — unconditional. applyV3 runs only under `current < 3`,
  // so the schema_version check already guarantees once-only — no double-insert
  // risk. A count(*) guard is UNSAFE here: for FTS5 external-content tables
  // count(*) reads the content table (person_memory_events), not the FTS index.
  db.exec(`
    INSERT INTO memory_fts(rowid, person_name, summary, notes, interaction)
      SELECT rowid, person_name, summary, notes, interaction FROM person_memory_events;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON person_memory_events BEGIN
      INSERT INTO memory_fts(rowid, person_name, summary, notes, interaction)
      VALUES (new.rowid, new.person_name, new.summary, new.notes, new.interaction);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON person_memory_events BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, person_name, summary, notes, interaction)
      VALUES ('delete', old.rowid, old.person_name, old.summary, old.notes, old.interaction);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON person_memory_events BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, person_name, summary, notes, interaction)
      VALUES ('delete', old.rowid, old.person_name, old.summary, old.notes, old.interaction);
      INSERT INTO memory_fts(rowid, person_name, summary, notes, interaction)
      VALUES (new.rowid, new.person_name, new.summary, new.notes, new.interaction);
    END;
  `);
}
