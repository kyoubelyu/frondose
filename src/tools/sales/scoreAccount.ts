/**
 * P-SP-B — score_account: per-account sales-value context (atomic UPSERT by
 * normalized linkedin_url).
 *
 * Race-safe via real SQLite `INSERT ... ON CONFLICT(linkedin_url) DO UPDATE SET
 * ... RETURNING id` (not a SELECT-then-branch). The returned `id` equals our
 * newly-minted UUID iff the row was just created — that's the discriminator
 * between {action:"created"} and {action:"updated"} (the conflict path returns
 * the EXISTING row's id, not the new one). Optionally links the source
 * raw_candidates.account_id (OQ-B3) in the same db.transaction(). No LLM call
 * inside the tool body.
 *
 * URL normalization (inline; mirrors src/persistence/memory.ts normalizeProfileUrl
 * shape — see P-SP-A plan §6.4 D lines 493-507 for the precedent) collapses
 * trailing-slash / query / fragment / case variants so two slight URL spellings
 * don't create duplicate accounts.
 */
import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { fail, ok } from "../../linkedin/envelope.js";
import { getSalesDb } from "./_dbHandle.js";

/** Normalize a LinkedIn company URL: lowercase host, drop query/fragment, strip
 *  trailing slashes on the pathname. Best-effort: any URL-parse failure falls
 *  back to a trim+lowercase+strip-trailing-slash. Mirrors the P-SP-A
 *  normalizeProfileUrl pattern for /in/ URLs. */
function normalizeCompanyUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    u.hash = "";
    u.search = "";
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.origin.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}

const scoreAccountParams = z.object({
  name: z.string().min(1).describe("Company name as it appears on LinkedIn."),
  linkedinUrl: z
    .string()
    .min(1)
    .describe(
      "REQUIRED. The LinkedIn company URL (e.g. https://www.linkedin.com/company/techcorp). " +
        "This is the natural key — UPSERT collapses by this column.",
    ),
  industry: z.string().nullable().optional().describe("Industry / vertical."),
  companySize: z.string().nullable().optional().describe("Employee range as a string: e.g. '500-1000', '10000+'."),
  region: z.string().nullable().optional().describe("Primary HQ region."),
  currentPainHypothesis: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Speculative one-line account-level pain: e.g. 'scaling outbound without SDR " +
        "headcount'. Prefix 'speculative:' when evidence is thin.",
    ),
  accountScore: z
    .number()
    .int()
    .min(0)
    .max(100)
    .nullable()
    .optional()
    .describe("0..100 INTEGER account-level sales-value score (same scale as score_lead.totalScore)."),
  evidence: z
    .string()
    .nullable()
    .optional()
    .describe("JSON-stringified or plain-text evidence facts that drove the score."),
  candidateId: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Optional. If supplied, raw_candidates.account_id is updated to point at this account " +
        "in the same transaction (so the source candidate is linked to its account row).",
    ),
});

export function makeScoreAccountTool(salesDbPath: string) {
  return tool({
    description:
      "UPSERT an accounts row by linkedinUrl with account-level sales context (industry / " +
      "size / region / pain hypothesis / score / evidence). If a row with the same " +
      "linkedinUrl exists, it is updated in place (no duplicate); otherwise a new row is " +
      "created. Pass candidateId to also link the source raw_candidates row to this " +
      "account. No LLM call inside the tool — you (the agent) fill the fields from your " +
      "inspect/company-page context.",
    parameters: scoreAccountParams,
    execute: async (input) => {
      try {
        const db = getSalesDb(salesDbPath);
        const urlNorm = normalizeCompanyUrl(input.linkedinUrl);
        const newId = randomUUID();
        const now = Date.now();
        let accountId = "";
        const txn = db.transaction(() => {
          // Atomic UPSERT: on conflict by linkedin_url, UPDATE the existing row in
          // place; RETURNING id returns the EXISTING row's id (not our newId) on
          // the update path — that's the created-vs-updated discriminator.
          const row = db
            .prepare(
              `INSERT INTO accounts (id, name, linkedin_url, industry, company_size, region,
               current_pain_hypothesis, account_score, evidence, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(linkedin_url) DO UPDATE SET
               name = excluded.name,
               industry = excluded.industry,
               company_size = excluded.company_size,
               region = excluded.region,
               current_pain_hypothesis = excluded.current_pain_hypothesis,
               account_score = excluded.account_score,
               evidence = excluded.evidence,
               updated_at = excluded.updated_at
             RETURNING id`,
            )
            .get(
              newId,
              input.name,
              urlNorm,
              input.industry ?? null,
              input.companySize ?? null,
              input.region ?? null,
              input.currentPainHypothesis ?? null,
              input.accountScore ?? null,
              input.evidence ?? null,
              now,
            ) as { id: string };
          accountId = row.id;
          if (input.candidateId) {
            db.prepare("UPDATE raw_candidates SET account_id=?, last_seen_at=? WHERE id=?").run(
              accountId,
              now,
              input.candidateId,
            );
          }
        });
        txn();
        const action: "created" | "updated" = accountId === newId ? "created" : "updated";
        return ok("score_account", { accountId, action });
      } catch (e) {
        return fail("score_account", "runtime_error", e instanceof Error ? e.message : String(e));
      }
    },
  });
}
