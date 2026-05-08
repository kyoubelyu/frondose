import type { ToolSet } from "ai";
import type { LinkedinSession } from "../linkedin/types.js";
import { echoTool } from "./control/echo.js";
import { makeIdentityTools } from "./identity/index.js";
import { makeLinkedinTools } from "./linkedin/index.js";
import { makeMemoryTools } from "./memory/index.js";

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

export interface PersistencePaths {
  memoryDbPath: string;
  identityPath: string;
}

/**
 * Build the full tool inventory:
 *   - { echo }              when neither session nor persistence given (P-1 invariant)
 *   - + 10 LinkedIn         when session given (P-3)
 *   - + 4 memory/identity   when persistence given (P-4)
 * With both → 15 tools total (G-P4.5).
 */
export function makeAllTools(session?: LinkedinSession, persistence?: PersistencePaths): ToolSet {
  const out: ToolSet = { echo: echoTool };
  // Memory + identity register from persistence regardless of session presence.
  // They're 100% Chrome-free (scout F-13) and useful even without LinkedIn.
  if (persistence) {
    Object.assign(out, makeMemoryTools(persistence.memoryDbPath));
    Object.assign(out, makeIdentityTools(persistence.identityPath));
  }
  // LinkedIn tools register when a session factory is given; they lazy-boot
  // Chrome on first call to session.getOrInitClient() inside execute.
  if (session) Object.assign(out, makeLinkedinTools(session));
  return out;
}
