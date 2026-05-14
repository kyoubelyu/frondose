import { tool } from "ai";
import { z } from "zod";
import { applyPacing, failFromError, ok } from "../../linkedin/index.js";
import type { LinkedinSession } from "../../linkedin/types.js";

const scrollParams = z.object({
  direction: z.enum(["up", "down", "left", "right"]).default("down").describe("Scroll direction."),
  amount: z.number().int().positive().default(3500).describe("Pixels to scroll. Default 3500."),
});

export function makeScrollTool(session: LinkedinSession) {
  return tool({
    description: "Scroll the current page by a pixel amount in a given direction.",
    parameters: scrollParams,
    execute: async ({ direction, amount }) => {
      try {
        const r = await session.getOrInitClient();
        if (!r.ok) return r;
        const { client } = r;
        await client.scroll(direction, amount);
        const pacing = await applyPacing();
        return ok("scroll", { direction, amount, pacing });
      } catch (e) {
        return failFromError("scroll", e);
      }
    },
  });
}
