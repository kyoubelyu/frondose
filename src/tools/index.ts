import type { ToolSet } from "ai";
import type { LinkedinSession } from "../linkedin/types.js";
import { echoTool } from "./control/echo.js";
import { makeLinkedinTools } from "./linkedin/index.js";

/**
 * P-1 tool inventory: just `echo`. Vercel `ToolSet` consumes this directly.
 * `as const satisfies ToolSet` (per guardian critic CONCERN-1): literal-key
 * inference for tool-name strict typing in callers AND explicit type-validation
 * that each value implements the `Tool` interface.
 */
export const tools = {
  echo: echoTool,
} as const satisfies ToolSet;

export type ToolKey = keyof typeof tools;

/**
 * Build the full tool inventory. If `session` is provided, includes the 10 LinkedIn tools
 * (P-3). If omitted (e.g. `MAI_NO_CHROME=1` echo-only smoke), returns just `{ echo }`.
 */
export function makeAllTools(session?: LinkedinSession): ToolSet {
  if (!session) return { echo: echoTool };
  return { echo: echoTool, ...makeLinkedinTools(session) };
}
