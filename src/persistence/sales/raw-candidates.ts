import { randomUUID } from "node:crypto";
import type { Database as DB } from "better-sqlite3";
import { normalizeProfileUrl } from "./url-normalize.js";

export type RawCandidateSource = "search" | "profile-nav" | "click" | "feed" | "company" | "memory" | "auto";
export type RawCandidateStatus = "new" | "researched" | "scored" | "promoted" | "disqualified" | "duplicate";

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
  // QS-7.c (P-AUTO-15b CONCERN-MR-1): blank/whitespace-only evidenceSummary
  // normalizes to null so the SQL stores NULL (not ''), consistent with the
  // COALESCE conflict handler below.
  const trimmedEvidence = input.evidenceSummary?.trim();
  const evidenceSummary = trimmedEvidence && trimmedEvidence.length > 0 ? trimmedEvidence : null;
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
    ON CONFLICT(profile_url) DO UPDATE SET
      last_seen_at     = excluded.last_seen_at,
      evidence_summary = COALESCE(NULLIF(excluded.evidence_summary, ''), evidence_summary)
  `).run(
    id,
    input.personName,
    profileUrl,
    input.accountId ?? null,
    input.source,
    input.sourceContext ?? null,
    now,
    now,
    evidenceSummary,
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
