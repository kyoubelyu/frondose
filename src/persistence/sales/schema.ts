import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database as DB } from "better-sqlite3";
import Database from "better-sqlite3";
import { DATA_DIR_NAME, getHomeBase } from "../paths.js";

export const DEFAULT_SALES_DB_PATH = (): string => join(getHomeBase(), DATA_DIR_NAME, "agent", "sales.sqlite");

/** Current sales schema version. P-SP-A ships v1 (initial 8 tables).
 *  Future P-SP-B+ extensions bump this and add applyV2/applyV3 etc.,
 *  following the same per-step transaction pattern as memory.ts. */
export const CURRENT_SCHEMA_VERSION = 1;
export const CURRENT_SALES_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

/** Per-process singleton handle cache, keyed by path. */
const cache = new Map<string, DB>();

/** Open the sales DB, run migrations, return the handle. */
export function openSalesDatabase(path: string = DEFAULT_SALES_DB_PATH()): DB {
  const cached = cache.get(path);
  if (cached) return cached;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  runSalesMigrations(db);
  cache.set(path, db);
  return db;
}

/** Close handle (test helper). Removes from cache so the next open re-creates. */
export function closeSalesDatabase(path: string): void {
  const db = cache.get(path);
  if (db) {
    db.close();
    cache.delete(path);
  }
}

/** Migration framework — mirrors src/persistence/memory.ts:48-72 exactly.
 *  Each version step wrapped in its own db.transaction() so a crash between
 *  DDL and the version INSERT rolls back cleanly. */
function runSalesMigrations(db: DB): void {
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
    // [P-75 D-20] message_drafts: lead_id nullable + kind enum gains 'post'.
    // SQLite doesn't support ALTER COLUMN to change CHECK constraints; the canonical
    // pattern is recreate-and-swap: build new table, INSERT-SELECT, drop+rename.
    // FK pragma toggled OFF for the swap so lead_scores/lead_timeline FKs to leads
    // (still valid post-swap because we don't touch leads) don't try to validate during
    // the intermediate state. Idempotent: the IF NOT EXISTS + version check make
    // re-running the migration a no-op.
    db.transaction(() => {
      applyV2(db);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(2);
    })();
  }
}

/** P-SP-A v1 schema — 8 tables + indexes. All timestamps stored as INTEGER
 *  unix-ms (Date.now()) for fast range queries; lead_timeline.ts is the only
 *  unix-ms event time. Enums enforced via CHECK constraints — schema-level
 *  enforcement so a manual SQL write cannot insert a bogus stage. */
function applyV1(db: DB): void {
  db.exec(`
    -- 1. raw_candidates: every observed person from any source.
    CREATE TABLE IF NOT EXISTS raw_candidates (
      id                TEXT    PRIMARY KEY,
      person_name       TEXT    NOT NULL,
      profile_url       TEXT    NOT NULL UNIQUE,
      account_id        TEXT    REFERENCES accounts(id),
      source            TEXT    NOT NULL CHECK (source IN ('search','profile-nav','click','feed','company','memory','auto')),
      source_context    TEXT,
      observed_at       INTEGER NOT NULL,
      last_seen_at      INTEGER NOT NULL,
      status            TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new','researched','scored','promoted','disqualified','duplicate')),
      latest_score_id   TEXT    REFERENCES lead_scores(id),
      evidence_summary  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_raw_candidates_status ON raw_candidates (status, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_raw_candidates_account ON raw_candidates (account_id);

    -- 2. accounts: company/account-level state.
    CREATE TABLE IF NOT EXISTS accounts (
      id                       TEXT    PRIMARY KEY,
      name                     TEXT    NOT NULL,
      linkedin_url             TEXT    UNIQUE,
      industry                 TEXT,
      company_size             TEXT,
      region                   TEXT,
      current_pain_hypothesis  TEXT,
      account_score            INTEGER,
      evidence                 TEXT,
      updated_at               INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_updated ON accounts (updated_at DESC);

    -- 3. leads: qualified pipeline object.
    CREATE TABLE IF NOT EXISTS leads (
      id                    TEXT    PRIMARY KEY,
      candidate_id          TEXT    NOT NULL UNIQUE REFERENCES raw_candidates(id),
      account_id            TEXT    REFERENCES accounts(id),
      person_name           TEXT    NOT NULL,
      profile_url           TEXT    NOT NULL,
      stage                 TEXT    NOT NULL CHECK (stage IN ('scored','qualified','connect_sent','connected','replied','sales_intent','meeting_booked','disqualified')),
      total_score           INTEGER,
      confidence            REAL,
      one_line_pain_chain   TEXT,
      next_action           TEXT,
      next_action_due_at    INTEGER,
      owner_mode            TEXT    NOT NULL CHECK (owner_mode IN ('manual','magical','auto')),
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads (stage, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_due ON leads (next_action_due_at) WHERE next_action_due_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_leads_account ON leads (account_id);

    -- 4. lead_scores: durable multi-dimensional score result (P-SP-B writes; P-SP-A reads).
    CREATE TABLE IF NOT EXISTS lead_scores (
      id                       TEXT    PRIMARY KEY,
      candidate_id             TEXT    NOT NULL REFERENCES raw_candidates(id),
      lead_id                  TEXT    REFERENCES leads(id),
      total_score              INTEGER NOT NULL,
      icp_fit                  TEXT,
      pain_hypothesis          TEXT,
      buying_trigger           TEXT,
      authority_level          TEXT,
      suggested_opening_line   TEXT,
      confidence               REAL,
      next_action              TEXT,
      evidence_json            TEXT,
      method_used              TEXT,
      model                    TEXT,
      created_at               INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lead_scores_candidate ON lead_scores (candidate_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lead_scores_lead ON lead_scores (lead_id, created_at DESC);

    -- 5. lead_timeline: insert-only event log; FK to candidate (always) + lead (when promoted).
    CREATE TABLE IF NOT EXISTS lead_timeline (
      id            TEXT    PRIMARY KEY,
      candidate_id  TEXT    NOT NULL REFERENCES raw_candidates(id),
      lead_id       TEXT    REFERENCES leads(id),
      event_type    TEXT    NOT NULL CHECK (event_type IN ('discovered','viewed','researched','scored','promoted_to_lead','connect_sent','connected','message_sent','replied','sales_intent_detected','meeting_booked','disqualified','follow_up_scheduled','auto_stopped')),
      ts            INTEGER NOT NULL,
      metadata      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_candidate ON lead_timeline (candidate_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_timeline_lead ON lead_timeline (lead_id, ts DESC) WHERE lead_id IS NOT NULL;

    -- 6. message_drafts: preserve draft text + future approval state.
    CREATE TABLE IF NOT EXISTS message_drafts (
      id           TEXT    PRIMARY KEY,
      lead_id      TEXT    NOT NULL REFERENCES leads(id),
      kind         TEXT    NOT NULL CHECK (kind IN ('connect_note','dm','follow_up','comment')),
      text         TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sent','rejected','revised')),
      created_by   TEXT    NOT NULL CHECK (created_by IN ('llm','user')),
      evidence     TEXT,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_lead ON message_drafts (lead_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_drafts_status ON message_drafts (status);

    -- 7. auto_runs: Auto-mode day-run state machine.
    CREATE TABLE IF NOT EXISTS auto_runs (
      id                     TEXT    PRIMARY KEY,
      started_at             INTEGER NOT NULL,
      ended_at               INTEGER,
      max_duration_minutes   INTEGER NOT NULL DEFAULT 480,
      max_connects           INTEGER,
      status                 TEXT    NOT NULL CHECK (status IN ('running','completed','stopped_by_user','stopped_by_agent','blocked')),
      summary                TEXT,
      counters               TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auto_runs_status ON auto_runs (status, started_at DESC);

    -- 8. auto_run_ledger: per-action audit for cap enforcement.
    CREATE TABLE IF NOT EXISTS auto_run_ledger (
      id            TEXT    PRIMARY KEY,
      run_id        TEXT    NOT NULL REFERENCES auto_runs(id),
      action_type   TEXT    NOT NULL CHECK (action_type IN ('connect_sent','message_sent','follow_up_sent','comment_posted')),
      lead_id       TEXT    REFERENCES leads(id),
      ts            INTEGER NOT NULL,
      count_weight  REAL    NOT NULL DEFAULT 1.0,
      result        TEXT    NOT NULL CHECK (result IN ('success','failed','skipped'))
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_run_action ON auto_run_ledger (run_id, action_type);
    CREATE INDEX IF NOT EXISTS idx_ledger_lead ON auto_run_ledger (lead_id) WHERE lead_id IS NOT NULL;
  `);
}

/** [P-75 D-20] v2 schema migration: message_drafts.lead_id becomes nullable + kind enum
 *  gains 'post'. SQLite cannot ALTER COLUMN to change CHECK constraints — the canonical
 *  pattern is build-new, INSERT-SELECT, drop, rename. FK pragma toggled OFF for the swap
 *  so the drop+rename of a referenced table doesn't fail (no other table references
 *  message_drafts, but the pattern is defensive). Existing rows preserve their lead_id.
 *  Idempotent: a re-run is a no-op because the version check in runSalesMigrations
 *  gates on schema_version < 2.
 */
function applyV2(db: DB): void {
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      CREATE TABLE message_drafts_v2 (
        id           TEXT    PRIMARY KEY,
        lead_id      TEXT    REFERENCES leads(id),
        kind         TEXT    NOT NULL CHECK (kind IN ('connect_note','dm','follow_up','comment','post')),
        text         TEXT    NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','sent','rejected','revised')),
        created_by   TEXT    NOT NULL CHECK (created_by IN ('llm','user')),
        evidence     TEXT,
        created_at   INTEGER NOT NULL
      );
      INSERT INTO message_drafts_v2 (id, lead_id, kind, text, status, created_by, evidence, created_at)
        SELECT id, lead_id, kind, text, status, created_by, evidence, created_at FROM message_drafts;
      DROP TABLE message_drafts;
      ALTER TABLE message_drafts_v2 RENAME TO message_drafts;
      CREATE INDEX IF NOT EXISTS idx_drafts_lead ON message_drafts (lead_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_drafts_status ON message_drafts (status);
    `);
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
