import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
import { appendTimelineEvent, getLead, setLeadFollowUp } from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

const scheduleFollowUpParams = z.object({
  leadId: z.string().trim().min(1),
  nextAction: z.string().trim().min(1).max(400),
  dueAt: z
    .number()
    .int()
    .nonnegative()
    .describe("Unix-ms timestamp when the follow-up is due. Use Date.now() + N*86400000 for N days."),
});

export function makeScheduleFollowUpTool(salesDbPath: string) {
  return tool({
    description:
      "Schedule a follow-up for a lead. Writes leads.next_action + leads.next_action_due_at " +
      "and appends 'follow_up_scheduled' to the timeline. Use this when you decide to revisit " +
      "a lead at a later time (e.g. after a connect, before sending a DM).",
    parameters: scheduleFollowUpParams,
    execute: async (input) => {
      try {
        const { leadId, nextAction, dueAt } = scheduleFollowUpParams.parse(input);
        const db = getSalesDb(salesDbPath);
        const lead = getLead(db, leadId);
        if (!lead) return fail("schedule_follow_up", "not_found", `No lead with id ${leadId}`);
        setLeadFollowUp(db, leadId, nextAction, dueAt);
        appendTimelineEvent(db, {
          candidateId: lead.candidateId,
          leadId,
          eventType: "follow_up_scheduled",
          metadata: { nextAction, dueAt },
        });
        return ok("schedule_follow_up", { leadId, nextAction, dueAt });
      } catch (e) {
        return failFromError("schedule_follow_up", e);
      }
    },
  });
}
