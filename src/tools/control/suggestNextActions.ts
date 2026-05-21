import { tool } from "ai";
import { z } from "zod";

export const suggestNextActionsTool = tool({
  description:
    "Surface 1-3 next-action buttons to the operator. Use as the TERMINAL step of a turn. " +
    "Each action carries a natural-language `prompt` re-fired on operator click. Zero side effects.",
  parameters: z.object({
    summary: z.string().max(280),
    actions: z
      .array(
        z.object({
          id: z.string().max(40),
          label: z.string().max(30),
          prompt: z.string().max(500),
          danger: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(3),
  }),
  execute: async (input) => {
    return { ok: true, ...input };
  },
});
