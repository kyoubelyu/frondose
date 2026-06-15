import { tool } from "ai";
import { z } from "zod";
import { buildInspectSummary, captureCurrentSurfaceContext, failFromError, ok } from "../../linkedin/index.js";
import { dedupKeyFor, filterEntriesByScope, PERSON_BEARING_ROLES, TEXT_ROLES } from "../../linkedin/inspectSummary.js";
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
      "Snapshot the current page surface and return a compact InspectSummary " +
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
          // P-AUTO-15a (CAP-3 (d) + N2 fix): structured truncation diagnostics
          // derived from the SAME scope-filtered + deduped text-eligible set
          // buildInspectSummary's partition + hint decision operated on. Pins
          // consistency between the hint string and the structured fields for
          // BOTH full-surface (scope=undefined) and scoped invocations.
          const scopedEntries = scope ? filterEntriesByScope(ctx.entries, scope) : ctx.entries;
          const seenForDiag = new Set<string>();
          const dedupedTextEligible = scopedEntries.filter((e) => {
            if (!(TEXT_ROLES.has(e.role) && e.name.length > 0)) return false;
            const k = dedupKeyFor(e);
            if (seenForDiag.has(k)) return false;
            seenForDiag.add(k);
            return true;
          });
          const visibleTextCount = dedupedTextEligible.length;
          const personEntryCount = dedupedTextEligible.filter((e) => PERSON_BEARING_ROLES.has(e.role)).length;
          // shownTextCount excludes the synthetic hint entry (always prefixed "[diagnostic]").
          const shownTextCount = summary.text.filter((t) => !t.startsWith("[diagnostic]")).length;
          return ok("inspect", {
            ...summary,
            totalEntries: ctx.entries.length,
            entriesByRole,
            roleDetails,
            visibleTextCount,
            shownTextCount,
            personEntryCount,
          });
        }
        return ok("inspect", { ...summary });
      } catch (e) {
        return failFromError("inspect", e);
      }
    },
  });
}
