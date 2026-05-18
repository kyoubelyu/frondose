import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import { getMemoryNote } from "../../persistence/memory.js";
import { getMemoryDb } from "./_dbHandle.js";

const getMemoryNoteToolParams = z.object({
  key: z.string().trim().min(1).max(200).describe("The key of the note to retrieve."),
});

/** P-39: `get_memory_note` — read a general key/value note. Always returns an
 *  `ok` envelope with `{ found, note }` — absence is a normal answer (D-7), so
 *  the CHECKPOINT idempotency probe never sees an error envelope. */
export function makeGetMemoryNoteTool(memoryDbPath: string) {
  return tool({
    description:
      "Retrieve a general (non-person) memory note by key. Returns { found, note }; " +
      "found is false and note is null when no note exists for that key.",
    parameters: getMemoryNoteToolParams,
    execute: async (input) => {
      try {
        const { key } = getMemoryNoteToolParams.parse(input);
        const db = getMemoryDb(memoryDbPath);
        const note = getMemoryNote(key, db);
        return ok("get_memory_note", { found: note !== null, note });
      } catch (e) {
        return failFromError("get_memory_note", e);
      }
    },
  });
}
