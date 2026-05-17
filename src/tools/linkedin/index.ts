import type { ToolSet } from "ai";
import type { LinkedinSession } from "../../linkedin/types.js";
import { makeLaunchTool } from "./launch.js";

/** P-33: LinkedIn-domain tools. `launch` resolves LinkedIn named destinations
 *  (feed/network/…) — the only LinkedIn-specific primitive. Generic browser
 *  primitives moved to src/tools/browser/ (makeBrowserTools). */
export function makeLinkedinTools(session: LinkedinSession): ToolSet {
  return {
    launch: makeLaunchTool(session),
  };
}
