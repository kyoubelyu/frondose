/** P-26: publish_event tool — wraps POST /api/event (fire-and-forget).
 *  NOT in IDEMPOTENT_TOOLS — retry would double-event. Returns
 *  `{ok:true, warning}` when server unreachable to keep the LLM moving
 *  (the event is informational, not load-bearing per GQ-6). */
import { tool } from "ai";
import { z } from "zod";
import type { ServerCoords } from "./queryLeadGlobally.js";

export function makePublishEventTool(serverCoords: ServerCoords | null) {
  return tool({
    description:
      "Publish a completed-action event to the orchestration server. " +
      "Call after any significant action (outreach sent, prospect qualified, error). " +
      "Fire-and-forget — returns immediately without blocking.",
    parameters: z.object({
      type: z.string().min(1),
      data: z.record(z.unknown()).optional(),
    }),
    execute: async (input): Promise<unknown> => {
      if (!serverCoords?.serverUrl) {
        return { ok: false, error: "server.url not configured; publish_event is a no-op." };
      }
      try {
        const res = await fetch(`${serverCoords.serverUrl}/api/event`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serverCoords.token}`,
          },
          body: JSON.stringify({ type: input.type, data: input.data ?? {} }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return { ok: false, error: `server returned HTTP ${res.status}` };
        return { ok: true };
      } catch (e) {
        return {
          ok: true,
          warning: `server unreachable, event dropped: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  });
}
