import { tool } from "ai";
import { z } from "zod";
import { fail, failFromError, ok } from "../../linkedin/envelope.js";

const MAX_CHARS_DEFAULT = 8000;

const webFetchParams = z.object({
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), { message: "Only https:// URLs are allowed (D-15)." })
    .describe("HTTPS URL to fetch."),
  maxChars: z
    .number()
    .int()
    .min(100)
    .max(50_000)
    .default(MAX_CHARS_DEFAULT)
    .describe(
      `Max chars of response body to return (default ${MAX_CHARS_DEFAULT}). Truncated tail is replaced with '... [truncated]'.`,
    ),
  prompt: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Optional caller note echoed back in the result for downstream LLM-side context (e.g. 'extracting the latest blog title').",
    ),
});

/**
 * P-9 F-3: web_fetch tool. Direct globalThis.fetch; no npm dep (Node 24 includes
 * undici-based fetch; verified scout V-13). HTTPS-only per D-15. Truncation is
 * char-based (deterministic) — operator may pass lower maxChars to save context.
 */
export function makeWebFetchTool() {
  return tool({
    description:
      "Fetch the body of an HTTPS URL and return up to maxChars of text. " +
      "Use for reading public web pages (docs, blog posts, ICP company sites). " +
      "Does NOT execute JavaScript — server-rendered HTML only. " +
      "For LinkedIn pages use the existing CDP-backed launch/inspect tools instead.",
    parameters: webFetchParams,
    execute: async ({ url, maxChars, prompt }) => {
      try {
        const response = await globalThis.fetch(url, {
          method: "GET",
          redirect: "follow",
          headers: { "User-Agent": "frondose/1.0 (+https://github.com/kyoubelyu/frondose)" },
          // [P-AUTO-L3FIX-6] bound the fetch so a slow/hung page can't stall the agent
          // loop indefinitely (an unbounded fetch is an un-abortable-hang vector). The
          // throw lands in the existing catch → graceful runtime_error envelope.
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          return fail("web_fetch", "runtime_error", `HTTP ${response.status} ${response.statusText} for ${url}`);
        }
        const fullText = await response.text();
        const truncated = fullText.length > maxChars;
        const text = truncated
          ? `${fullText.slice(0, maxChars)}\n\n... [truncated; original ${fullText.length} chars]`
          : fullText;
        return ok("web_fetch", {
          url,
          status: response.status,
          contentType: response.headers.get("content-type") ?? "unknown",
          text,
          truncated,
          ...(prompt ? { prompt } : {}),
        });
      } catch (e) {
        return failFromError("web_fetch", e);
      }
    },
  });
}
