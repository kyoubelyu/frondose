import type { ToolSet } from "ai";
import type { LinkedinSession } from "../../linkedin/types.js";
import { makeClearCookiesTool } from "./clearCookies.js";
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
 *  11 tools. Bound to a session for ref/state sharing. (`launch` stays in the
 *  linkedin/ group — it is LinkedIn-destination-specific.) */
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
    clear_cookies: makeClearCookiesTool(session),
  };
}
