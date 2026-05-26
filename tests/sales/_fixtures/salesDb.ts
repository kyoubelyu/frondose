/**
 * P-SP-A shared test fixture — in-memory sales DB helper.
 *
 * Provides mkTestSalesDb() which creates an `:memory:` better-sqlite3 instance,
 * applies the V1 migration via openSalesDatabase, and seeds the canonical test
 * rows needed across the scaffold suite. NOT counted as one of the 32 scaffolds.
 *
 * C4 fix (guardian CONCERN-4): accounts seeder is included here so that
 * T-SP-A.Context.3 can find an `accounts` row without a create-account tool.
 */

import { randomUUID } from "node:crypto";

// NOTE: openSalesDatabase is imported at runtime (after builder Step 4b ships
// src/persistence/salesDb.ts). At Step 4a scaffold time this import will fail
// to resolve — the test suite is expected to fail before reaching assertions.
// biome-ignore lint/suspicious/noExplicitAny: pre-builder stub
type DB = any;

export interface TestSalesDbHandles {
  db: DB;
  candidateId: string;
  accountId: string;
  leadId: string;
  scoreId: string;
}

/**
 * Create an in-memory sales.sqlite, apply V1 migration, seed one complete
 * test-fixture row set:
 *   - 1 accounts row (C4: required by Context.3)
 *   - 1 raw_candidates row (status='scored', accountId linked)
 *   - 1 lead_scores row (totalScore=80)
 *   - 1 leads row (stage='qualified', totalScore=80, candidateId + accountId linked)
 *
 * Returns all seeded IDs so individual tests can reuse them.
 */
export async function mkTestSalesDb(): Promise<TestSalesDbHandles> {
  // Dynamic import: resolves after builder ships src/persistence/salesDb.ts
  // biome-ignore lint/suspicious/noExplicitAny: pre-builder stub
  const { openSalesDatabase } = (await import("../../../src/persistence/salesDb.js")) as any;

  const db: DB = openSalesDatabase(":memory:");

  const now = Date.now();
  const accountId = randomUUID();
  const candidateId = randomUUID();
  const scoreId = randomUUID();
  const leadId = randomUUID();

  // 1. accounts row (C4: seeder required for get_account_context)
  db.prepare(`
    INSERT INTO accounts (id, name, linkedin_url, industry, company_size, region,
                          current_pain_hypothesis, account_score, evidence, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId,
    "Acme Corp",
    "https://www.linkedin.com/company/acme/",
    "Software",
    "51-200",
    "US",
    "Sales teams lack pipeline visibility",
    72,
    "Seen 3 pain posts on LinkedIn",
    now,
  );

  // 2. raw_candidates row — D-SP-B.Fixture.1 fix: seed with latest_score_id=NULL
  //    (lead_scores does not exist yet; FK ordering: insert NULL first, UPDATE after step 3).
  db.prepare(`
    INSERT INTO raw_candidates
      (id, person_name, profile_url, account_id, source, source_context,
       observed_at, last_seen_at, status, latest_score_id, evidence_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId,
    "Alice Example",
    "https://www.linkedin.com/in/alice-example/",
    accountId,
    "profile-nav",
    null,
    now,
    now,
    "scored",
    null, // FK fix: NULL until lead_scores row is inserted below
    "VP Sales at Acme — strong ICP fit",
  );

  // 3. lead_scores row (totalScore=80 — needed by Promote.1)
  db.prepare(`
    INSERT INTO lead_scores
      (id, candidate_id, lead_id, total_score, icp_fit, pain_hypothesis,
       buying_trigger, authority_level, suggested_opening_line, confidence,
       next_action, evidence_json, method_used, model, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    scoreId,
    candidateId,
    null, // lead not yet created at score time
    80,
    "Strong",
    "Sales teams lack pipeline visibility",
    "Recent job change",
    "VP",
    "I noticed you recently joined Acme — congrats on the new role.",
    0.85,
    "Connect and intro",
    JSON.stringify({ source: "profile-inspect" }),
    "Pain Chain",
    "deepseek",
    now,
  );

  // D-SP-B.Fixture.1 fix step 2: now that lead_scores exists, set the FK reference.
  db.prepare("UPDATE raw_candidates SET latest_score_id = ? WHERE id = ?").run(scoreId, candidateId);

  // 4. leads row (stage='qualified' — needed by Stage/Draft/FollowUp/Context tests)
  db.prepare(`
    INSERT INTO leads
      (id, candidate_id, account_id, person_name, profile_url, stage,
       total_score, confidence, one_line_pain_chain, next_action,
       next_action_due_at, owner_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    leadId,
    candidateId,
    accountId,
    "Alice Example",
    "https://www.linkedin.com/in/alice-example/",
    "qualified",
    80,
    0.85,
    "Sales teams lack pipeline visibility",
    null,
    null,
    "manual",
    now,
    now,
  );

  // Update candidate status to 'promoted' now that lead row exists
  db.prepare("UPDATE raw_candidates SET status = 'promoted' WHERE id = ?").run(candidateId);
  // Update lead_scores to link leadId
  db.prepare("UPDATE lead_scores SET lead_id = ? WHERE id = ?").run(leadId, scoreId);

  return { db, candidateId, accountId, leadId, scoreId };
}

/** Insert a raw_candidates row with status='new' (not yet scored). */
export function seedFreshCandidate(db: DB, opts?: { profileUrl?: string; status?: string }): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO raw_candidates
      (id, person_name, profile_url, account_id, source, observed_at, last_seen_at, status, evidence_summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    "Bob Fixture",
    opts?.profileUrl ?? `https://www.linkedin.com/in/bob-${id.slice(0, 8)}/`,
    null,
    "profile-nav",
    now,
    now,
    opts?.status ?? "new",
    "Test fixture candidate",
  );
  return id;
}

/** Insert an auto_runs row with status='running'. */
export function seedAutoRun(db: DB): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, now, null, 480, 20, "running", null, null);
  return id;
}

/** Insert a message_drafts row with status='draft'. */
export function seedDraft(db: DB, leadId: string): string {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, leadId, "connect_note", "Hi Alice, I noticed your recent move to Acme.", "draft", "llm", null, now);
  return id;
}
