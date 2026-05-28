import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CoreMessage, ToolExecutionOptions } from "ai";
import { writeSearchConfig } from "../../../src/persistence/search.js";
import { makeAllTools } from "../../../src/tools/index.js";
import { makeWebSearchTool } from "../../../src/tools/webTools/webSearch.js";

const FAKE_OPTS: ToolExecutionOptions = { toolCallId: "p71-web-search", messages: [] as CoreMessage[] };
const SEARCH_ENV_KEYS = ["HOME", "MAI_HOME_BASE", "MCP_SEARCH_URL", "BRAVE_API_KEY", "TAVILY_API_KEY"] as const;
type SearchEnvKey = (typeof SEARCH_ENV_KEYS)[number];

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
  const home = mkdtempSync(join(tmpdir(), "mai-p71-search-"));
  const saved = saveEnv();
  process.env.HOME = home;
  process.env.MAI_HOME_BASE = home;
  delete process.env.MCP_SEARCH_URL;
  delete process.env.BRAVE_API_KEY;
  delete process.env.TAVILY_API_KEY;
  try {
    await fn();
  } finally {
    restoreEnv(saved);
    rmSync(home, { recursive: true, force: true });
  }
}

async function withFetchSpy(
  fn: (calls: string[]) => Promise<void>,
  responseFactory: (url: string) => Response = () =>
    new Response(JSON.stringify({ web: { results: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const value = url.toString();
    calls.push(value);
    return responseFactory(value);
  }) as typeof globalThis.fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("P-71 web_search scope consolidation", () => {
  it("T-P71.Search.1: MCP_SEARCH_URL unset returns scope_disabled and never fetches despite Brave/Tavily keys", async () => {
    await withIsolatedSearchHome(async () => {
      // Given: MCP_SEARCH_URL is unset while env and persisted Brave/Tavily keys exist.
      // When: web_search.execute({query,maxResults}) runs.
      // Then: it returns scope_disabled and performs zero HTTP fetches.
      process.env.BRAVE_API_KEY = "bsa-env";
      process.env.TAVILY_API_KEY = "tvly-env";
      writeSearchConfig({ braveApiKey: "bsa-file", tavilyApiKey: "tvly-file" });

      await withFetchSpy(async (calls) => {
        const tool = makeWebSearchTool();
        const result = (await tool.execute?.({ query: "provider scope", maxResults: 3 }, FAKE_OPTS)) as {
          ok: boolean;
          error: { kind: string };
        };

        assert.equal(result.ok, false);
        assert.equal(result.error.kind, "scope_disabled");
        assert.equal(calls.length, 0, `web_search must not fetch when scope-disabled; calls=${calls.join(", ")}`);
      });
    });
  });

  it("T-P71.Search.2: MCP_SEARCH_URL set still never calls Brave/Tavily direct APIs", async () => {
    await withIsolatedSearchHome(async () => {
      // Given: MCP_SEARCH_URL, Brave/Tavily env keys, and persisted search keys all exist.
      // When: web_search.execute({query,maxResults}) runs.
      // Then: it still returns scope_disabled and calls no Brave/Tavily direct endpoint.
      process.env.MCP_SEARCH_URL = "https://mcp.example/search";
      process.env.BRAVE_API_KEY = "bsa-env";
      process.env.TAVILY_API_KEY = "tvly-env";
      writeSearchConfig({ braveApiKey: "bsa-file", tavilyApiKey: "tvly-file" });

      await withFetchSpy(async (calls) => {
        const tool = makeWebSearchTool();
        const result = (await tool.execute?.({ query: "provider scope", maxResults: 3 }, FAKE_OPTS)) as {
          ok: boolean;
          error: { kind: string; message: string };
        };

        assert.equal(result.ok, false);
        assert.equal(result.error.kind, "scope_disabled");
        assert.equal(calls.length, 0, `web_search must not fetch any direct provider; calls=${calls.join(", ")}`);
        assert.ok(
          calls.every((url) => !url.includes("api.search.brave.com") && !url.includes("api.tavily.com")),
          `direct Brave/Tavily URLs are forbidden; calls=${calls.join(", ")}`,
        );
      });
    });
  });

  it("T-P71.Search.3: web_search keeps its name and input schema", () => {
    // Given: makeWebSearchTool() and makeAllTools().
    // When: the tool metadata and parameter schema are inspected.
    // Then: web_search is still exported and accepts only query/maxResults as the public input fields.
    const allTools = makeAllTools();
    assert.ok("web_search" in allTools, "makeAllTools must still export web_search");

    const tool = makeWebSearchTool() as {
      parameters: { safeParse: (input: unknown) => { success: boolean; data?: unknown } };
    };
    const valid = tool.parameters.safeParse({ query: "provider scope", maxResults: 2 });
    assert.equal(valid.success, true, "query/maxResults must remain valid web_search params");
    assert.deepEqual(Object.keys(valid.data as Record<string, unknown>).sort(), ["maxResults", "query"]);

    const invalid = tool.parameters.safeParse({ maxResults: 2 });
    assert.equal(invalid.success, false, "query remains required");
  });

  it("T-P71.Search.4: legacy search secrets do not activate product search", async () => {
    await withIsolatedSearchHome(async () => {
      // Given: secrets.json.search contains legacy Brave/Tavily keys, with no direct search env keys.
      // When: web_search runs with and without MCP_SEARCH_URL.
      // Then: direct search remains disabled and no key is sent to any HTTP endpoint.
      writeSearchConfig({ braveApiKey: "bsa-file", tavilyApiKey: "tvly-file" });

      for (const mcpUrl of [undefined, "https://mcp.example/search"]) {
        if (mcpUrl === undefined) delete process.env.MCP_SEARCH_URL;
        else process.env.MCP_SEARCH_URL = mcpUrl;

        await withFetchSpy(async (calls) => {
          const tool = makeWebSearchTool();
          const result = (await tool.execute?.({ query: "legacy search", maxResults: 2 }, FAKE_OPTS)) as {
            ok: boolean;
            error: { kind: string };
          };

          assert.equal(result.ok, false, `legacy search keys must not activate product search for MCP=${mcpUrl}`);
          assert.equal(result.error.kind, "scope_disabled");
          assert.equal(calls.length, 0, `legacy search keys must not be sent to HTTP endpoints; calls=${calls}`);
        });
      }
    });
  });

  // ─── Edge case added at Step 5 ─────────────────────────────────────────────

  it("T-P71.Search.EC1: empty string MCP_SEARCH_URL ('') is treated as unset — returns scope_disabled, zero fetch", async () => {
    // Given: MCP_SEARCH_URL set to empty string ""
    // When: web_search runs
    // Then: scope_disabled (empty string = unset); zero fetch calls
    await withFetchSpy(async (calls) => {
      const saved = process.env.MCP_SEARCH_URL;
      process.env.MCP_SEARCH_URL = "";
      try {
        const tool = makeWebSearchTool();
        const result = (await tool.execute?.({ query: "empty mcp", maxResults: 3 }, FAKE_OPTS)) as {
          ok: boolean;
          error: { kind: string };
        };
        assert.equal(result.ok, false, "T-P71.Search.EC1: empty MCP_SEARCH_URL must return scope_disabled");
        assert.equal(result.error.kind, "scope_disabled");
        assert.equal(calls.length, 0, "T-P71.Search.EC1: zero fetch calls with empty MCP_SEARCH_URL");
      } finally {
        if (saved === undefined) delete process.env.MCP_SEARCH_URL;
        else process.env.MCP_SEARCH_URL = saved;
      }
    });
  });
});
