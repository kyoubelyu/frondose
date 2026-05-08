import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";
import { formatMemoryProjection } from "../../linkedin/memoryProjection.js";
import { getPersonMemory, memoryQuerySchema } from "../../persistence/memory.js";
import { getMemoryDb } from "./_dbHandle.js";

const getMemoryToolParams = z
  .object({
    personName: z.string().trim().min(1).optional().describe("Person's full name."),
    profileUrl: z.string().trim().url().optional().describe("Person's LinkedIn profile URL."),
  })
  .refine((d) => d.personName || d.profileUrl, "Provide personName or profileUrl");

export function makeGetMemoryTool(memoryDbPath: string) {
  return tool({
    description:
      "Look up everything previously remembered about a LinkedIn person. " +
      "Provide either personName or profileUrl. Returns the latest interaction summary, full history, and any avoid/nextAction notes.",
    parameters: getMemoryToolParams,
    execute: async (input) => {
      try {
        const query = memoryQuerySchema.parse(input);
        const db = getMemoryDb(memoryDbPath);
        const memory = getPersonMemory(query, db);
        if (!memory) {
          return fail(
            "getMemory",
            "not_found",
            `No memory found for ${query.personName ?? query.profileUrl}. Use the remember tool to record interactions first.`,
          );
        }
        return ok("getMemory", {
          memory,
          summary: memory.latestInteraction.summary,
          formatted: formatMemoryProjection(memory),
        });
      } catch (e) {
        return failFromError("getMemory", e);
      }
    },
  });
}
