import type { Tool, ToolSet } from "ai";
import type { HookRunner } from "../agent/hooks.js";
import { IDEMPOTENT_TOOLS, withRetry } from "../agent/retryWrapper.js";
import type { LinkedinSession } from "../linkedin/types.js";
import { echoTool } from "./control/echo.js";
import { makeControlTools } from "./control/index.js";
import type { ControlSignals } from "./control/stop.js";
import { wrapWithHooks } from "./hookWrapper.js";
import { makeIdentityTools } from "./identity/index.js";
import { makeLinkedinTools } from "./linkedin/index.js";
import { makeMemoryTools } from "./memory/index.js";
import { makeMethodologyTools } from "./methodology/index.js";
import { makeOperatorOutputTools } from "./operatorOutput/index.js";
import { makeWebTools } from "./webTools/index.js";

// Re-export ControlSignals for callers (e.g. src/cli/main.ts).
export type { ControlSignals } from "./control/stop.js";

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
 * Build the full tool inventory. P-9 surface (with all factories provisioned):
 *   1 echo + 2 memory + 2 identity + 1 methodology + 10 LinkedIn
 *   + 2 operatorOutput + 3 control + 3 webTools = 24 tools.
 *
 * P-9 (D-1 / D-11): after base registration, all idempotent tools are wrapped
 * with withRetry; if hookRunner present, ALL tools are then wrapped with
 * wrapWithHooks. Layer order (outermost → innermost): hookWrapper → retryWrapper
 * → original execute.
 */
export function makeAllTools(
  session?: LinkedinSession,
  persistence?: PersistencePaths,
  control?: ControlSignals,
  hookRunner?: HookRunner,
): ToolSet {
  const out: ToolSet = { echo: echoTool };
  // Memory + identity register from persistence regardless of session presence.
  // They're 100% Chrome-free (scout F-13) and useful even without LinkedIn.
  if (persistence) {
    Object.assign(out, makeMemoryTools(persistence.memoryDbPath));
    Object.assign(out, makeIdentityTools(persistence.identityPath));
    // P-5: methodology layer — qualify_profile reads identity.json ICP lazily.
    Object.assign(out, makeMethodologyTools({ identityPath: persistence.identityPath }));
  }
  // LinkedIn tools register when a session factory is given; they lazy-boot
  // Chrome on first call to session.getOrInitClient() inside execute.
  if (session) Object.assign(out, makeLinkedinTools(session));

  // P-6: operator-output (telegram_notify + gh_issue) + control (stop / sleep /
  // escalate_for_capability) tools. Registered only when `control` is given —
  // matches operator's "I want full agent capability" intent. Operator-output tools
  // read env vars at execute time; missing env returns error envelope.
  if (control) {
    const operatorOutputTools = makeOperatorOutputTools();
    Object.assign(out, operatorOutputTools);
    Object.assign(
      out,
      makeControlTools(
        control,
        {
          // biome-ignore lint/style/noNonNullAssertion: makeOperatorOutputTools always populates these.
          telegramTool: operatorOutputTools.telegram_notify!,
          // biome-ignore lint/style/noNonNullAssertion: makeOperatorOutputTools always populates these.
          ghIssueTool: operatorOutputTools.gh_issue!,
        },
        hookRunner,
      ),
    );
  }
  // P-9 F-3 / F-4: web tools always registered; no deps.
  Object.assign(out, makeWebTools());

  // P-9 D-1 / D-11: retry-wrap idempotent tools.
  for (const name of Object.keys(out)) {
    if (IDEMPOTENT_TOOLS.has(name)) {
      out[name] = withRetry(out[name] as Tool);
    }
  }
  // P-9 D-11: hook-wrap every tool when hookRunner present (no-op if hooks.json absent).
  if (hookRunner) {
    for (const name of Object.keys(out)) {
      out[name] = wrapWithHooks(out[name] as Tool, hookRunner, name);
    }
  }
  return out;
}
