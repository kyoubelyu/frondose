import { tool } from "ai";
import { z } from "zod";

export const presentSummarySchema = z.object({
  title: z.string().min(1).max(96),
  summary: z.string().min(1).max(700),
  bullets: z.array(z.string().min(1).max(180)).max(5).optional(),
  nextStep: z.string().min(1).max(240).optional(),
});

export const presentSummaryTool = tool({
  description:
    "Present a compact operator-facing summary card in the in-page Frondose overlay dialog. " +
    "Use when a concise visual summary is better than verbose assistant text. Zero side effects.",
  parameters: presentSummarySchema,
  execute: async (input) => {
    return { ok: true, ...input };
  },
});
