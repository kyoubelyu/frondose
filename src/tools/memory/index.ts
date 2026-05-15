import type { ToolSet } from "ai";
import { makeGetMemoryTool } from "./getMemory.js";
import { makeRememberTool } from "./remember.js";

/** Build memory tools. P-26: when `serverCoords` is supplied, `remember`
 *  also fires-and-forgets `POST /api/lead/touch` after local insert. */
export function makeMemoryTools(memoryDbPath: string, serverCoords?: { serverUrl: string; token: string }): ToolSet {
  return {
    remember: makeRememberTool(memoryDbPath, serverCoords),
    getMemory: makeGetMemoryTool(memoryDbPath),
  };
}
