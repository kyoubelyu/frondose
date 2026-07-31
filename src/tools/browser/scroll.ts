import { tool } from "ai";
import { z } from "zod";
import { hardwareScroll } from "../../cdp/hardwareInput.js";
import type { ScrollOutcome } from "../../cdp/scroll.js";
import { applyPacing, fail, failFromError, ok } from "../../linkedin/index.js";
import type { CommandFailure, LinkedinSession } from "../../linkedin/types.js";

const scrollParams = z.object({
  direction: z.enum(["up", "down", "left", "right"]).default("down").describe("Scroll direction."),
  amount: z.number().int().positive().default(3500).describe("Pixels to scroll. Default 3500."),
});

interface ScrollToolDeps {
  hardwareScroll?: typeof hardwareScroll;
}

type ScrollFailure = CommandFailure & {
  scroll: Extract<ScrollOutcome, { state: "not_moved" }>;
};

function noMovementFailure(scroll: Extract<ScrollOutcome, { state: "not_moved" }>): ScrollFailure {
  return {
    ...fail("scroll", "runtime_error", `Scroll did not move document: ${scroll.reason}.`),
    scroll,
  };
}

export function makeScrollTool(session: LinkedinSession, deps: ScrollToolDeps = {}) {
  const executeHardwareScroll = deps.hardwareScroll ?? hardwareScroll;
  return tool({
    description: "Scroll the current page by a pixel amount in a given direction.",
    parameters: scrollParams,
    execute: async ({ direction, amount }) => {
      try {
        const r = await session.getOrInitClient();
        if (!r.ok) return r;
        const { client } = r;
        let scroll: ScrollOutcome;
        if (session.inputMode === "hardware") {
          await executeHardwareScroll(client, direction, amount);
          scroll = {
            verification: "unavailable",
            state: "unverified",
            target: "hardware",
            axis: direction === "left" || direction === "right" ? "x" : "y",
          };
        } else {
          scroll = await client.scroll(direction, amount);
        }
        const pacing = await applyPacing();
        if (scroll.state === "not_moved") {
          return noMovementFailure(scroll);
        }
        return ok("scroll", { direction, amount, pacing, scroll });
      } catch (e) {
        return failFromError("scroll", e);
      }
    },
  });
}
