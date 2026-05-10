import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";

const webSearchParams = z.object({
  query: z.string().min(2).max(400).describe("Search query string."),
  maxResults: z.number().int().min(1).max(10).default(5).describe("Max results to return (1-10)."),
});

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * P-9 F-3 / D-5: web_search tool. Brave PRIMARY → Tavily FALLBACK chain.
 * Both providers via globalThis.fetch only (no npm dep). First-available wins:
 * - BRAVE_API_KEY set + Brave returns < 500: use Brave result (even on 4xx — surface
 *   operator key/quota issues directly).
 * - BRAVE_API_KEY unset OR Brave returns ≥ 500: fall through to Tavily.
 * - TAVILY_API_KEY set: use Tavily.
 * - Both unset: fail envelope.
 */
export function makeWebSearchTool() {
  return tool({
    description:
      "Search the web for the given query. Returns top results (title, url, snippet). " +
      "Provider chain: Brave (BRAVE_API_KEY) → Tavily (TAVILY_API_KEY) fallback. " +
      "Use for ICP/company/industry research outside LinkedIn.",
    parameters: webSearchParams,
    execute: async ({ query, maxResults }) => {
      const braveKey = process.env.BRAVE_API_KEY;
      const tavilyKey = process.env.TAVILY_API_KEY;
      if (!braveKey && !tavilyKey) {
        return fail(
          "web_search",
          "runtime_error",
          "Neither BRAVE_API_KEY nor TAVILY_API_KEY is set; web_search disabled.",
        );
      }
      if (braveKey) {
        try {
          const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
          const response = await globalThis.fetch(url, {
            headers: { "X-Subscription-Token": braveKey, Accept: "application/json" },
          });
          if (response.status >= 500) {
            // Fall through to Tavily on Brave 5xx (transient upstream).
          } else if (!response.ok) {
            return fail(
              "web_search",
              response.status === 401 ? "invalid_input" : "runtime_error",
              `Brave API HTTP ${response.status}`,
            );
          } else {
            const json = (await response.json()) as {
              web?: { results?: Array<{ title: string; url: string; description: string }> };
            };
            const results: SearchResult[] = (json.web?.results ?? []).slice(0, maxResults).map((r) => ({
              title: r.title,
              url: r.url,
              snippet: r.description,
            }));
            return ok("web_search", { provider: "brave", query, results });
          }
        } catch (e) {
          // Network error from Brave: fall through to Tavily if available.
          if (!tavilyKey) return failFromError("web_search", e);
        }
      }
      if (tavilyKey) {
        try {
          const response = await globalThis.fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: tavilyKey, query, max_results: maxResults }),
          });
          if (!response.ok) {
            return fail(
              "web_search",
              response.status === 401 ? "invalid_input" : "runtime_error",
              `Tavily API HTTP ${response.status}`,
            );
          }
          const json = (await response.json()) as {
            results?: Array<{ title: string; url: string; content: string }>;
          };
          const results: SearchResult[] = (json.results ?? []).slice(0, maxResults).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: r.content,
          }));
          return ok("web_search", { provider: "tavily", query, results });
        } catch (e) {
          return failFromError("web_search", e);
        }
      }
      return fail("web_search", "runtime_error", "web_search providers unreachable.");
    },
  });
}
