import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
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
});

/** P-SP-A: promote a scored candidate to a lead. Idempotent — if already
 *  promoted, returns the existing leadId. Requires status='scored'. */
export function makePromoteCandidateToLeadTool(salesDbPath: string) {
  return tool({
    description:
      "Promote a raw candidate (status='scored') to a qualified lead in the pipeline. " +
      "Copies the latest lead_scores.total_score onto leads.total_score, sets stage='qualified', " +
      "and appends a 'promoted_to_lead' event to the timeline. Idempotent — if the candidate is " +
      "already promoted, returns the existing leadId with alreadyPromoted=true.",
    parameters: promoteParams,
    execute: async (input) => {
      try {
        const { candidateId, ownerMode } = promoteParams.parse(input);
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
