import { randomUUID } from "node:crypto";
import type { Database as DB } from "better-sqlite3";

// [P-75 D-20] 'post' added — operator-as-content-creator broadcasts that aren't bound to
// a specific lead. message_drafts.lead_id is nullable in schema v2 (see applyV2 + insertDraft).
export type DraftKind = "connect_note" | "dm" | "follow_up" | "comment" | "post";
export type DraftStatus = "draft" | "approved" | "sent" | "rejected" | "revised";
export type DraftCreatedBy = "llm" | "user";

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
  input: {
    leadId: string | null;
    kind: DraftKind;
    text: string;
    createdBy: DraftCreatedBy;
    evidence?: string;
  },
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
