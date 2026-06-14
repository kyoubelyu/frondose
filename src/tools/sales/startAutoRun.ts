import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import { DEFAULT_AUTO_RUN_MAX_CONNECTS, getCurrentAutoRun, insertAutoRun } from "../../persistence/salesDb.js";
import { getSalesDb } from "./_dbHandle.js";

const startAutoRunParams = z.object({
  maxDurationMinutes: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .optional()
    .describe("Total run duration cap in minutes (wall clock). Defaults to 480 (8 hours)."),
  maxConnects: z.number().int().min(0).max(1000).nullable().optional().describe(
    // P-AUTO-1+2 (NIT-3): omitted ≠ null. Omitted falls back to DEFAULT_AUTO_RUN_MAX_CONNECTS
    // (5) as a conservative LinkedIn-safe cap; explicit null is preserved as operator opt-out.
    `Total outbound connect-send cap for this run. Omitted = ${DEFAULT_AUTO_RUN_MAX_CONNECTS} (default); null = explicit opt-out (no cap).`,
  ),
});

export function makeStartAutoRunTool(salesDbPath: string) {
  return tool({
    description:
      "Begin (or resume) the current Auto-mode day-run. Idempotent: if an auto_runs row with " +
      "status='running' already exists, returns it unchanged (the caller's caps are IGNORED in " +
      "resume — the original run's caps are authoritative). Call at the top of every Auto turn. " +
      "Returned runId is required by record_auto_action and end_auto_run.",
    parameters: startAutoRunParams,
    execute: async (input) => {
      try {
        const parsed = startAutoRunParams.parse(input);
        const db = getSalesDb(salesDbPath);
        const existing = getCurrentAutoRun(db);
        if (existing) {
          return ok("start_auto_run", {
            runId: existing.id,
            startedAt: existing.startedAt,
            maxDurationMinutes: existing.maxDurationMinutes,
            maxConnects: existing.maxConnects,
            resumed: true,
          });
        }
        const row = insertAutoRun(db, {
          maxDurationMinutes: parsed.maxDurationMinutes,
          // P-AUTO-1+2 B-5: pass through undefined / null distinctly so insertAutoRun can
          // apply DEFAULT_AUTO_RUN_MAX_CONNECTS to omitted (undefined) while preserving an
          // explicit `null` opt-out. (Stop coercing `?? null`, which collapsed both to null.)
          maxConnects: parsed.maxConnects,
        });
        return ok("start_auto_run", {
          runId: row.id,
          startedAt: row.startedAt,
          maxDurationMinutes: row.maxDurationMinutes,
          maxConnects: row.maxConnects,
          resumed: false,
        });
      } catch (e) {
        return failFromError("start_auto_run", e);
      }
    },
  });
}
