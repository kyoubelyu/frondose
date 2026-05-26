/**
 * P-SP-B — score_lead: per-person multi-dimensional sales-value scoring.
 *
 * Option B (structured fill): the agent reasons inline and supplies all 9
 * score fields; NO LLM call inside this tool body. Writes to
 * sales.sqlite/lead_scores + sales.sqlite/lead_timeline (scored event) +
 * sales.sqlite/raw_candidates (status='scored', latest_score_id) in ONE
 * atomic db.transaction(). FK pre-checked against raw_candidates so the
 * caller gets a clean error envelope instead of a raw SQLite FK violation.
 */
import { randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { fail, ok } from "../../linkedin/envelope.js";
import { appendTimelineEvent } from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

const scoreLeadParams = z.object({
  candidateId: z
    .string()
    .min(1)
    .describe(
      "REQUIRED. The id returned by record_raw_candidate for this person. " +
        "score_lead will return an invalid_input error if the candidate does not exist.",
    ),
  leadId: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Optional. The id returned by promote_candidate_to_lead, if the candidate has been " +
        "promoted to a lead. Null/omitted otherwise.",
    ),
  totalScore: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe(
      "REQUIRED. Multi-dimensional sales-value score 0..100 INTEGER. Convention: 0-39 cold, " +
        "40-59 warm, 60-79 hot, 80-100 priority. Reflects icpFit + buyingTrigger + authority " +
        "+ evidence quality together, not just ICP match.",
    ),
  icpFit: z
    .string()
    .nullable()
    .optional()
    .describe(
      "ICP dimension match narrative: e.g. 'role=VP Sales match, region=EMEA match, " +
        "industry=SaaS partial'. Null if not yet assessed.",
    ),
  painHypothesis: z
    .string()
    .nullable()
    .optional()
    .describe(
      "One-line Pain Chain speculation: e.g. 'Likely scaling outbound without headcount " +
        "pressure'. Prefix with 'speculative:' when evidence is thin. Null when no plausible " +
        "hypothesis can be drawn from inspect/profile.",
    ),
  buyingTrigger: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Observed buying signal (recent job change, post about pain, company growth news). " +
        "Null if no signal observed — that is acceptable; the next_action='research_more' " +
        "path covers it.",
    ),
  authorityLevel: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Decision-making authority inference from title/seniority: 'economic buyer (VP)', " +
        "'influencer (Director)', 'gatekeeper', 'champion (manager)'. Null if undetermined.",
    ),
  suggestedOpeningLine: z
    .string()
    .nullable()
    .optional()
    .describe(
      "First outreach sentence in the operator's voice, methodology-adapted (Solution Selling " +
        "Pain Chain framing / SPIN problem question / Challenger insight / MEDDIC metric).",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "REAL 0..1: ≤0.4 low (thin evidence; reflect in next_action), 0.4-0.7 medium, " +
        "≥0.7 high (rich inspect evidence + clear signals).",
    ),
  nextAction: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Next recommended action: 'connect_now' / 'research_more' / 'wait_for_signal' / " +
        "'disqualify' / 'follow_company'. Null only if confidence is high enough to defer the " +
        "decision to the operator.",
    ),
  evidenceJson: z
    .string()
    .nullable()
    .optional()
    .describe(
      "JSON-stringified evidence facts cited in the score — e.g. " +
        '\'{"role":"VP Sales","recentPost":"hiring SDRs","connections":"500+"}\'. ' +
        "Null if evidence was non-structural (text reasoning only).",
    ),
  methodUsed: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Methodology applied to this scoring decision: 'solution_selling' (default when Pain " +
        "Chain evidence is strong), 'spin' (open discovery), 'challenger' (buyer is " +
        "complacent), 'meddic' (enterprise multi-stakeholder), 'pain_chain' / 'key_players' / " +
        "'value_cycle' (Solution Selling sub-method), or 'operator' (custom heuristic). " +
        "Open-text field — record the method name that drove your reasoning.",
    ),
});

export function makeScoreLeadTool(salesDbPath: string) {
  return tool({
    description:
      "Persist a multi-dimensional sales-value score for a candidate. Requires candidateId " +
      "from record_raw_candidate; writes lead_scores row + lead_timeline.scored event + " +
      "raw_candidates.status='scored' in one atomic transaction. The 9 score fields are " +
      "filled by you (the agent) from your inspect/profile context — no second LLM call " +
      "inside this tool. Use confidence to flag thin-evidence scores; use next_action to " +
      "drive what happens next.",
    parameters: scoreLeadParams,
    execute: async (input) => {
      try {
        const db = getSalesDb(salesDbPath);
        // FK pre-check — clean envelope instead of a raw SQLite FK violation.
        const cand = db.prepare("SELECT id FROM raw_candidates WHERE id = ?").get(input.candidateId) as
          | { id: string }
          | undefined;
        if (cand === undefined) {
          return fail(
            "score_lead",
            "invalid_input",
            `candidateId '${input.candidateId}' not found in raw_candidates — call record_raw_candidate first`,
          );
        }
        const scoreId = randomUUID();
        const now = Date.now();
        // ONE atomic transaction: lead_scores INSERT + lead_timeline.scored
        // (via appendTimelineEvent helper) + raw_candidates UPDATE.
        const txn = db.transaction(() => {
          db.prepare(
            `INSERT INTO lead_scores (id, candidate_id, lead_id, total_score, icp_fit,
               pain_hypothesis, buying_trigger, authority_level, suggested_opening_line,
               confidence, next_action, evidence_json, method_used, model, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            scoreId,
            input.candidateId,
            input.leadId ?? null,
            input.totalScore,
            input.icpFit ?? null,
            input.painHypothesis ?? null,
            input.buyingTrigger ?? null,
            input.authorityLevel ?? null,
            input.suggestedOpeningLine ?? null,
            input.confidence,
            input.nextAction ?? null,
            input.evidenceJson ?? null,
            input.methodUsed ?? null,
            "agent", // Option B: agent is the model; no separate LLM call
            now,
          );
          // Use P-SP-A's appendTimelineEvent helper — auto-handles id + ts + the
          // correct column shape (lead_timeline.metadata, NOT metadata_json).
          appendTimelineEvent(db, {
            candidateId: input.candidateId,
            leadId: input.leadId ?? null,
            eventType: "scored",
            metadata: { scoreId, totalScore: input.totalScore, confidence: input.confidence },
          });
          db.prepare(`UPDATE raw_candidates SET status='scored', latest_score_id=?, last_seen_at=? WHERE id=?`).run(
            scoreId,
            now,
            input.candidateId,
          );
        });
        txn();
        return ok("score_lead", { scoreId, candidateId: input.candidateId, totalScore: input.totalScore });
      } catch (e) {
        return fail("score_lead", "runtime_error", e instanceof Error ? e.message : String(e));
      }
    },
  });
}
