import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
import { countLeadsByAccount, getAccount, listTimelineByAccount } from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

const getAccountContextParams = z.object({
  accountId: z.string().trim().min(1),
  timelineLimit: z.number().int().min(1).max(200).default(20),
});

export function makeGetAccountContextTool(salesDbPath: string) {
  return tool({
    description:
      "Return the account row, the count of leads linked to it, and the recent timeline " +
      "across all leads in this account (latest first). Use this to understand the account " +
      "before recording a new candidate or drafting outreach to someone at the same company.",
    parameters: getAccountContextParams,
    execute: async (input) => {
      try {
        const { accountId, timelineLimit } = getAccountContextParams.parse(input);
        const db = getSalesDb(salesDbPath);
        const account = getAccount(db, accountId);
        if (!account) return fail("get_account_context", "not_found", `No account with id ${accountId}`);
        const leadsCount = countLeadsByAccount(db, accountId);
        const recentTimeline = listTimelineByAccount(db, accountId, timelineLimit);
        return ok("get_account_context", { account, leadsCount, recentTimeline });
      } catch (e) {
        return failFromError("get_account_context", e);
      }
    },
  });
}
