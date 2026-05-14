import { tool } from "ai";
import { z } from "zod";
import { buildInspectSummary, captureCurrentSurfaceContext, failFromError, ok } from "../../linkedin/index.js";
import type { LinkedinSession } from "../../linkedin/types.js";

const inspectParams = z.object({
  scope: z
    .string()
    .optional()
    .describe("Limit inspect output to a specific scope (e.g. 'feed', 'messagingThread'). Omit for full page."),
  full: z
    .boolean()
    .optional()
    .describe(
      "When true, append debug diagnostics (totalEntries, entriesByRole, roleDetails) " +
        "to the response data. Useful when compact discovery is insufficient.",
    ),
});

export function makeInspectTool(session: LinkedinSession) {
  return tool({
    description:
      "Snapshot the current LinkedIn surface and return a compact InspectSummary " +
      "{surface, availableScopes, text[], buttons[], inputs[]}. " +
      "Buttons and inputs each have ref strings (e.g. @e14) usable by `click` and `type`.",
    parameters: inspectParams,
    execute: async ({ scope, full }) => {
      try {
        const r = await session.getOrInitClient();
        if (!r.ok) return r;
        const ctx = await captureCurrentSurfaceContext(r.client);
        session.setLastContext(ctx);
        const summary = buildInspectSummary(ctx, scope);
        if (full) {
          const entriesByRole: Record<string, number> = {};
          for (const e of ctx.entries) {
            entriesByRole[e.role] = (entriesByRole[e.role] ?? 0) + 1;
          }
          const roleDetails = Object.keys(entriesByRole);
          return ok("inspect", { ...summary, totalEntries: ctx.entries.length, entriesByRole, roleDetails });
        }
        return ok("inspect", { ...summary });
      } catch (e) {
        return failFromError("inspect", e);
      }
    },
  });
}
