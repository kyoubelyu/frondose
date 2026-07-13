import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
import { appendTimelineEvent, getDraft, getLead, markDraftSent } from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

const markMessageSentParams = z.object({
  draftId: z.string().trim().min(1),
});

export function makeMarkMessageSentTool(salesDbPath: string) {
  return tool({
    description:
      "Mark a message draft as sent AFTER you have performed the actual LinkedIn action " +
      "(connect button click, DM submit, post publish, etc). Updates message_drafts.status='sent' and appends " +
      "a 'message_sent' event to the lead's timeline. For kind='post' drafts (no leadId), marks the draft sent " +
      "and returns leadId:null; no lead timeline event is appended (posts are self-anchored). " +
      "Rejects unless the draft's status is 'draft' — an already-sent draft, an operator-declined (rejected) " +
      "draft, or any other non-live status cannot be marked sent. Never reuse a draftId whose step was " +
      "declined; save a new draft instead.",
    parameters: markMessageSentParams,
    execute: async (input) => {
      try {
        const { draftId } = markMessageSentParams.parse(input);
        const db = getSalesDb(salesDbPath);
        const draft = getDraft(db, draftId);
        if (!draft) return fail("mark_message_sent", "not_found", `No draft with id ${draftId}`);
        if (draft.status === "sent") {
          return fail("mark_message_sent", "invalid_input", `Draft ${draftId} is already sent`);
        }
        // [P-FIX-MARK-SENT-STALE-DRAFT] Allow-list: only a live 'draft' row is sendable.
        // An operator-declined ('rejected') or any other non-draft status fails closed —
        // a stale draftId must never be resurrected into a false 'sent' record.
        if (draft.status !== "draft") {
          return fail(
            "mark_message_sent",
            "invalid_input",
            `Draft ${draftId} cannot be marked sent from status '${draft.status}'; only status 'draft' is sendable.`,
          );
        }
        if (draft.kind === "post" && (draft as { leadId: string | null }).leadId == null) {
          markDraftSent(db, draftId);
          return ok("mark_message_sent", { draftId, leadId: null });
        }
        const lead = getLead(db, draft.leadId);
        if (!lead) {
          return fail("mark_message_sent", "runtime_error", `Lead ${draft.leadId} missing for draft ${draftId}`);
        }
        markDraftSent(db, draftId);
        appendTimelineEvent(db, {
          candidateId: lead.candidateId,
          leadId: draft.leadId,
          eventType: "message_sent",
          metadata: { draftId, kind: draft.kind },
        });
        return ok("mark_message_sent", { draftId, leadId: draft.leadId });
      } catch (e) {
        return failFromError("mark_message_sent", e);
      }
    },
  });
}
