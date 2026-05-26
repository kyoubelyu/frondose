import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import { countAutoLedgerByAction, getCurrentAutoRun } from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

const getAutoRunStateParams = z
  .object({})
  .describe("No parameters — returns the currently-running Auto run (or null).");

export function makeGetAutoRunStateTool(salesDbPath: string) {
  return tool({
    description:
      "Return the current Auto-mode run (status='running') with its action counters from " +
      "the ledger. Returns { run: null, counters: {} } when no Auto run is active. Use this " +
      "before any outbound action in Auto mode to verify caps have not been exceeded.",
    parameters: getAutoRunStateParams,
    execute: async (_input) => {
      try {
        const db = getSalesDb(salesDbPath);
        const run = getCurrentAutoRun(db);
        if (!run) return ok("get_auto_run_state", { run: null, counters: {} });
        const counters = countAutoLedgerByAction(db, run.id);
        return ok("get_auto_run_state", { run, counters });
      } catch (e) {
        return failFromError("get_auto_run_state", e);
      }
    },
  });
}
