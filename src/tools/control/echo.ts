import { tool } from "ai";
import { z } from "zod";

/**
 * Echo tool — returns its input wrapped in `{ echoed }`.
 * Single tool registered in P-1 to exercise the agent loop end-to-end.
 *
 * No `child_process` import here (lint-enforced under src/tools/**); tool body
 * is a pure passthrough.
 */
export const echoTool = tool({
  description: "Echo a message back to the caller. Useful for end-to-end tool-call verification.",
  parameters: z.object({
    message: z.string().describe("The message to echo back verbatim."),
  }),
  execute: async ({ message }) => {
    return { echoed: message };
  },
});
