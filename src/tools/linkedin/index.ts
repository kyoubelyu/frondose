import type { ToolSet } from "ai";
import type { LinkedinSession } from "../../linkedin/types.js";
import { makeLaunchTool } from "./launch.js";

/** P-33: LinkedIn-domain tools. `launch` resolves LinkedIn named destinations
 *  (feed/network/…). Generic browser primitives stay in src/tools/browser/.
 *  [P-75 D-11 round 3] The `linkedin_connect` primitive was removed — its job
 *  (handle AX-tree lag after type → click Send) belonged in the generic click tool
 *  all along (mai-linkedin original pattern). click.ts now retries inspect/resolve
 *  when called by label until the target appears or ~3s elapses, so the agent can
 *  do plain click(Connect) → click(Add a note) → type(noteText) → click(Send) and
 *  each step survives the AX-debounce. Brand safety (no rewrite) lives in
 *  src/tools/browser/type.ts as a text-fidelity guard against the saved draft. */
export function makeLinkedinTools(session: LinkedinSession): ToolSet {
  return {
    launch: makeLaunchTool(session),
  };
}
