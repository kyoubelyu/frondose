import type { ToolSet } from "ai";
import { makeAnalyzeScreenshotTool } from "./analyzeScreenshot.js";
import { makeWebFetchTool } from "./webFetch.js";
import { makeWebSearchTool } from "./webSearch.js";

/**
 * P-9 F-3 / F-4: web tool set. No deps (each tool reads its own env at execute).
 * Always registered by makeAllTools regardless of session/persistence/control.
 */
export function makeWebTools(): ToolSet {
  return {
    web_fetch: makeWebFetchTool(),
    web_search: makeWebSearchTool(),
    analyze_screenshot: makeAnalyzeScreenshotTool(),
  };
}
