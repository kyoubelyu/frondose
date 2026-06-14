import type { Database as DB } from "better-sqlite3";

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
  icpQualification: string | null;
}

export function getLatestScoreByCandidate(db: DB, candidateId: string): LeadScoreRow | null {
  const row = db
    .prepare(`
    SELECT id, candidate_id AS candidateId, lead_id AS leadId,
           total_score AS totalScore, icp_fit AS icpFit,
           pain_hypothesis AS painHypothesis, buying_trigger AS buyingTrigger,
           authority_level AS authorityLevel,
           suggested_opening_line AS suggestedOpeningLine, confidence,
           next_action AS nextAction, icp_qualification AS icpQualification,
           evidence_json AS evidenceJson,
           method_used AS methodUsed, model, created_at AS createdAt
    FROM lead_scores WHERE candidate_id = ? ORDER BY created_at DESC LIMIT 1
  `)
    .get(candidateId) as LeadScoreRow | undefined;
  return row ?? null;
}
