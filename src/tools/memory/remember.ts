import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import { interactionKindSchema } from "../../linkedin/memoryProjection.js";
import { appendPersonInteraction, rememberInputSchema } from "../../persistence/memory.js";
import { getMemoryDb } from "./_dbHandle.js";

const rememberToolParams = z.object({
  personName: z.string().trim().min(1).describe("Full name of the person."),
  profileUrl: z.string().trim().url().describe("LinkedIn profile URL (e.g. https://www.linkedin.com/in/alice/)."),
  interaction: interactionKindSchema.describe("Interaction kind: like, comment, repost, message, connect, post, at."),
  summary: z.string().trim().min(1).max(220).describe("What happened (≤220 chars)."),
  notes: z.string().trim().min(1).max(220).optional().describe("Context or observation (≤220 chars)."),
  avoid: z.string().trim().min(1).max(160).optional().describe("What to avoid (≤160 chars)."),
  nextAction: z.string().trim().min(1).max(160).optional().describe("Suggested next action (≤160 chars)."),
});

/** Build the `remember` Vercel tool for a given memory DB path. */
export function makeRememberTool(memoryDbPath: string) {
  return tool({
    description:
      "Record an interaction with a LinkedIn person. Persisted to ~/.mai/agent/memory.sqlite. " +
      "Use this whenever the operator says they want to remember a person, message, or interaction.",
    parameters: rememberToolParams,
    execute: async (input) => {
      try {
        const validated = rememberInputSchema.parse(input);
        const db = getMemoryDb(memoryDbPath);
        const event = appendPersonInteraction(validated, db);
        return ok("remember", { event });
      } catch (e) {
        return failFromError("remember", e);
      }
    },
  });
}
