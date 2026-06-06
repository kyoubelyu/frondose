import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
import { tokenizeRoleQuery } from "../../methodology/icpMatcher.js";
import { readIdentity } from "../../persistence/identity.js";
import {
  appendTimelineEvent,
  getLatestScoreByCandidate,
  getLeadByCandidate,
  getRawCandidate,
  insertLead,
  setCandidateStatus,
} from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

const promoteParams = z.object({
  candidateId: z.string().trim().min(1).describe("raw_candidates.id to promote."),
  ownerMode: z
    .enum(["manual", "magical", "auto"])
    .default("manual")
    .describe("Which mode is promoting this candidate. Defaults to 'manual'."),
  bypassPersonaCheck: z
    .boolean()
    .optional()
    .describe(
      "[P-75 D-29] Default false. Set true ONLY when the operator has explicitly authorized a " +
        "promotion despite the headline not matching any ICP targetRole. Auto mode should NEVER " +
        "set this; Manual mode may set it after the operator confirms the persona is on-strategy.",
    ),
});

/**
 * [P-75 D-29] Persona-vs-ICP validation gate. Pre-D-29, promote accepted any
 * scored candidate, leading to misqualified leads (e.g. Ahmed ElBanna, marketing
 * manager at Scib Paints, promoted as a "hardware engineer" lead because the
 * LinkedIn search seeded by engineer terms returned his profile via a tangential
 * keyword; the score_lead heuristic accepted it; the agent drafted a connect_note
 * saying "Noticed your engineering background" — factually wrong). This gate
 * tokenizes the candidate's evidence_summary (typically the LinkedIn headline
 * captured by inspect) and requires at least one ICP targetRole tokens-subset
 * match. Single-token ICP roles (e.g. "Manager") would match too broadly and
 * are deliberately excluded from the SUFFICIENT-match set — they need at least
 * one OTHER multi-token role match to pass.
 *
 * Backward-compat: if identity/ICP can't be read OR evidence_summary is empty,
 * the check is skipped (no regression on existing leads without rich evidence).
 */
function checkPersonaMatch(
  evidenceSummary: string | null,
  targetRoles: readonly string[] | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!evidenceSummary || !targetRoles || targetRoles.length === 0) return { ok: true };
  const evidenceTokens = new Set(tokenizeRoleQuery(evidenceSummary));
  if (evidenceTokens.size === 0) return { ok: true };
  for (const role of targetRoles) {
    const roleTokens = tokenizeRoleQuery(role);
    if (roleTokens.length < 2) continue; // single-token roles are too broad to be sufficient on their own
    if (roleTokens.every((t) => evidenceTokens.has(t))) return { ok: true };
  }
  return {
    ok: false,
    reason:
      `Evidence "${evidenceSummary.slice(0, 200)}" does NOT match any multi-token ICP targetRole ` +
      `(${targetRoles.join(", ")}). The captured persona looks misaligned to the operator's ICP. ` +
      `Recommended actions: (a) disqualify this candidate, (b) re-inspect the profile to refresh the ` +
      `evidence_summary if it's stale, or (c) call promote_candidate_to_lead with bypassPersonaCheck=true ` +
      `ONLY if the operator has explicitly confirmed the persona is on-strategy.`,
  };
}

/** P-SP-A: promote a scored candidate to a lead. Idempotent — if already
 *  promoted, returns the existing leadId. Requires status='scored'. */
export function makePromoteCandidateToLeadTool(salesDbPath: string) {
  return tool({
    description:
      "Promote a raw candidate (status='scored') to a qualified lead in the pipeline. " +
      "Copies the latest lead_scores.total_score onto leads.total_score, sets stage='qualified', " +
      "and appends a 'promoted_to_lead' event to the timeline. Idempotent — if the candidate is " +
      "already promoted, returns the existing leadId with alreadyPromoted=true. " +
      "[P-75 D-29] Persona validation: refuses promotion when the candidate's evidence_summary " +
      "(LinkedIn headline) does not token-match any multi-token ICP targetRole. To bypass after " +
      "explicit operator confirmation, pass bypassPersonaCheck=true.",
    parameters: promoteParams,
    execute: async (input) => {
      try {
        const { candidateId, ownerMode, bypassPersonaCheck } = promoteParams.parse(input);
        const db = getSalesDb(salesDbPath);
        const candidate = getRawCandidate(db, candidateId);
        if (!candidate) return fail("promote_candidate_to_lead", "not_found", `No candidate with id ${candidateId}`);
        const existing = getLeadByCandidate(db, candidateId);
        if (existing) {
          return ok("promote_candidate_to_lead", { leadId: existing.id, candidateId, alreadyPromoted: true });
        }
        if (candidate.status !== "scored") {
          return fail(
            "promote_candidate_to_lead",
            "invalid_input",
            `Candidate status is '${candidate.status}', must be 'scored' before promotion`,
          );
        }
        // [P-75 D-29] Persona-vs-ICP validation gate.
        if (!bypassPersonaCheck) {
          const identity = readIdentity();
          const targetRoles = identity?.icp?.targetRole;
          const personaCheck = checkPersonaMatch(candidate.evidenceSummary, targetRoles);
          if (!personaCheck.ok) {
            return fail("promote_candidate_to_lead", "invalid_input", personaCheck.reason);
          }
        }
        const score = getLatestScoreByCandidate(db, candidateId);
        const leadId = insertLead(db, {
          candidateId,
          accountId: candidate.accountId,
          personName: candidate.personName,
          profileUrl: candidate.profileUrl,
          stage: "qualified",
          totalScore: score?.totalScore ?? null,
          confidence: score?.confidence ?? null,
          oneLinePainChain: score?.painHypothesis ?? null,
          nextAction: score?.nextAction ?? null,
          ownerMode,
        });
        setCandidateStatus(db, candidateId, "promoted");
        appendTimelineEvent(db, { candidateId, leadId, eventType: "promoted_to_lead", metadata: { ownerMode } });
        return ok("promote_candidate_to_lead", { leadId, candidateId, alreadyPromoted: false });
      } catch (e) {
        return failFromError("promote_candidate_to_lead", e);
      }
    },
  });
}
