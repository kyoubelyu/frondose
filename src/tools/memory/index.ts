import type { ToolSet } from "ai";
import { makeGetMemoryTool } from "./getMemory.js";
import { makeRememberTool } from "./remember.js";

export function makeMemoryTools(memoryDbPath: string): ToolSet {
  return {
    remember: makeRememberTool(memoryDbPath),
    getMemory: makeGetMemoryTool(memoryDbPath),
  };
}
