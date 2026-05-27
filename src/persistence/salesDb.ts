import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database as DB } from "better-sqlite3";
import Database from "better-sqlite3";
import { getHomeBase } from "./paths.js";

export const DEFAULT_SALES_DB_PATH = (): string => join(getHomeBase(), ".mai", "agent", "sales.sqlite");

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

// ----------------------------------------------------------------------------
// Repository functions (used by tool wrappers in src/tools/sales/*).
// Pure SQL — no Zod, no envelopes; the tool layer handles validation + envelope.
// All inserts use randomUUID() for ids; timestamps are Date.now() unix-ms.
// ----------------------------------------------------------------------------

export type RawCandidateSource = "search" | "profile-nav" | "click" | "feed" | "company" | "memory" | "auto";
export type RawCandidateStatus = "new" | "researched" | "scored" | "promoted" | "disqualified" | "duplicate";
export type LeadStage =
  | "scored"
  | "qualified"
  | "connect_sent"
  | "connected"
  | "replied"
  | "sales_intent"
  | "meeting_booked"
  | "disqualified";
export type LeadOwnerMode = "manual" | "magical" | "auto";
export type LeadEventType =
  | "discovered"
  | "viewed"
  | "researched"
  | "scored"
  | "promoted_to_lead"
  | "connect_sent"
  | "connected"
  | "message_sent"
  | "replied"
  | "sales_intent_detected"
  | "meeting_booked"
  | "disqualified"
  | "follow_up_scheduled"
  | "auto_stopped";
export type DraftKind = "connect_note" | "dm" | "follow_up" | "comment";
export type DraftStatus = "draft" | "approved" | "sent" | "rejected" | "revised";
export type DraftCreatedBy = "llm" | "user";
export type AutoRunStatus = "running" | "completed" | "stopped_by_user" | "stopped_by_agent" | "blocked";
export type AutoActionType = "connect_sent" | "message_sent" | "follow_up_sent" | "comment_posted";
export type AutoActionResult = "success" | "failed" | "skipped";

/** Trailing-slash normalization per mai-linkedin/src/memory/memoryRepository.ts. */
export function normalizeProfileUrl(url: string): string {
  return `${url.replace(/\/+$/, "")}/`;
}

export interface RawCandidateRow {
  id: string;
  personName: string;
  profileUrl: string;
  accountId: string | null;
  source: RawCandidateSource;
  sourceContext: string | null;
  observedAt: number;
  lastSeenAt: number;
  status: RawCandidateStatus;
  latestScoreId: string | null;
  evidenceSummary: string | null;
}

/** Upsert by normalized profileUrl. If row exists, bumps last_seen_at only.
 *  Returns the candidate id (new or existing) + whether a new row was inserted. */
export function upsertRawCandidate(
  db: DB,
  input: {
    personName: string;
    profileUrl: string;
    accountId?: string;
    source: RawCandidateSource;
    sourceContext?: string;
    evidenceSummary?: string;
  },
): { candidateId: string; inserted: boolean } {
  const profileUrl = normalizeProfileUrl(input.profileUrl);
  const existing = db.prepare("SELECT id FROM raw_candidates WHERE profile_url = ?").get(profileUrl) as
    | { id: string }
    | undefined;
  const now = Date.now();
  const id = existing?.id ?? randomUUID();
  db.prepare(`
    INSERT INTO raw_candidates
      (id, person_name, profile_url, account_id, source, source_context,
       observed_at, last_seen_at, status, evidence_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)
    ON CONFLICT(profile_url) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).run(
    id,
    input.personName,
    profileUrl,
    input.accountId ?? null,
    input.source,
    input.sourceContext ?? null,
    now,
    now,
    input.evidenceSummary ?? null,
  );
  const row = db.prepare("SELECT id FROM raw_candidates WHERE profile_url = ?").get(profileUrl) as { id: string };
  return { candidateId: row.id, inserted: existing === undefined };
}

export function getRawCandidate(db: DB, id: string): RawCandidateRow | null {
  const row = db
    .prepare(`
    SELECT id, person_name AS personName, profile_url AS profileUrl,
           account_id AS accountId, source, source_context AS sourceContext,
           observed_at AS observedAt, last_seen_at AS lastSeenAt, status,
           latest_score_id AS latestScoreId, evidence_summary AS evidenceSummary
    FROM raw_candidates WHERE id = ?
  `)
    .get(id) as RawCandidateRow | undefined;
  return row ?? null;
}

export function setCandidateStatus(db: DB, id: string, status: RawCandidateStatus): void {
  db.prepare("UPDATE raw_candidates SET status = ? WHERE id = ?").run(status, id);
}

export interface LeadRow {
  id: string;
  candidateId: string;
  accountId: string | null;
  personName: string;
  profileUrl: string;
  stage: LeadStage;
  totalScore: number | null;
  confidence: number | null;
  oneLinePainChain: string | null;
  nextAction: string | null;
  nextActionDueAt: number | null;
  ownerMode: LeadOwnerMode;
  createdAt: number;
  updatedAt: number;
}

export function insertLead(
  db: DB,
  input: {
    candidateId: string;
    accountId?: string | null;
    personName: string;
    profileUrl: string;
    stage: LeadStage;
    totalScore?: number | null;
    confidence?: number | null;
    oneLinePainChain?: string | null;
    nextAction?: string | null;
    ownerMode: LeadOwnerMode;
  },
): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO leads
      (id, candidate_id, account_id, person_name, profile_url, stage,
       total_score, confidence, one_line_pain_chain, next_action,
       owner_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.candidateId,
    input.accountId ?? null,
    input.personName,
    normalizeProfileUrl(input.profileUrl),
    input.stage,
    input.totalScore ?? null,
    input.confidence ?? null,
    input.oneLinePainChain ?? null,
    input.nextAction ?? null,
    input.ownerMode,
    now,
    now,
  );
  return id;
}

export function getLeadByCandidate(db: DB, candidateId: string): LeadRow | null {
  const row = db
    .prepare(`
    SELECT id, candidate_id AS candidateId, account_id AS accountId,
           person_name AS personName, profile_url AS profileUrl, stage,
           total_score AS totalScore, confidence,
           one_line_pain_chain AS oneLinePainChain,
           next_action AS nextAction, next_action_due_at AS nextActionDueAt,
           owner_mode AS ownerMode, created_at AS createdAt, updated_at AS updatedAt
    FROM leads WHERE candidate_id = ?
  `)
    .get(candidateId) as LeadRow | undefined;
  return row ?? null;
}

export function getLead(db: DB, id: string): LeadRow | null {
  const row = db
    .prepare(`
    SELECT id, candidate_id AS candidateId, account_id AS accountId,
           person_name AS personName, profile_url AS profileUrl, stage,
           total_score AS totalScore, confidence,
           one_line_pain_chain AS oneLinePainChain,
           next_action AS nextAction, next_action_due_at AS nextActionDueAt,
           owner_mode AS ownerMode, created_at AS createdAt, updated_at AS updatedAt
    FROM leads WHERE id = ?
  `)
    .get(id) as LeadRow | undefined;
  return row ?? null;
}

export function updateLeadStage(db: DB, id: string, stage: LeadStage): void {
  db.prepare("UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?").run(stage, Date.now(), id);
}

export function setLeadFollowUp(db: DB, id: string, nextAction: string, dueAt: number): void {
  db.prepare(`
    UPDATE leads SET next_action = ?, next_action_due_at = ?, updated_at = ? WHERE id = ?
  `).run(nextAction, dueAt, Date.now(), id);
}

export function listDueFollowUps(db: DB, now: number, limit: number): LeadRow[] {
  return db
    .prepare(`
    SELECT id, candidate_id AS candidateId, account_id AS accountId,
           person_name AS personName, profile_url AS profileUrl, stage,
           total_score AS totalScore, confidence,
           one_line_pain_chain AS oneLinePainChain,
           next_action AS nextAction, next_action_due_at AS nextActionDueAt,
           owner_mode AS ownerMode, created_at AS createdAt, updated_at AS updatedAt
    FROM leads
    WHERE next_action_due_at IS NOT NULL AND next_action_due_at <= ?
    ORDER BY next_action_due_at ASC
    LIMIT ?
  `)
    .all(now, limit) as LeadRow[];
}

export function appendTimelineEvent(
  db: DB,
  input: { candidateId: string; leadId?: string | null; eventType: LeadEventType; metadata?: unknown },
): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO lead_timeline (id, candidate_id, lead_id, event_type, ts, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.candidateId,
    input.leadId ?? null,
    input.eventType,
    Date.now(),
    input.metadata === undefined ? null : JSON.stringify(input.metadata),
  );
  return id;
}

export interface TimelineRow {
  id: string;
  candidateId: string;
  leadId: string | null;
  eventType: LeadEventType;
  ts: number;
  metadata: string | null;
}

export function listTimelineByLead(db: DB, leadId: string, limit: number): TimelineRow[] {
  return db
    .prepare(`
    SELECT id, candidate_id AS candidateId, lead_id AS leadId,
           event_type AS eventType, ts, metadata
    FROM lead_timeline WHERE lead_id = ? ORDER BY ts DESC LIMIT ?
  `)
    .all(leadId, limit) as TimelineRow[];
}

export function listTimelineByAccount(db: DB, accountId: string, limit: number): TimelineRow[] {
  return db
    .prepare(`
    SELECT t.id, t.candidate_id AS candidateId, t.lead_id AS leadId,
           t.event_type AS eventType, t.ts, t.metadata
    FROM lead_timeline t
    JOIN leads l ON l.id = t.lead_id
    WHERE l.account_id = ?
    ORDER BY t.ts DESC LIMIT ?
  `)
    .all(accountId, limit) as TimelineRow[];
}

export interface DraftRow {
  id: string;
  leadId: string;
  kind: DraftKind;
  text: string;
  status: DraftStatus;
  createdBy: DraftCreatedBy;
  evidence: string | null;
  createdAt: number;
}

export function insertDraft(
  db: DB,
  input: { leadId: string; kind: DraftKind; text: string; createdBy: DraftCreatedBy; evidence?: string },
): string {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at)
    VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)
  `).run(id, input.leadId, input.kind, input.text, input.createdBy, input.evidence ?? null, Date.now());
  return id;
}

export function getDraft(db: DB, id: string): DraftRow | null {
  const row = db
    .prepare(`
    SELECT id, lead_id AS leadId, kind, text, status,
           created_by AS createdBy, evidence, created_at AS createdAt
    FROM message_drafts WHERE id = ?
  `)
    .get(id) as DraftRow | undefined;
  return row ?? null;
}

export function listDraftsByLead(db: DB, leadId: string): DraftRow[] {
  return db
    .prepare(`
    SELECT id, lead_id AS leadId, kind, text, status,
           created_by AS createdBy, evidence, created_at AS createdAt
    FROM message_drafts WHERE lead_id = ? ORDER BY created_at DESC
  `)
    .all(leadId) as DraftRow[];
}

export function markDraftSent(db: DB, id: string): void {
  db.prepare("UPDATE message_drafts SET status = 'sent' WHERE id = ?").run(id);
}

export interface AccountRow {
  id: string;
  name: string;
  linkedinUrl: string | null;
  industry: string | null;
  companySize: string | null;
  region: string | null;
  currentPainHypothesis: string | null;
  accountScore: number | null;
  evidence: string | null;
  updatedAt: number;
}

export function getAccount(db: DB, id: string): AccountRow | null {
  const row = db
    .prepare(`
    SELECT id, name, linkedin_url AS linkedinUrl, industry,
           company_size AS companySize, region,
           current_pain_hypothesis AS currentPainHypothesis,
           account_score AS accountScore, evidence, updated_at AS updatedAt
    FROM accounts WHERE id = ?
  `)
    .get(id) as AccountRow | undefined;
  return row ?? null;
}

export function countLeadsByAccount(db: DB, accountId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE account_id = ?").get(accountId) as { n: number };
  return row.n;
}

export interface LeadScoreRow {
  id: string;
  candidateId: string;
  leadId: string | null;
  totalScore: number;
  icpFit: string | null;
  painHypothesis: string | null;
  buyingTrigger: string | null;
  authorityLevel: string | null;
  suggestedOpeningLine: string | null;
  confidence: number | null;
  nextAction: string | null;
  evidenceJson: string | null;
  methodUsed: string | null;
  model: string | null;
  createdAt: number;
}

export function getLatestScoreByCandidate(db: DB, candidateId: string): LeadScoreRow | null {
  const row = db
    .prepare(`
    SELECT id, candidate_id AS candidateId, lead_id AS leadId,
           total_score AS totalScore, icp_fit AS icpFit,
           pain_hypothesis AS painHypothesis, buying_trigger AS buyingTrigger,
           authority_level AS authorityLevel,
           suggested_opening_line AS suggestedOpeningLine, confidence,
           next_action AS nextAction, evidence_json AS evidenceJson,
           method_used AS methodUsed, model, created_at AS createdAt
    FROM lead_scores WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1
  `)
    .get(candidateId) as LeadScoreRow | undefined;
  return row ?? null;
}

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
