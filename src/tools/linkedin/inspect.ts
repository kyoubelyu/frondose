import { tool } from "ai";
import { z } from "zod";
import { buildInspectSummary, captureCurrentSurfaceContext, failFromError, ok } from "../../linkedin/index.js";
import type { LinkedinSession } from "../../linkedin/types.js";

const inspectParams = z.object({
  scope: z
    .string()
    .optional()
    .describe("Limit inspect output to a specific scope (e.g. 'feed', 'messagingThread'). Omit for full page."),
});

export function makeInspectTool(session: LinkedinSession) {
  return tool({
    description:
      "Snapshot the current LinkedIn surface and return a compact InspectSummary " +
      "{surface, availableScopes, text[], buttons[], inputs[]}. " +
      "Buttons and inputs each have ref strings (e.g. @e14) usable by `click` and `type`.",
    parameters: inspectParams,
    execute: async ({ scope }) => {
      try {
        const ctx = await captureCurrentSurfaceContext(session.getClient());
        session.setLastContext(ctx);
        const summary = buildInspectSummary(ctx, scope);
        // inspect's data is the InspectSummary shape directly (LLM consumes structured fields).
        return ok("inspect", { ...summary });
      } catch (e) {
        return failFromError("inspect", e);
      }
    },
  });
}
