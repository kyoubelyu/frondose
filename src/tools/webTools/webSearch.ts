import { tool } from "ai";
import { z } from "zod";

const webSearchParams = z.object({
  query: z.string().min(2).max(400).describe("Search query string."),
  maxResults: z.number().int().min(1).max(10).default(5).describe("Max results to return (1-10)."),
});

/**
 * P-71: web_search keeps its tool name/schema, but product scope disables direct
 * search providers. A later MCP-client phase must define the search protocol
 * before this tool can issue network requests.
 */
export function makeWebSearchTool() {
  return tool({
    description:
      "Search tool placeholder. P-71 keeps web_search scope-disabled until a future MCP search client phase; " +
      'it returns {ok:false, error:{kind:"scope_disabled"}} and never calls direct Brave/Tavily APIs. ' +
      "Use LinkedIn's own search UI (`launch destination='search'`) or `web_fetch` to known URLs.",
    parameters: webSearchParams,
    execute: async () => {
      return {
        ok: false,
        command: "web_search",
        error: {
          kind: "scope_disabled",
          message:
            "web_search is scope-disabled in P-71. Direct Brave/Tavily calls are disabled, and the MCP search client contract is future work. Use LinkedIn navigation tools or web_fetch to known URLs.",
        },
      };
    },
  });
}
