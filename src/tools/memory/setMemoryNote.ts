import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import { setMemoryNote } from "../../persistence/memory.js";
import { getMemoryDb } from "./_dbHandle.js";

const setMemoryNoteToolParams = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("Stable identifier for this note (e.g. a checkpoint key or topic name)."),
  value: z
    .string()
    .trim()
    .min(1)
    .max(8000)
    .describe("The note content — plain text or a JSON string. Stored verbatim."),
});

/** P-39: `set_memory_note` — upsert a general (non-person) key/value note. */
export function makeSetMemoryNoteTool(memoryDbPath: string) {
  return tool({
    description:
      "Store a general fact, note, or intermediate result that is not about a specific LinkedIn person. " +
      "Upserts by key into the durable memory store — survives compaction and restarts, unlike the session log. " +
      "Use it for checkpoint keys, task state, and anything you must not forget.",
    parameters: setMemoryNoteToolParams,
    execute: async (input) => {
      try {
        const { key, value } = setMemoryNoteToolParams.parse(input);
        const db = getMemoryDb(memoryDbPath);
        setMemoryNote(key, value, db);
        return ok("set_memory_note", { key });
      } catch (e) {
        return failFromError("set_memory_note", e);
      }
    },
  });
}
