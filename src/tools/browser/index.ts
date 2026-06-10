import type { ToolSet } from "ai";
import type { LinkedinSession } from "../../linkedin/types.js";
import { makeClickTool } from "./click.js";
import { makeCloseTool } from "./close.js";
import { makeInspectTool } from "./inspect.js";
import { makeNavigateToUrlTool } from "./navigateToUrl.js";
import { makePressTool } from "./press.js";
import { makeReloadTool } from "./reload.js";
import { makeScreenshotTool } from "./screenshot.js";
import { makeScrollTool } from "./scroll.js";
import { makeTypeTool } from "./type.js";
import { makeUploadTool } from "./upload.js";

/** P-33: generic browser primitives — work on any HTTPS page, not only LinkedIn.
 *  10 tools. Bound to a session for ref/state sharing. (`launch` stays in the
 *  linkedin/ group — it is LinkedIn-destination-specific.)
 *  NOTE: `clear_cookies` (P-28.5, `makeClearCookiesTool` in `./clearCookies.ts`)
 *  was removed from the LLM-visible worker set 2026-06-10 — the agent twice
 *  (audit 2026-06-05, 2026-06-10) used it as an authwall "self-help" move and
 *  destroyed the operator's own LinkedIn session. The tool code is retained for
 *  the deprecated server-guided Google-login fleet path but is no longer exposed
 *  to the agent. Operator-directed quick removal (option A). */
export function makeBrowserTools(session: LinkedinSession): ToolSet {
  return {
    inspect: makeInspectTool(session),
    click: makeClickTool(session),
    type: makeTypeTool(session),
    press: makePressTool(session),
    upload: makeUploadTool(session),
    close: makeCloseTool(session),
    reload: makeReloadTool(session),
    scroll: makeScrollTool(session),
    screenshot: makeScreenshotTool(session),
    navigate_to_url: makeNavigateToUrlTool(session),
  };
}
