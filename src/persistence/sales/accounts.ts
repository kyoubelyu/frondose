import type { Database as DB } from "better-sqlite3";

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
