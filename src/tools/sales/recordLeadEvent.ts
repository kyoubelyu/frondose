import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
import { appendTimelineEvent, getLead } from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

const recordLeadEventParams = z.object({
  leadId: z.string().trim().min(1),
  eventType: z.enum([
    "discovered",
    "viewed",
    "researched",
    "scored",
    "promoted_to_lead",
    "connect_sent",
    "connected",
    "message_sent",
    "replied",
    "sales_intent_detected",
    "meeting_booked",
    "disqualified",
    "follow_up_scheduled",
    "auto_stopped",
  ]),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional JSON metadata (e.g. { messageId, sentiment } for a reply event)."),
});

export function makeRecordLeadEventTool(salesDbPath: string) {
  return tool({
    description:
      "Append an arbitrary event to a lead's timeline (replay log). Use update_lead_stage " +
      "when the stage changes; use this tool for fine-grained events that do NOT change stage " +
      "(viewed, researched, sales_intent_detected, auto_stopped). The metadata JSON travels " +
      "with the event for later analytics.",
    parameters: recordLeadEventParams,
    execute: async (input) => {
      try {
        const { leadId, eventType, metadata } = recordLeadEventParams.parse(input);
        const db = getSalesDb(salesDbPath);
        const lead = getLead(db, leadId);
        if (!lead) return fail("record_lead_event", "not_found", `No lead with id ${leadId}`);
        const id = appendTimelineEvent(db, { candidateId: lead.candidateId, leadId, eventType, metadata });
        return ok("record_lead_event", { eventId: id, leadId, eventType });
      } catch (e) {
        return failFromError("record_lead_event", e);
      }
    },
  });
}
