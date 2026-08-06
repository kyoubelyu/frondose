import { join } from "node:path";
import type { Tool, ToolSet } from "ai";
import type { HookRunner } from "../agent/hooks.js";
import { IDEMPOTENT_TOOLS, withRetry } from "../agent/retryWrapper.js";
import type { LinkedinSession } from "../linkedin/types.js";
import { DATA_DIR_NAME, getHomeBase } from "../persistence/paths.js";
import { type MaiTier, resolveTier } from "../tier.js";
import { makeBrowserTools } from "./browser/index.js";
import { echoTool } from "./control/echo.js";
import { makeControlTools } from "./control/index.js";
import type { ControlSignals } from "./control/stop.js";
import { makeCronTools } from "./cron/index.js";
import { wrapWithHooks } from "./hookWrapper.js";
import { makeIdentityTools } from "./identity/index.js";
import { makeLinkedinTools } from "./linkedin/index.js";
import { makeMemoryTools } from "./memory/index.js";
import { makeMethodologyTools } from "./methodology/index.js";
import { makeOperatorOutputTools } from "./operatorOutput/index.js";
import { makeSalesTools } from "./sales/index.js";
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
  schedulePath?: string;
  salesDbPath?: string;
}

/**
 * Build the App-only tool inventory (single mode). The retired fleet/server mode
 * and its heartbeat safe-mode wrappers are intentionally absent, as are the three
 * retired operator/lead tools (T-RETIRE.Report.1 + T-RETIRE.Fleet.2).
 * P-OPEN-SOURCE-SPLIT contract (§10.2): power = 51 tools, consumer = 49 tools,
 * differing only by telegram_notify + gh_issue.
 */
export function makeAllTools(
  session?: LinkedinSession,
  persistence?: PersistencePaths,
  control?: ControlSignals,
  hookRunner?: HookRunner,
  opts?: { tier?: MaiTier },
): ToolSet {
  const tier: MaiTier = opts?.tier ?? resolveTier();
  const out: ToolSet = { echo: echoTool };

  if (persistence) {
    Object.assign(out, makeMemoryTools(persistence.memoryDbPath));
    Object.assign(out, makeIdentityTools(persistence.identityPath));
    Object.assign(out, makeMethodologyTools({ identityPath: persistence.identityPath }));
  }
  if (session) {
    Object.assign(out, makeBrowserTools(session));
    Object.assign(out, makeLinkedinTools(session));
  }

  // P-6: operator-output + control tools. Registered when `control` is given.
  if (control) {
    const operatorOutputTools = makeOperatorOutputTools();
    if (tier === "power") Object.assign(out, operatorOutputTools);
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
        { includeSuggestionTools: true },
      ),
    );
  }
  Object.assign(out, makeWebTools());
  const salesDbPath = persistence?.salesDbPath ?? join(getHomeBase(), DATA_DIR_NAME, "agent", "sales.sqlite");
  Object.assign(out, makeSalesTools(salesDbPath, session));
  const schedulePath = persistence?.schedulePath ?? join(getHomeBase(), DATA_DIR_NAME, "agent", "schedule.jsonl");
  Object.assign(out, makeCronTools(schedulePath));

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
