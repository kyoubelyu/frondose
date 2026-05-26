import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import { listDueFollowUps } from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

const listDueFollowupsParams = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Max number of due leads to return (1..100, default 20)."),
});

export function makeListDueFollowupsTool(salesDbPath: string) {
  return tool({
    description:
      "List leads whose next_action_due_at is at or before now, oldest-due first. " +
      "Use this at the start of a session or in Auto mode to find the leads needing attention.",
    parameters: listDueFollowupsParams,
    execute: async (input) => {
      try {
        const { limit } = listDueFollowupsParams.parse(input);
        const db = getSalesDb(salesDbPath);
        const leads = listDueFollowUps(db, Date.now(), limit);
        return ok("list_due_followups", { leads, count: leads.length });
      } catch (e) {
        return failFromError("list_due_followups", e);
      }
    },
  });
}
