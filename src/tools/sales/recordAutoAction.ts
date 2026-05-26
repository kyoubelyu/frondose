import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
import { appendAutoLedger, getAutoRun } from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

const recordAutoActionParams = z.object({
  runId: z.string().trim().min(1),
  actionType: z.enum(["connect_sent", "message_sent", "follow_up_sent", "comment_posted"]),
  leadId: z.string().trim().min(1).optional(),
  result: z.enum(["success", "failed", "skipped"]),
  countWeight: z
    .number()
    .min(0)
    .max(10)
    .optional()
    .describe("Optional weight (default 1.0) — for fractional cap counting."),
});

export function makeRecordAutoActionTool(salesDbPath: string) {
  return tool({
    description:
      "Record an outbound-relevant action in the Auto-run ledger. Used by Auto mode AFTER " +
      "every connect/message/follow-up/comment attempt to enforce caps. The ledger is the " +
      "source of truth for cap-check queries via get_auto_run_state.",
    parameters: recordAutoActionParams,
    execute: async (input) => {
      try {
        const parsed = recordAutoActionParams.parse(input);
        const db = getSalesDb(salesDbPath);
        const run = getAutoRun(db, parsed.runId);
        if (!run) return fail("record_auto_action", "not_found", `No auto_run with id ${parsed.runId}`);
        const ledgerId = appendAutoLedger(db, parsed);
        return ok("record_auto_action", { ledgerId, runId: parsed.runId });
      } catch (e) {
        return failFromError("record_auto_action", e);
      }
    },
  });
}
