import type { Tool, ToolSet } from "ai";
import type { HookRunner } from "../../agent/hooks.js";
import { echoTool } from "./echo.js";
import { makeEscalateTool } from "./escalate.js";
import { presentSummaryTool } from "./presentSummary.js";
import { sleepTool } from "./sleep.js";
import type { ControlSignals } from "./stop.js";
import { makeStopTool } from "./stop.js";
import { suggestCardTool } from "./suggestCard.js";
import { suggestNextActionsTool } from "./suggestNextActions.js";
import { todoWriteTool } from "./todoWrite.js";

export { echoTool } from "./echo.js";
export { presentSummarySchema, presentSummaryTool } from "./presentSummary.js";
export type { ControlSignals } from "./stop.js";
export { todoWriteSchema, todoWriteTool } from "./todoWrite.js";

export interface ControlToolDeps {
  telegramTool: Tool;
  ghIssueTool: Tool;
}

/**
 * Build the control + escalate tools. Echo is always exported (P-1 invariant).
 * stop, sleep, escalate_for_capability ship in P-6 when control + deps are given.
 *
 * If `deps` is omitted, escalate_for_capability is NOT registered (it has no
 * tools to compose). stop + sleep + echo still register.
 *
 * P-9 (D-12): optional `hookRunner` is forwarded to `makeStopTool` so the Stop
 * event hook fires inside the stop tool's execute, before the abort cascade.
 */
export function makeControlTools(
  control: ControlSignals | undefined,
  deps?: ControlToolDeps,
  hookRunner?: HookRunner,
): ToolSet {
  const out: ToolSet = {
    echo: echoTool,
    stop: makeStopTool(control, hookRunner),
    sleep: sleepTool,
    present_summary: presentSummaryTool,
    suggest_card: suggestCardTool,
    suggest_next_actions: suggestNextActionsTool,
    todo_write: todoWriteTool,
  };
  if (deps) {
    out.escalate_for_capability = makeEscalateTool({
      telegramTool: deps.telegramTool,
      ghIssueTool: deps.ghIssueTool,
      control,
    });
  }
  return out;
}
