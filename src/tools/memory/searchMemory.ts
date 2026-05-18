import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import { searchMemory } from "../../persistence/memory.js";
import { getMemoryDb } from "./_dbHandle.js";

const searchMemoryToolParams = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .describe("Keywords to search across all remembered people — names, summaries, notes, interaction kinds."),
  limit: z.number().int().min(1).max(50).optional().describe("Max results to return (default 10)."),
});

/** P-39: `search_memory` — FTS5 keyword search over memory.sqlite, ranked by relevance. */
export function makeSearchMemoryTool(memoryDbPath: string) {
  return tool({
    description:
      "Keyword full-text search across everything remembered about all contacts and people. " +
      "Returns the best-matching interactions ranked by relevance, each with a highlighted snippet " +
      "and the person's lead score (0–10) when rated. Use it to recall what you already know before acting.",
    parameters: searchMemoryToolParams,
    execute: async (input) => {
      try {
        const { query, limit } = searchMemoryToolParams.parse(input);
        const db = getMemoryDb(memoryDbPath);
        const hits = searchMemory(query, limit ?? 10, db);
        return ok("search_memory", { hits, count: hits.length });
      } catch (e) {
        return failFromError("search_memory", e);
      }
    },
  });
}
