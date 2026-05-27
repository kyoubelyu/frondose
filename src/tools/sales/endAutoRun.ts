import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
import { countAutoLedgerByAction, endAutoRun, getAutoRun } from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

const endAutoRunParams = z.object({
  runId: z.string().trim().min(1),
  status: z
    .enum(["completed", "stopped_by_agent", "blocked"])
    .describe(
      "Why the run is ending. 'completed' = all leads processed / cap reached cleanly. " +
        "'stopped_by_agent' = no more actionable leads OR no clear next action. " +
        "'blocked' = abnormal page / CDP failure / cannot recover. NOTE: 'stopped_by_user' is " +
        "RESERVED for server-side cancellation via /workflow/cancel — never use it from the agent.",
    ),
  summary: z
    .string()
    .min(10)
    .max(2000)
    .describe(
      "Required human-readable narrative of what happened in this run. Include counts: " +
        "candidates observed, leads scored, leads qualified, outbound attempted, replies/intent. " +
        "Used in the Tauri UI auto-run-completed banner + audit trail.",
    ),
});

export function makeEndAutoRunTool(salesDbPath: string) {
  return tool({
    description:
      "Close the current Auto-mode day-run with a status + summary. Idempotent: re-calling on an " +
      "already-ended row returns {alreadyEnded:true} without mutation. Counters JSON is " +
      "auto-populated from the ledger — agent supplies only the narrative summary.",
    parameters: endAutoRunParams,
    execute: async (input) => {
      try {
        const parsed = endAutoRunParams.parse(input);
        const db = getSalesDb(salesDbPath);
        const existing = getAutoRun(db, parsed.runId);
        if (!existing) return fail("end_auto_run", "not_found", `No auto_run with id ${parsed.runId}`);
        const counters = countAutoLedgerByAction(db, parsed.runId);
        const result = endAutoRun(db, parsed.runId, {
          status: parsed.status,
          summary: parsed.summary,
          counters,
        });
        return ok("end_auto_run", {
          runId: parsed.runId,
          status: parsed.status,
          alreadyEnded: result.alreadyEnded,
          counters,
        });
      } catch (e) {
        return failFromError("end_auto_run", e);
      }
    },
  });
}
