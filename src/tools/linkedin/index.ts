import type { ToolSet } from "ai";
import type { LinkedinSession } from "../../linkedin/types.js";
import { makeConnectTool } from "./connect.js";
import { makeLaunchTool } from "./launch.js";

/** P-33: LinkedIn-domain tools. `launch` resolves LinkedIn named destinations
 *  (feed/network/…). [P-75 D-11] `linkedin_connect` is the deterministic, atomic +
 *  idempotent + identity-guarded Connect-with-or-without-note primitive — it ends
 *  the 5-attempt L5 wall where the agent reached the invite dialog but reliably
 *  stopped before the final Send click. Generic browser primitives stay in
 *  src/tools/browser/ (makeBrowserTools). */
export function makeLinkedinTools(session: LinkedinSession): ToolSet {
  return {
    launch: makeLaunchTool(session),
    linkedin_connect: makeConnectTool(session),
  };
}
