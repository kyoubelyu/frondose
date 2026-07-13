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

/** [P-FIX-MARK-SENT-STALE-DRAFT] Retire a draft whose owning approval step was declined.
 *  Guarded transition: ONLY the legal edge draft → rejected fires; a sent/rejected/other
 *  row is left untouched (benign no-op, returns false). Returns true when the row changed. */
export function markDraftRejected(db: DB, id: string): boolean {
  const info = db.prepare("UPDATE message_drafts SET status = 'rejected' WHERE id = ? AND status = 'draft'").run(id);
  return info.changes === 1;
}

export type PostDraftRecovery = { id: string } | { ambiguous: true } | null;

const PENDING_POST_DRAFT_SQL =
  "SELECT id FROM message_drafts WHERE kind = 'post' AND status = 'draft' AND lead_id IS NULL ORDER BY created_at DESC LIMIT 2";

export function findPendingPostDraftId(db: DB): PostDraftRecovery {
  const rows = db.prepare(PENDING_POST_DRAFT_SQL).all() as Array<{ id: string }>;
  if (rows.length >= 2) return { ambiguous: true };
  const row = rows[0];
  return row ? { id: row.id } : null;
}

/** [P-FIX-MARK-SENT-STALE-DRAFT] Resolve the pending draft a DECLINED approval step refers to,
 *  when the step has no captured draftId (the prescribed save→todo_write order drops the binding).
 *  Semantic correlation, not order/cardinality guessing: the draft's LEAD must be named in the
 *  declined step's title (e.g. "Send connect note to Wilfred Fan" ⊃ leads.person_name). Posts are
 *  excluded by the JOIN (lead_id IS NULL — they have their own recovery). person_name shorter than
 *  4 chars is skipped (substring false-positives like "Lin" ⊂ "LinkedIn"; under-retirement is the
 *  fail-safe direction). Two or more matching pending drafts → ambiguous (caller warns, retires
 *  nothing); zero → null (benign: steps without drafts are common). */
export function findDraftForDeclinedStep(db: DB, stepTitle: string): PostDraftRecovery {
  const rows = db
    .prepare(`
    SELECT d.id FROM message_drafts d JOIN leads l ON d.lead_id = l.id
    WHERE d.status = 'draft' AND length(l.person_name) >= 4 AND instr(?, l.person_name) > 0
    ORDER BY d.created_at DESC LIMIT 2
  `)
    .all(stepTitle) as Array<{ id: string }>;
  if (rows.length >= 2) return { ambiguous: true };
  const row = rows[0];
  return row ? { id: row.id } : null;
}
