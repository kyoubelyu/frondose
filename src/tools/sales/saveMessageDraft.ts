import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
import { getLead, insertDraft } from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

// [P-75 D-20] kind 'post' added + leadId is now optional. Post is the operator's own
// content broadcast — not addressed to a specific lead — so it makes no sense to require
// a leadId for kind='post'. For all other kinds (connect_note/dm/follow_up/comment),
// leadId is still required (the draft is bound to a specific person and needs lead context).
const saveMessageDraftParams = z.object({
  leadId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Lead id this draft is bound to. REQUIRED for kind in (connect_note|dm|follow_up|comment). " +
        "OMIT for kind='post' (self-broadcasts aren't lead-bound).",
    ),
  kind: z.enum(["connect_note", "dm", "follow_up", "comment", "post"]),
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
      "Save a draft for status='draft' persistence: connect_note, dm, follow_up, comment, or post. " +
      "For connect_note/dm/follow_up/comment, provide leadId — the draft binds to that lead. " +
      "For 'post' (operator's own broadcast to LinkedIn feed), OMIT leadId — posts aren't lead-bound. " +
      "Sending requires a separate mark_message_sent call AFTER you have performed the actual " +
      "LinkedIn action. Returns { draftId }.",
    parameters: saveMessageDraftParams,
    execute: async (input) => {
      try {
        const parsed = saveMessageDraftParams.parse(input);
        const db = getSalesDb(salesDbPath);
        // [P-75 D-20] kind='post' MAY omit leadId. All other kinds REQUIRE leadId + valid lead.
        if (parsed.kind !== "post") {
          if (!parsed.leadId) {
            return fail(
              "save_message_draft",
              "invalid_input",
              `leadId is required for kind='${parsed.kind}'. Only kind='post' may omit leadId.`,
            );
          }
          const lead = getLead(db, parsed.leadId);
          if (!lead) return fail("save_message_draft", "not_found", `No lead with id ${parsed.leadId}`);
        }
        const draftId = insertDraft(db, {
          leadId: parsed.leadId ?? null,
          kind: parsed.kind,
          text: parsed.text,
          createdBy: parsed.createdBy,
          evidence: parsed.evidence,
        });
        return ok("save_message_draft", { draftId, leadId: parsed.leadId ?? null, status: "draft" });
      } catch (e) {
        return failFromError("save_message_draft", e);
      }
    },
  });
}
