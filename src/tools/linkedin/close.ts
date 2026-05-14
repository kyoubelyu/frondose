import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/index.js";
import type { LinkedinSession } from "../../linkedin/types.js";

export function makeCloseTool(session: LinkedinSession) {
  return tool({
    description:
      "Close the entire Chrome browser, terminating all tabs. The agent's binary keeps running, " +
      "but subsequent LinkedIn tools will fail until Chrome is reopened.",
    parameters: z.object({}),
    execute: async () => {
      try {
        const r = await session.getOrInitClient();
        if (!r.ok) return r;
        const { client } = r;
        await client.closeBrowser();
        return ok("close", {});
      } catch (e) {
        return failFromError("close", e);
      }
    },
  });
}
