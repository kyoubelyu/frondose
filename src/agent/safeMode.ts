/** P-26: withSafeMode wrapper — refuses 4 outreach tools when isSafeMode()=true.
 *
 *  Pass-through behavior:
 *    - Tools NOT in OUTREACH_TOOL_NAMES → returned verbatim (no wrap overhead).
 *    - Outreach tools in safe-mode → return structured envelope; original
 *      `execute` is NOT invoked.
 *    - Outreach tools NOT in safe-mode → forward to the original `execute`. */
import type { Tool } from "ai";
import { isSafeMode } from "../persistence/safeModeState.js";

export const OUTREACH_TOOL_NAMES: ReadonlySet<string> = new Set(["click", "type", "press", "upload"]);

export function withSafeMode(originalTool: Tool, toolName: string): Tool {
  if (!OUTREACH_TOOL_NAMES.has(toolName)) return originalTool;
  return {
    ...originalTool,
    execute: async (args: unknown, opts: { abortSignal?: AbortSignal }): Promise<unknown> => {
      if (isSafeMode()) {
        return {
          ok: false,
          error: `safe-mode: server unreachable for >2 min; outreach tool ${toolName} refused. Resume after heartbeat recovers.`,
        };
      }
      return await (originalTool.execute as (a: unknown, o: typeof opts) => Promise<unknown>)(args, opts);
    },
  };
}
