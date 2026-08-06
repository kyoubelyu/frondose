import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { CoreMessage, ToolExecutionOptions } from "ai";
import { writeSearchConfig } from "../../../src/persistence/search.js";
import { cleanupTmpDir } from "../../_helpers/tmp";

type WebSearchTool = {
  description?: string;
  parameters: { safeParse: (input: unknown) => { success: boolean; data?: unknown } };
  execute?: (input: unknown, options: ToolExecutionOptions) => Promise<unknown>;
};

const calls: Array<Record<string, unknown>> = [];
let searchMcpImpl = async (input: Record<string, unknown>): Promise<unknown> => ({
  ok: true,
  command: "web_search",
  data: {
    query: input.query,
    results: [{ title: "MCP", url: "https://example.test/mcp", description: "MCP result" }],
    raw: { entries: ["fixture"], truncated: false },
  },
});
let makeWebSearchTool: (() => WebSearchTool) | undefined;
let makeAllTools: (() => Record<string, unknown>) | undefined;
const opts: ToolExecutionOptions = {
  toolCallId: "mcp-search-scope",
  messages: [] as CoreMessage[],
  abortSignal: new AbortController().signal,
};

before(async () => {
  const newClient = resolve(process.cwd(), "src/mcp/searchMcpClient.ts");
  const oldClient = resolve(process.cwd(), "src/mcp/braveSearchClient.ts");
  if (existsSync(newClient)) {
    mock.module(pathToFileURL(resolve(process.cwd(), "src/mcp/searchMcpClient.js")).href, {
      namedExports: {
        callSearchMcp: async (input: Record<string, unknown>) => {
          calls.push(input);
          return searchMcpImpl(input);
        },
      },
    });
  } else if (existsSync(oldClient)) {
    mock.module(pathToFileURL(resolve(process.cwd(), "src/mcp/braveSearchClient.js")).href, {
      namedExports: {
        callBraveWebSearch: async (input: Record<string, unknown>) => {
          calls.push(input);
          return {
            ok: true,
            command: "web_search",
            data: { query: input.query, results: [] },
          };
        },
      },
    });
  }

  const webSearch = (await import("../../../src/tools/webTools/webSearch.js")) as {
    makeWebSearchTool: () => WebSearchTool;
  };
  makeWebSearchTool = webSearch.makeWebSearchTool;
  const tools = (await import("../../../src/tools/index.js")) as { makeAllTools: () => Record<string, unknown> };
  makeAllTools = tools.makeAllTools;
});

async function execute(input: { query: string; maxResults?: number }): Promise<unknown> {
  assert.ok(makeWebSearchTool);
  assert.equal(typeof makeWebSearchTool().execute, "function");
  return makeWebSearchTool().execute?.(input, opts);
}

async function isolatedHome(fn: () => Promise<void>): Promise<void> {
  const home = mkdtempSync(resolve(tmpdir(), "frondose-mcp-search-scope-"));
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
  process.env.BRAVE_API_KEY = "legacy-env-brave";
  process.env.TAVILY_API_KEY = "legacy-env-tavily";
  calls.length = 0;
  searchMcpImpl = async (input) => ({
    ok: true,
    command: "web_search",
    data: {
      query: input.query,
      results: [{ title: "MCP", url: "https://example.test/mcp", description: "MCP result" }],
      raw: { entries: ["fixture"], truncated: false },
    },
  });
  try {
    writeSearchConfig({ braveApiKey: "legacy-persisted-brave", tavilyApiKey: "legacy-persisted-tavily" });
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    cleanupTmpDir(home);
  }
}

describe("P-WEB-SEARCH-MCP-SCOPE tool routing", () => {
  // Given no MCP URL plus all legacy keys, when web_search executes, then exact scope_disabled returns with zero client calls.
  it("T-MCP-SCOPE.1: blank URL returns exact scope_disabled and ignores every legacy key", async () => {
    await isolatedHome(async () => {
      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls++;
        throw new Error("direct fetch is forbidden");
      }) as typeof globalThis.fetch;
      try {
        for (const value of [undefined, "   "]) {
          calls.length = 0;
          if (value === undefined) delete process.env.MCP_SEARCH_URL;
          else process.env.MCP_SEARCH_URL = value;
          const result = await execute({ query: "scope disabled", maxResults: 2 });
          assert.deepEqual(result, {
            ok: false,
            command: "web_search",
            error: {
              kind: "scope_disabled",
              message: "Web search is scope-disabled until MCP_SEARCH_URL configures an approved MCP server.",
            },
          });
          assert.deepEqual(calls, []);
        }
        assert.equal(fetchCalls, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // Given only an approved MCP URL, when web_search executes, then the remote client receives exact public args and signal.
  it("T-MCP-SCOPE.2b: configured URL is the only activation path and preserves public arguments", async () => {
    await isolatedHome(async () => {
      process.env.MCP_SEARCH_URL = " https://mcp.example.test/search ";
      const result = (await execute({ query: "configured", maxResults: 3 })) as { ok?: boolean };
      assert.equal(result.ok, true);
      assert.deepEqual(calls, [
        {
          serverUrl: "https://mcp.example.test/search",
          query: "configured",
          maxResults: 3,
          abortSignal: opts.abortSignal,
        },
      ]);
    });
  });

  // Given a configured client failure, when web_search returns it, then no direct fetch, legacy client, or silent fallback runs.
  it("T-MCP-SCOPE.2c: configured mcp_error is returned without fallback", async () => {
    await isolatedHome(async () => {
      process.env.MCP_SEARCH_URL = "https://mcp.example.test/search";
      searchMcpImpl = async () => ({
        ok: false,
        command: "web_search",
        error: { kind: "mcp_error", message: "configured MCP failed" },
      });
      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = (async () => {
        fetchCalls++;
        throw new Error("direct fetch is forbidden");
      }) as typeof globalThis.fetch;
      try {
        const result = (await execute({ query: "failure", maxResults: 1 })) as {
          ok?: boolean;
          error?: { kind?: string };
        };
        assert.equal(result.ok, false);
        assert.equal(result.error?.kind, "mcp_error");
        assert.equal(calls.length, 1);
        assert.equal(fetchCalls, 0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe("P-WEB-SEARCH-MCP-SCOPE public tool contract", () => {
  // Given registry and metadata, when inspected, then name/schema/default stay stable and guidance names only approved MCP.
  it("T-MCP-SCOPE.8: tool inventory/schema remain stable while guidance names only approved MCP", () => {
    assert.ok(makeAllTools);
    assert.ok(makeWebSearchTool);
    assert.ok("web_search" in makeAllTools());
    const tool = makeWebSearchTool();
    const parsed = tool.parameters.safeParse({ query: "contract" });
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.data, { query: "contract", maxResults: 5 });
    assert.equal(tool.parameters.safeParse({ query: "contract", maxResults: 10 }).success, true);
    assert.equal(tool.parameters.safeParse({ query: "contract", maxResults: 11 }).success, false);
    assert.equal(tool.parameters.safeParse({ query: "contract", maxResults: 1 }).success, true);
    assert.equal(tool.parameters.safeParse({ query: "contract", maxResults: 0 }).success, false);
    assert.equal(tool.parameters.safeParse({ query: "contract", maxResults: 1.5 }).success, false);
    assert.equal(tool.parameters.safeParse({ query: "contract", maxResults: "2" }).success, false);
    assert.equal(tool.parameters.safeParse({ maxResults: 2 }).success, false);
    assert.equal(tool.parameters.safeParse({ query: "x" }).success, false);
    assert.equal(tool.parameters.safeParse({ query: "xx" }).success, true);
    assert.equal(tool.parameters.safeParse({ query: "x".repeat(400) }).success, true);
    assert.equal(tool.parameters.safeParse({ query: "x".repeat(401) }).success, false);
    assert.equal(tool.parameters.safeParse({ query: 42 }).success, false);
    const extra = tool.parameters.safeParse({ query: "contract", extraProvider: "forbidden" });
    assert.equal(extra.success, true);
    assert.deepEqual(extra.data, { query: "contract", maxResults: 5 });
    assert.match(String(tool.description), /MCP_SEARCH_URL|configured MCP server/i);
    assert.doesNotMatch(String(tool.description), /Brave|Tavily/i);
  });
});
