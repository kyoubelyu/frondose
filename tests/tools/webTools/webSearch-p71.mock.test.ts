import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { before, beforeEach, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { CoreMessage, ToolExecutionOptions } from "ai";
import { writeSearchConfig } from "../../../src/persistence/search.js";
import { cleanupTmpDir } from "../../_helpers/tmp";

const FAKE_OPTS: ToolExecutionOptions = {
  toolCallId: "pbrave-web-search",
  messages: [] as CoreMessage[],
  abortSignal: new AbortController().signal,
};
const SEARCH_ENV_KEYS = ["HOME", "FRONDOSE_HOME_BASE", "MCP_SEARCH_URL", "BRAVE_API_KEY", "TAVILY_API_KEY"] as const;
type SearchEnvKey = (typeof SEARCH_ENV_KEYS)[number];
type WebSearchTool = {
  description?: string;
  parameters: { safeParse: (input: unknown) => { success: boolean; data?: unknown } };
  execute?: (input: unknown, options: ToolExecutionOptions) => Promise<unknown>;
};

let makeWebSearchTool: (() => WebSearchTool) | undefined;
let makeAllTools: (() => Record<string, unknown>) | undefined;
const mcpCalls: Array<{ apiKey: string; query: string; maxResults: number; abortSignal?: AbortSignal }> = [];
let callBraveWebSearchImpl = async (input: {
  apiKey: string;
  query: string;
  maxResults: number;
  abortSignal?: AbortSignal;
}) => {
  mcpCalls.push(input);
  return {
    ok: true,
    command: "web_search",
    data: { query: input.query, results: [{ title: "Result", url: "https://example.com", description: "Desc" }] },
  };
};

before(async () => {
  const mcpSource = resolve(process.cwd(), "src/mcp/braveSearchClient.ts");
  if (existsSync(mcpSource)) {
    mock.module(pathToFileURL(resolve(process.cwd(), "src/mcp/braveSearchClient.js")).href, {
      namedExports: {
        callBraveWebSearch: (input: { apiKey: string; query: string; maxResults: number; abortSignal?: AbortSignal }) =>
          callBraveWebSearchImpl(input),
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

beforeEach(() => {
  mcpCalls.length = 0;
  callBraveWebSearchImpl = async (input) => {
    mcpCalls.push(input);
    return {
      ok: true,
      command: "web_search",
      data: { query: input.query, results: [{ title: "Result", url: "https://example.com", description: "Desc" }] },
    };
  };
});

function saveEnv(): Record<SearchEnvKey, string | undefined> {
  const saved = {} as Record<SearchEnvKey, string | undefined>;
  for (const key of SEARCH_ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<SearchEnvKey, string | undefined>): void {
  for (const key of SEARCH_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withIsolatedSearchHome(fn: () => Promise<void>): Promise<void> {
  const home = mkdtempSync(resolve(tmpdir(), "mai-pbrave-search-"));
  const saved = saveEnv();
  process.env.HOME = home;
  process.env.FRONDOSE_HOME_BASE = home;
  delete process.env.MCP_SEARCH_URL;
  delete process.env.BRAVE_API_KEY;
  delete process.env.TAVILY_API_KEY;
  try {
    await fn();
  } finally {
    restoreEnv(saved);
    cleanupTmpDir(home);
  }
}

async function withFetchTrap(fn: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  let fetchCallCount = 0;
  globalThis.fetch = (async () => {
    fetchCallCount++;
    throw new Error("web_search must not call globalThis.fetch directly");
  }) as typeof globalThis.fetch;
  try {
    await fn();
    assert.equal(fetchCallCount, 0, "web_search must route through Brave MCP, not globalThis.fetch");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function executeSearch(input: { query: string; maxResults?: number }): Promise<unknown> {
  assert.ok(makeWebSearchTool, "makeWebSearchTool must import");
  const tool = makeWebSearchTool();
  assert.equal(typeof tool.execute, "function", "web_search must expose execute()");
  return tool.execute?.(input, FAKE_OPTS);
}

describe("P-BRAVE-MCP web_search configuration and backend routing", () => {
  it("T-PBrave.Search.1: missing Brave key returns missing_config and does not construct MCP", async () => {
    await withIsolatedSearchHome(() =>
      withFetchTrap(async () => {
        // Given: no persisted Brave key and no BRAVE_API_KEY fallback.
        // When: web_search executes.
        // Then: it returns missing_config and never calls the MCP client.
        const result = (await executeSearch({ query: "provider scope", maxResults: 3 })) as {
          ok: boolean;
          error: { kind: string; message: string };
        };

        assert.equal(result.ok, false);
        assert.equal(result.error.kind, "missing_config");
        assert.match(result.error.message, /Brave Search MCP|Brave Search API key|Settings/i);
        assert.equal(mcpCalls.length, 0, "MCP client must not be constructed without an effective Brave key");
      }),
    );
  });

  it("T-PBrave.Search.2: persisted search.braveApiKey wins over BRAVE_API_KEY and calls Brave MCP", async () => {
    await withIsolatedSearchHome(() =>
      withFetchTrap(async () => {
        // Given: both persisted and env Brave keys exist, plus inert legacy search vars.
        // When: web_search executes.
        // Then: the persisted key is the effective key and direct search env vars do not steer routing.
        writeSearchConfig({ braveApiKey: "persisted-brave-key", tavilyApiKey: "persisted-tavily-key" });
        process.env.BRAVE_API_KEY = "env-brave-key";
        process.env.TAVILY_API_KEY = "env-tavily-key";
        process.env.MCP_SEARCH_URL = "https://legacy-mcp.example/search";

        const result = (await executeSearch({ query: "frondose market", maxResults: 4 })) as {
          ok: boolean;
          data: { results: unknown[] };
        };

        assert.equal(result.ok, true);
        assert.equal(mcpCalls.length, 1);
        assert.equal(mcpCalls[0].apiKey, "persisted-brave-key");
        assert.equal(mcpCalls[0].query, "frondose market");
        assert.equal(mcpCalls[0].maxResults, 4);
        assert.equal(mcpCalls[0].abortSignal, FAKE_OPTS.abortSignal);
        assert.ok(Array.isArray(result.data.results), "success envelope must surface data.results");
      }),
    );
  });

  it("T-PBrave.Search.3: BRAVE_API_KEY is used only as a development fallback when no persisted key exists", async () => {
    await withIsolatedSearchHome(() =>
      withFetchTrap(async () => {
        // Given: no persisted Brave key and BRAVE_API_KEY is set.
        // When: web_search executes.
        // Then: the env key is used as a fallback MCP key.
        process.env.BRAVE_API_KEY = "env-only-brave-key";

        const result = (await executeSearch({ query: "fallback search", maxResults: 2 })) as { ok: boolean };

        assert.equal(result.ok, true);
        assert.equal(mcpCalls.length, 1);
        assert.equal(mcpCalls[0].apiKey, "env-only-brave-key");
      }),
    );
  });

  it("T-PBrave.Search.4: MCP_SEARCH_URL and Tavily keys do not activate direct-provider search", async () => {
    await withIsolatedSearchHome(() =>
      withFetchTrap(async () => {
        // Given: legacy MCP_SEARCH_URL and Tavily keys exist, but no Brave key exists.
        // When: web_search executes.
        // Then: those values are ignored as active backends and the tool reports missing_config.
        process.env.MCP_SEARCH_URL = "https://legacy-mcp.example/search";
        process.env.TAVILY_API_KEY = "env-tavily-key";
        writeSearchConfig({ tavilyApiKey: "persisted-tavily-key" });

        const result = (await executeSearch({ query: "tavily ignored", maxResults: 2 })) as {
          ok: boolean;
          error: { kind: string };
        };

        assert.equal(result.ok, false);
        assert.equal(result.error.kind, "missing_config");
        assert.equal(mcpCalls.length, 0, "Tavily/MCP_SEARCH_URL must not construct the Brave MCP client");
      }),
    );
  });

  it("T-PBrave.Search.5: MCP failure envelopes are sanitized before returning to the agent", async () => {
    await withIsolatedSearchHome(() =>
      withFetchTrap(async () => {
        // Given: the MCP client returns an unsanitized failure containing the effective key.
        // When: web_search returns the envelope.
        // Then: the effective key is absent from the returned JSON.
        writeSearchConfig({ braveApiKey: "persisted-secret-key" });
        callBraveWebSearchImpl = async (input) => {
          mcpCalls.push(input);
          return {
            ok: false,
            command: "web_search",
            error: { kind: "mcp_error", message: `upstream mentioned ${input.apiKey}` },
          };
        };

        const result = await executeSearch({ query: "sanitize failure", maxResults: 1 });

        assert.equal(mcpCalls.length, 1);
        assert.ok(!JSON.stringify(result).includes("persisted-secret-key"), "web_search must not leak the Brave key");
      }),
    );
  });
});

describe("P-BRAVE-MCP web_search public contract", () => {
  it("T-PBrave.Search.6: name and query/maxResults schema are preserved", () => {
    // Given: makeAllTools() and makeWebSearchTool().
    // When: tool metadata and parameters are inspected.
    // Then: web_search remains the registered tool and keeps the same public input shape/default.
    assert.ok(makeAllTools, "makeAllTools must import");
    assert.ok(makeWebSearchTool, "makeWebSearchTool must import");
    assert.ok("web_search" in makeAllTools(), "makeAllTools must still export web_search");

    const tool = makeWebSearchTool();
    const valid = tool.parameters.safeParse({ query: "provider scope", maxResults: 2 });
    assert.equal(valid.success, true, "query/maxResults must remain valid");
    assert.deepEqual(Object.keys(valid.data as Record<string, unknown>).sort(), ["maxResults", "query"]);

    const defaulted = tool.parameters.safeParse({ query: "provider scope" });
    assert.equal(defaulted.success, true, "maxResults remains optional with a default");
    assert.equal((defaulted.data as { maxResults: number }).maxResults, 5);

    const invalid = tool.parameters.safeParse({ maxResults: 2 });
    assert.equal(invalid.success, false, "query remains required");
    assert.match(String(tool.description ?? ""), /Brave Search MCP/i);
    assert.doesNotMatch(String(tool.description ?? ""), /Tavily|api\.search\.brave\.com|scope-disabled during P-71/i);
  });
});
