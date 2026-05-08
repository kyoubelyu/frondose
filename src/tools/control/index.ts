import type { Tool, ToolSet } from "ai";
import { echoTool } from "./echo.js";
import { makeEscalateTool } from "./escalate.js";
import { sleepTool } from "./sleep.js";
import type { ControlSignals } from "./stop.js";
import { makeStopTool } from "./stop.js";

export { echoTool } from "./echo.js";
export type { ControlSignals } from "./stop.js";

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
 */
export function makeControlTools(control: ControlSignals | undefined, deps?: ControlToolDeps): ToolSet {
  const out: ToolSet = {
    echo: echoTool,
    stop: makeStopTool(control),
    sleep: sleepTool,
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
