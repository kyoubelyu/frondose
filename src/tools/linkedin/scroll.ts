import { tool } from "ai";
import { z } from "zod";
import { applyPacing, failFromError, ok } from "../../linkedin/index.js";
import type { LinkedinSession } from "../../linkedin/types.js";

const scrollParams = z.object({
  direction: z.enum(["up", "down", "left", "right"]).default("down").describe("Scroll direction."),
  amount: z.number().int().positive().default(300).describe("Pixels to scroll. Default 300."),
});

export function makeScrollTool(session: LinkedinSession) {
  return tool({
    description: "Scroll the current page by a pixel amount in a given direction.",
    parameters: scrollParams,
    execute: async ({ direction, amount }) => {
      try {
        await session.getClient().scroll(direction, amount);
        const pacing = await applyPacing();
        return ok("scroll", { direction, amount, pacing });
      } catch (e) {
        return failFromError("scroll", e);
      }
    },
  });
}
