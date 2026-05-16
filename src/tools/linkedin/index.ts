import type { ToolSet } from "ai";
import type { LinkedinSession } from "../../linkedin/types.js";
import { makeClearCookiesTool } from "./clearCookies.js";
import { makeClickTool } from "./click.js";
import { makeCloseTool } from "./close.js";
import { makeInspectTool } from "./inspect.js";
import { makeLaunchTool } from "./launch.js";
import { makeNavigateToUrlTool } from "./navigateToUrl.js";
import { makePressTool } from "./press.js";
import { makeReloadTool } from "./reload.js";
import { makeScreenshotTool } from "./screenshot.js";
import { makeScrollTool } from "./scroll.js";
import { makeTypeTool } from "./type.js";
import { makeUploadTool } from "./upload.js";

/** P-3 LinkedIn tool inventory: 10 tools + P-28.5 navigate_to_url + clear_cookies = 12.
 *  Bound to a session for ref/state sharing. */
export function makeLinkedinTools(session: LinkedinSession): ToolSet {
  return {
    launch: makeLaunchTool(session),
    inspect: makeInspectTool(session),
    click: makeClickTool(session),
    type: makeTypeTool(session),
    press: makePressTool(session),
    upload: makeUploadTool(session),
    close: makeCloseTool(session),
    reload: makeReloadTool(session),
    scroll: makeScrollTool(session),
    screenshot: makeScreenshotTool(session),
    // P-28.5: general HTTPS navigation + pre-login cookie clear.
    navigate_to_url: makeNavigateToUrlTool(session),
    clear_cookies: makeClearCookiesTool(session),
  };
}
