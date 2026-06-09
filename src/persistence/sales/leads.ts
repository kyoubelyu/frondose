import { randomUUID } from "node:crypto";
import type { Database as DB } from "better-sqlite3";
import { normalizeProfileUrl } from "./url-normalize.js";

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
