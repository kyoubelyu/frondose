import type { ToolSet } from "ai";
import { makeGetMemoryTool } from "./getMemory.js";
import { makeGetMemoryNoteTool } from "./getMemoryNote.js";
import { makeRememberTool } from "./remember.js";
import { makeSearchMemoryTool } from "./searchMemory.js";
import { makeSetMemoryNoteTool } from "./setMemoryNote.js";

/** Build memory tools.
 *  P-39: + search_memory + set_memory_note + get_memory_note (both modes). */
export function makeMemoryTools(memoryDbPath: string): ToolSet {
  return {
    remember: makeRememberTool(memoryDbPath),
    getMemory: makeGetMemoryTool(memoryDbPath),
    search_memory: makeSearchMemoryTool(memoryDbPath),
    set_memory_note: makeSetMemoryNoteTool(memoryDbPath),
    get_memory_note: makeGetMemoryNoteTool(memoryDbPath),
  };
}
