import { tool } from "ai";
import { z } from "zod";

export const suggestCardTool = tool({
  description:
    "Push a methodology-aware suggestion card to the operator's in-page hover dialog. " +
    "Call this AFTER qualify_profile when the operator clicked the pill on a profile page. " +
    "If the profile cannot be suggested (no ICP match, extraction failed, private profile), " +
    "call with {dismissed:true, reason:'...'}. Zero side effects.",
  parameters: z.object({
    dismissed: z.boolean().optional(),
    reason: z.string().optional(),
    title: z.string().optional(),
    // P-SP-C: numeric score copied from lead_scores (single source of truth);
    // the card displays it, score_lead persists it. Both fields are additive
    // optional → existing callers that omit them remain backward-compatible.
    totalScore: z.number().int().min(0).max(100).optional(),
    evidenceSummary: z.string().max(280).optional(),
    icpMatch: z
      .object({
        qualified: z.boolean(),
        matched: z.array(z.string()),
        missing: z.array(z.string()),
      })
      .optional(),
    painChainHypothesis: z.string().max(280).optional(),
    painChainStage: z
      .enum([
        "precall",
        "spark-interest",
        "R1-open",
        "R2-controlled",
        "R3-confirming",
        "I1-open",
        "I2-controlled",
        "I3-confirming",
        "C1-open",
        "C2-controlled",
        "C3-confirming",
        "validate",
        "close",
        "post",
        "disqualified",
      ])
      .optional(),
    suggestedMove: z
      .object({
        kind: z.enum(["connect", "comment", "message"]),
        text: z.string().max(500),
      })
      .optional(),
  }),
  execute: async (input) => {
    return { ok: true, ...input };
  },
});
