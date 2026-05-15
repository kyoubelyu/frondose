import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import { interactionKindSchema } from "../../linkedin/memoryProjection.js";
import { appendPersonInteraction, rememberInputSchema } from "../../persistence/memory.js";
import { getMemoryDb } from "./_dbHandle.js";

const rememberToolParams = z.object({
  personName: z.string().trim().min(1).describe("Full name of the person."),
  profileUrl: z.string().trim().url().describe("LinkedIn profile URL (e.g. https://www.linkedin.com/in/alice/)."),
  interaction: interactionKindSchema.describe("Interaction kind: like, comment, repost, message, connect, post, at."),
  summary: z.string().trim().min(1).max(220).describe("What happened (≤220 chars)."),
  notes: z.string().trim().min(1).max(220).optional().describe("Context or observation (≤220 chars)."),
  avoid: z.string().trim().min(1).max(160).optional().describe("What to avoid (≤160 chars)."),
  nextAction: z.string().trim().min(1).max(160).optional().describe("Suggested next action (≤160 chars)."),
});

/** Build the `remember` Vercel tool for a given memory DB path.
 *  P-26: when `serverCoords` is supplied, the tool fires-and-forgets
 *  POST /api/lead/touch after the local insert. Server failure is silent —
 *  local memory is authoritative for the worker's own ICP qualification. */
export function makeRememberTool(memoryDbPath: string, serverCoords?: { serverUrl: string; token: string }) {
  return tool({
    description:
      "Record an interaction with a LinkedIn person. Persisted to ~/.mai/agent/memory.sqlite. " +
      "Use this whenever the operator says they want to remember a person, message, or interaction.",
    parameters: rememberToolParams,
    execute: async (input) => {
      try {
        const validated = rememberInputSchema.parse(input);
        const db = getMemoryDb(memoryDbPath);
        const event = appendPersonInteraction(validated, db);
        // P-26: fire-and-forget POST /api/lead/touch when serverCoords supplied.
        // Local write already succeeded; server failure is silent per GQ-7.
        if (serverCoords) {
          const body = JSON.stringify({
            personRef: event.profileUrl,
            actionType: event.interaction,
            ts: Date.now(),
          });
          // Intentionally NOT awaited — fire-and-forget. The .catch keeps an
          // unhandled rejection from logging during server downtime.
          fetch(`${serverCoords.serverUrl}/api/lead/touch`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${serverCoords.token}`,
            },
            body,
            signal: AbortSignal.timeout(5000),
          }).catch(() => {
            // Server unreachable; local insert succeeded — silent per GQ-7.
          });
        }
        return ok("remember", { event });
      } catch (e) {
        return failFromError("remember", e);
      }
    },
  });
}
