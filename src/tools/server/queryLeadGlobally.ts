/** P-26: query_lead_globally tool — wraps POST /api/lead/check.
 *  Idempotent (read-only); registered in IDEMPOTENT_TOOLS for retry-wrap. */
import { tool } from "ai";
import { z } from "zod";

export interface ServerCoords {
  serverUrl: string;
  token: string;
  workerId: string;
}

export function makeQueryLeadGloballyTool(serverCoords: ServerCoords | null) {
  return tool({
    description:
      "Before any outreach to a LinkedIn prospect, call this to check if any worker " +
      "has recently contacted them. If allowed=false, do NOT proceed with outreach. " +
      "personRef = normalized LinkedIn profile URL.",
    parameters: z.object({
      personRef: z.string().url().describe("LinkedIn profile URL of the prospect."),
      lookbackHours: z.number().int().min(1).max(720).optional().describe("Lookback window in hours (default 72)."),
    }),
    execute: async (input): Promise<unknown> => {
      if (!serverCoords?.serverUrl) {
        return {
          ok: false,
          error: "server.url not configured; query_lead_globally unavailable. Proceed with local memory only.",
        };
      }
      try {
        const res = await fetch(`${serverCoords.serverUrl}/api/lead/check`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serverCoords.token}`,
          },
          body: JSON.stringify({
            personRef: input.personRef,
            lookbackHours: input.lookbackHours ?? 72,
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return { ok: false, error: `server returned HTTP ${res.status}` };
        return await res.json();
      } catch (e) {
        return { ok: false, error: `server unreachable: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  });
}
