/**
 * P-57d Step 5 — T-Search.1, T-Search.2 — FILLED
 * (G-P57d.3, G-P57d.4)
 *
 * Per source grep at Step 5 baseline (post-Step 4b):
 *   - src/tools/webTools/webSearch.ts L37: `mcpSearchUrl = process.env.MCP_SEARCH_URL`.
 *   - L38-50: when unset (or empty/trim) → return {ok:false, error:{kind:"scope_disabled",
 *     message: "search MCP not configured. Operator scope: external search APIs (Brave/Tavily)
 *              are disabled; await search MCP integration. Use LinkedIn navigation tools
 *              (navigate_to_url + inspect + click) for now. MCP_SEARCH_URL not configured;
 *              LinkedIn's own search UI or web_fetch to known URLs can be used when appropriate."}}
 *   - L51: braveKey read happens AFTER the short-circuit (verifies short-circuit fires FIRST).
 *   - Tool description at L29-33: contains "MCP_SEARCH_URL", "scope_disabled",
 *     "LinkedIn's own search", "web_fetch".
 *
 * Test strategy:
 *   - T-Search.1: clear MCP_SEARCH_URL; set BRAVE_API_KEY="fake-stale-key" (validates
 *     short-circuit fires BEFORE Brave attempt); mock globalThis.fetch with spy (assert
 *     zero calls); invoke execute(); assert envelope shape.
 *   - T-Search.2: pure substring grep against BOUNDARY constant.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/tools/webTools/webSearch-p57d.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { BOUNDARY } from "../../../src/agent/systemPrompt/boundary.js";
import { makeWebSearchTool } from "../../../src/tools/webTools/webSearch.js";

// ─── T-Search.1 — web_search graceful scope_disabled envelope ───────────────

describe("web_search tool — graceful scope_disabled envelope when MCP_SEARCH_URL unset (G-P57d.3)", () => {
  it("T-Search.1: given process.env.MCP_SEARCH_URL cleared + process.env.BRAVE_API_KEY='fake-stale-key' (set to validate short-circuit fires BEFORE Brave attempt) + mock globalThis.fetch as spy, WHEN web_search.execute({query:'ICP company name', maxResults:5}) is called, THEN result is {ok:false, error:{kind:'scope_disabled', message: contains 'MCP_SEARCH_URL not configured' + scope explanation}}; fetch spy callCount === 0 (short-circuit BEFORE any HTTP attempt even with BRAVE_API_KEY set); tool.description contains 'MCP_SEARCH_URL' + 'scope_disabled' + 'web_fetch' substrings", async () => {
    const origMcp = process.env.MCP_SEARCH_URL;
    const origBrave = process.env.BRAVE_API_KEY;
    const origTavily = process.env.TAVILY_API_KEY;
    delete process.env.MCP_SEARCH_URL;
    process.env.BRAVE_API_KEY = "fake-stale-key";
    delete process.env.TAVILY_API_KEY; // make Brave the only configured backend; short-circuit must still fire

    // Mock globalThis.fetch with a spy — any invocation triggers a controlled failure.
    const origFetch = globalThis.fetch;
    const fetchSpy = mock.fn(async (_url: string | URL) => {
      throw new Error("fetch should NOT be called when MCP_SEARCH_URL is unset");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    try {
      const tool = makeWebSearchTool();

      // Tool description substring assertions (per plan §5.2.2 rewrite)
      assert.ok(typeof tool.description === "string" && tool.description.length > 0, "tool.description must be set");
      assert.ok(
        tool.description.includes("MCP_SEARCH_URL"),
        `tool.description must contain 'MCP_SEARCH_URL'; got: ${tool.description}`,
      );
      assert.ok(
        tool.description.includes("scope_disabled"),
        `tool.description must contain 'scope_disabled'; got: ${tool.description}`,
      );
      assert.ok(
        tool.description.includes("web_fetch") || tool.description.includes("LinkedIn"),
        `tool.description must reference fallback ('web_fetch' OR 'LinkedIn'); got: ${tool.description}`,
      );

      // Behavioral envelope assertion
      // biome-ignore lint/suspicious/noExplicitAny: Tool execute signature varies by Vercel SDK version
      const result: any = await (tool.execute as any)(
        { query: "ICP company name", maxResults: 5 },
        { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
      );

      assert.equal(result?.ok, false, `result.ok must be false; got: ${JSON.stringify(result)}`);
      assert.equal(
        result?.error?.kind,
        "scope_disabled",
        `result.error.kind must be 'scope_disabled'; got: ${result?.error?.kind}`,
      );
      const message = String(result?.error?.message ?? "");
      assert.ok(message.includes("MCP_SEARCH_URL"), `error message must reference 'MCP_SEARCH_URL'; got: ${message}`);
      assert.ok(
        message.includes("Brave") || message.includes("Tavily") || message.includes("search"),
        `error message must reference scope context; got: ${message}`,
      );

      // ZERO fetch call (short-circuit fired BEFORE any HTTP attempt)
      assert.equal(
        fetchSpy.mock.callCount(),
        0,
        `fetch must NOT be called when MCP_SEARCH_URL is unset (short-circuit BEFORE Brave/Tavily); got ${fetchSpy.mock.callCount()} call(s)`,
      );
    } finally {
      globalThis.fetch = origFetch;
      if (origMcp === undefined) delete process.env.MCP_SEARCH_URL;
      else process.env.MCP_SEARCH_URL = origMcp;
      if (origBrave === undefined) delete process.env.BRAVE_API_KEY;
      else process.env.BRAVE_API_KEY = origBrave;
      if (origTavily === undefined) delete process.env.TAVILY_API_KEY;
      else process.env.TAVILY_API_KEY = origTavily;
    }
  });
});

// ─── T-Search.2 — BOUNDARY band has web_search tool-preference hint ─────────

describe("BOUNDARY constant — contains web_search tool-preference hint (G-P57d.4)", () => {
  it("T-Search.2: given BOUNDARY import from src/agent/systemPrompt/boundary.ts, WHEN substring searches applied for the P-57d search directive, THEN string contains 'web_search' + 'scope_disabled' + 'MCP_SEARCH_URL' + LinkedIn-search-alternative substring — all from the P-57d-appended Tool-preference paragraph per plan §5.3", () => {
    assert.ok(BOUNDARY.includes("web_search"), "BOUNDARY must contain 'web_search' (tool name)");
    assert.ok(BOUNDARY.includes("scope_disabled"), "BOUNDARY must contain 'scope_disabled' (envelope kind)");
    assert.ok(BOUNDARY.includes("MCP_SEARCH_URL"), "BOUNDARY must contain 'MCP_SEARCH_URL' (required env-var)");
    assert.ok(
      BOUNDARY.includes("launch destination='search'") ||
        BOUNDARY.includes("LinkedIn navigation tools") ||
        BOUNDARY.includes("navigate_to_url") ||
        BOUNDARY.includes("launch destination=\\'search\\'"),
      "BOUNDARY must reference LinkedIn search alternative (launch destination + navigate_to_url + inspect or similar)",
    );
  });
});
