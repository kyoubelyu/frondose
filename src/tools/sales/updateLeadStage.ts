import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
import {
  appendTimelineEvent,
  getLead,
  type LeadEventType,
  updateLeadStage as updateLeadStageDb,
} from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

const updateLeadStageParams = z.object({
  leadId: z.string().trim().min(1),
  stage: z.enum([
    "scored",
    "qualified",
    "connect_sent",
    "connected",
    "replied",
    "sales_intent",
    "meeting_booked",
    "disqualified",
  ]),
});

type UpdateLeadStageValue = z.infer<typeof updateLeadStageParams>["stage"];

/** Map each lead stage to the timeline event that records the transition.
 *  'scored' and 'qualified' use 'researched'/'promoted_to_lead' events upstream;
 *  the transitions here are the post-promotion outreach stages. */
const STAGE_TO_EVENT: Record<UpdateLeadStageValue, LeadEventType> = {
  scored: "scored",
  qualified: "promoted_to_lead",
  connect_sent: "connect_sent",
  connected: "connected",
  replied: "replied",
  sales_intent: "sales_intent_detected",
  meeting_booked: "meeting_booked",
  disqualified: "disqualified",
};

export function makeUpdateLeadStageTool(salesDbPath: string) {
  return tool({
    description:
      "Update a lead's pipeline stage. Writes the new stage on leads, bumps updated_at, " +
      "and appends a matching event to lead_timeline. Use this when you confirm a stage " +
      "transition (e.g. connect accepted → 'connected', reply received → 'replied').",
    parameters: updateLeadStageParams,
    execute: async (input) => {
      try {
        const { leadId, stage } = updateLeadStageParams.parse(input);
        const db = getSalesDb(salesDbPath);
        const lead = getLead(db, leadId);
        if (!lead) return fail("update_lead_stage", "not_found", `No lead with id ${leadId}`);
        updateLeadStageDb(db, leadId, stage);
        appendTimelineEvent(db, {
          candidateId: lead.candidateId,
          leadId,
          eventType: STAGE_TO_EVENT[stage],
          metadata: { previousStage: lead.stage },
        });
        return ok("update_lead_stage", { leadId, stage });
      } catch (e) {
        return failFromError("update_lead_stage", e);
      }
    },
  });
}
