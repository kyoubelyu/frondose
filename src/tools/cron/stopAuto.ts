import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import { disableAutoSessionRecords, readSchedule, writeSchedule } from "../../persistence/schedule.js";

const stopAutoParams = z.object({
  summary: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .optional()
    .describe("Optional summary for ending the current Auto session."),
});

/** P-AUTO-ISOLATE: disable auto_session schedules; runOne handles cron state + SSE. */
export function makeStopAutoTool(schedulePath: string) {
  return tool({
    description:
      "End the current Auto session. Disables all recurring auto-session schedule records so no " +
      "further Auto ticks fire. Idempotent: safe to call if no Auto session is active.",
    parameters: stopAutoParams,
    execute: async (input) => {
      try {
        const parsed = stopAutoParams.parse(input);
        const records = readSchedule(schedulePath);
        const { next, disabledCount } = disableAutoSessionRecords(records);
        writeSchedule(schedulePath, next);
        return ok("stop_auto", { sessionsDisabled: disabledCount, summary: parsed.summary ?? null });
      } catch (e) {
        return failFromError("stop_auto", e);
      }
    },
  });
}
