import { randomUUID } from "node:crypto";
import type { Database as DB } from "better-sqlite3";

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
