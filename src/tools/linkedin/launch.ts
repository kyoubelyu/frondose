import { tool } from "ai";
import { z } from "zod";
import { applyPacing, failFromError, normalizeDestination, ok } from "../../linkedin/index.js";
import type { LinkedinSession } from "../../linkedin/types.js";

const launchParams = z.object({
  destination: z
    .enum(["feed", "network", "notifications", "messaging", "message", "search", "profile", "company"])
    .describe("Named LinkedIn destination to navigate to. 'message' is a documented alias for 'messaging'."),
  args: z
    .array(z.string())
    .optional()
    .describe("Extra arguments. For destination='company', args[0] is the company slug (e.g. 'acme-corp')."),
});

export function makeLaunchTool(session: LinkedinSession) {
  return tool({
    description:
      "Navigate to a named LinkedIn destination (feed, profile, network, notifications, messaging, search, company). " +
      "Waits for the page to load. For destination='company', supply args=['<slug>'].",
    parameters: launchParams,
    execute: async ({ destination, args }) => {
      try {
        const url = normalizeDestination(destination, args);
        const client = await session.getOrInitClient();
        await client.navigate(url, "load");
        const pacing = await applyPacing();
        const finalUrl = await client.getCurrentUrl();
        return ok("launch", { url: finalUrl, pacing });
      } catch (e) {
        return failFromError("launch", e);
      }
    },
  });
}
