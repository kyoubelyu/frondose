import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import type { CoreMessage, ToolExecutionOptions } from "ai";
import { BOUNDARY } from "../../../src/agent/systemPrompt/boundary.js";
import { makeWebSearchTool } from "../../../src/tools/webTools/webSearch.js";

const FAKE_OPTS: ToolExecutionOptions = {
  toolCallId: "p57d-pbrave-search",
  messages: [] as CoreMessage[],
  abortSignal: new AbortController().signal,
};

async function withIsolatedHome(fn: () => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "mai-p57d-pbrave-"));
  const saved = {
    HOME: process.env.HOME,
    FRONDOSE_HOME_BASE: process.env.FRONDOSE_HOME_BASE,
    MCP_SEARCH_URL: process.env.MCP_SEARCH_URL,
    BRAVE_API_KEY: process.env.BRAVE_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  };
  process.env.HOME = home;
  process.env.FRONDOSE_HOME_BASE = home;
  delete process.env.MCP_SEARCH_URL;
  delete process.env.BRAVE_API_KEY;
  delete process.env.TAVILY_API_KEY;
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

describe("web_search tool — P-BRAVE-MCP missing-config fallback", () => {
  it("T-Search.1: no Brave key returns missing_config, mentions Settings, and does not call globalThis.fetch", async () => {
    await withIsolatedHome(async () => {
      // Given: no persisted Brave key and no BRAVE_API_KEY fallback, while legacy Tavily/MCP envs are absent.
      // When: web_search.execute runs.
      // Then: it returns missing_config and makes no direct same-process fetch call.
      const originalFetch = globalThis.fetch;
      const fetchSpy = mock.fn(async () => {
        throw new Error("web_search must not call globalThis.fetch directly");
      });
      globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
      try {
        const tool = makeWebSearchTool();
        assert.match(String(tool.description ?? ""), /Brave Search MCP/i);
        assert.doesNotMatch(String(tool.description ?? ""), /scope-disabled during P-71|MCP_SEARCH_URL/i);

        const result = (await tool.execute?.({ query: "ICP company name", maxResults: 5 }, FAKE_OPTS)) as {
          ok: boolean;
          error: { kind: string; message: string };
        };

        assert.equal(result.ok, false);
        assert.equal(result.error.kind, "missing_config");
        assert.match(result.error.message, /Brave Search MCP|Brave Search API key|Settings/i);
        assert.equal(fetchSpy.mock.callCount(), 0, "web_search must not call direct fetch when unconfigured");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe("BOUNDARY constant — web_search guidance after P-BRAVE-MCP", () => {
  it("T-Search.2: Boundary keeps injection defense, allows Brave MCP when configured, and falls back on missing_config", () => {
    // Given: BOUNDARY import from src/agent/systemPrompt/boundary.ts.
    // When: the search guidance is inspected.
    // Then: web_search is data-bearing, not unconditionally P-71-disabled, and fallback uses missing_config.
    assert.ok(BOUNDARY.includes("web_search"), "BOUNDARY must contain web_search in prompt-injection defense");
    assert.match(BOUNDARY, /Brave Search MCP/i);
    assert.match(BOUNDARY, /missing_config/i);
    assert.doesNotMatch(BOUNDARY, /web_search`? is scope-disabled during P-71/i);
    assert.doesNotMatch(BOUNDARY, /MCP-client work remains future|future MCP search client/i);
    assert.doesNotMatch(BOUNDARY, /api\.search\.brave\.com|api\.tavily\.com/i);
  });
});
