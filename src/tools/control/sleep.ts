import { tool } from "ai";
import { z } from "zod";
import { ok } from "../../linkedin/envelope.js";

const sleepParams = z.object({
  seconds: z.number().int().min(1).max(300).describe("Seconds to wait (1–300)."),
  reason: z.string().max(200).optional().describe("Why pausing (logged to audit)."),
});

/**
 * Sleep tool — bounded setTimeout pause (1–300s). Use cases: pacing between
 * LinkedIn actions, retry backoff, delayed notifications.
 *
 * Pure function; no closures, no env-var reads, no control signals.
 */
export const sleepTool = tool({
  description:
    "Pause the agent for N seconds (1–300). Use for: pacing between LinkedIn actions, " +
    "retry backoff after a transient error, delayed notifications. " +
    "Do not use to stall — call stop if there's nothing to do.",
  parameters: sleepParams,
  execute: async ({ seconds, reason }) => {
    await new Promise((r) => setTimeout(r, seconds * 1000));
    return ok("sleep", { sleptSeconds: seconds, reason });
  },
});
