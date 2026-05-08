import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/index.js";
import type { LinkedinSession } from "../../linkedin/types.js";

export function makeReloadTool(session: LinkedinSession) {
  return tool({
    description: "Reload the current LinkedIn page and wait for load.",
    parameters: z.object({}),
    execute: async () => {
      try {
        const client = await session.getOrInitClient();
        await client.reload();
        // Reload doesn't auto-wait; do it explicitly.
        await client.waitFor({ kind: "load", state: "load" });
        return ok("reload", {});
      } catch (e) {
        return failFromError("reload", e);
      }
    },
  });
}
