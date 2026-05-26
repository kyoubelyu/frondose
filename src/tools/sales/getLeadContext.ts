import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
import { getLatestScoreByCandidate, getLead, listDraftsByLead, listTimelineByLead } from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

const getLeadContextParams = z.object({
  leadId: z.string().trim().min(1),
  timelineLimit: z.number().int().min(1).max(200).default(50),
});

export function makeGetLeadContextTool(salesDbPath: string) {
  return tool({
    description:
      "Return everything the kernel knows about a lead: the lead row, the most recent " +
      "lead_score, the timeline (latest first, up to timelineLimit), and all message drafts. " +
      "Use this before drafting outreach so you can ground the message in prior context.",
    parameters: getLeadContextParams,
    execute: async (input) => {
      try {
        const { leadId, timelineLimit } = getLeadContextParams.parse(input);
        const db = getSalesDb(salesDbPath);
        const lead = getLead(db, leadId);
        if (!lead) return fail("get_lead_context", "not_found", `No lead with id ${leadId}`);
        const latestScore = getLatestScoreByCandidate(db, lead.candidateId);
        const timeline = listTimelineByLead(db, leadId, timelineLimit);
        const drafts = listDraftsByLead(db, leadId);
        return ok("get_lead_context", { lead, latestScore, timeline, drafts });
      } catch (e) {
        return failFromError("get_lead_context", e);
      }
    },
  });
}
