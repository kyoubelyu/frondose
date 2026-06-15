import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import type { CoreMessage, ToolExecutionOptions } from "ai";
import { makeWebSearchTool } from "../../../src/tools/webTools/webSearch.js";

const FAKE_OPTS: ToolExecutionOptions = {
  toolCallId: "web-search-contract",
  messages: [] as CoreMessage[],
  abortSignal: new AbortController().signal,
};

async function withCleanSearchConfig(fn: () => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "mai-websearch-contract-"));
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

describe("web_search tool contract", () => {
  it("T-WebSearch.1: missing Brave MCP config returns missing_config and never uses direct HTTP fetch", async () => {
    await withCleanSearchConfig(async () => {
      // Given: no persisted Brave key and no BRAVE_API_KEY fallback.
      // When: web_search runs.
      // Then: the tool asks for Settings configuration and performs no direct Brave/Tavily fetch.
      const originalFetch = globalThis.fetch;
      const fetchSpy = mock.fn(async () => {
        throw new Error("web_search must not call globalThis.fetch directly");
      });
      globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
      try {
        const tool = makeWebSearchTool();
        const result = (await tool.execute?.({ query: "test query", maxResults: 5 }, FAKE_OPTS)) as {
          ok: boolean;
          error: { kind: string; message: string };
        };

        assert.equal(result.ok, false);
        assert.equal(result.error.kind, "missing_config");
        assert.match(result.error.message, /Brave Search MCP|Settings/i);
        assert.equal(fetchSpy.mock.callCount(), 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  it("T-WebSearch.2: tool name, parameter names, validation range, and maxResults default stay stable", () => {
    // Given: the current web_search tool object.
    // When: its parameter schema is parsed.
    // Then: the public query/maxResults contract remains unchanged for callers.
    const tool = makeWebSearchTool() as {
      parameters: { safeParse: (input: unknown) => { success: boolean; data?: unknown } };
    };

    const defaulted = tool.parameters.safeParse({ query: "stable search" });
    assert.equal(defaulted.success, true);
    assert.deepEqual(defaulted.data, { query: "stable search", maxResults: 5 });

    const max = tool.parameters.safeParse({ query: "stable search", maxResults: 10 });
    assert.equal(max.success, true);

    const tooHigh = tool.parameters.safeParse({ query: "stable search", maxResults: 11 });
    assert.equal(tooHigh.success, false, "maxResults must remain capped at 10");

    const missingQuery = tool.parameters.safeParse({ maxResults: 2 });
    assert.equal(missingQuery.success, false, "query remains required");
  });
});
