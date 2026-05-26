import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
import { getLead, insertDraft } from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

const saveMessageDraftParams = z.object({
  leadId: z.string().trim().min(1),
  kind: z.enum(["connect_note", "dm", "follow_up", "comment"]),
  text: z.string().trim().min(1).max(8000),
  createdBy: z.enum(["llm", "user"]).default("llm"),
  evidence: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .describe("Optional supporting context (e.g. the inspect snippet that informed this draft)."),
});

export function makeSaveMessageDraftTool(salesDbPath: string) {
  return tool({
    description:
      "Save a message draft (connect note, DM, follow-up, or comment) for a lead. " +
      "The draft is persisted with status='draft' — sending requires a separate mark_message_sent " +
      "call AFTER you have performed the actual LinkedIn action. Returns { draftId }.",
    parameters: saveMessageDraftParams,
    execute: async (input) => {
      try {
        const parsed = saveMessageDraftParams.parse(input);
        const db = getSalesDb(salesDbPath);
        const lead = getLead(db, parsed.leadId);
        if (!lead) return fail("save_message_draft", "not_found", `No lead with id ${parsed.leadId}`);
        const draftId = insertDraft(db, parsed);
        return ok("save_message_draft", { draftId, leadId: parsed.leadId, status: "draft" });
      } catch (e) {
        return failFromError("save_message_draft", e);
      }
    },
  });
}
