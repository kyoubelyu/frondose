import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { before, beforeEach, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { CoreMessage, ToolExecutionOptions } from "ai";
import { readSearchConfig, writeSearchConfig, DEFAULT_SEARCH_CONFIG_PATH } from "../../../src/persistence/search.js";
import { cleanupTmpDir } from "../../_helpers/tmp";

type WebSearchTool = {
  description?: string;
  parameters: { safeParse: (input: unknown) => { success: boolean; data?: unknown } };
  execute?: (input: unknown, options: ToolExecutionOptions) => Promise<unknown>;
};

const RAW_BRAVE_KEY = "bsa_live_scaffold_tool_key_456";
const ENV_BRAVE_KEY = "bsa_live_scaffold_env_key_789";

const calls: Array<Record<string, unknown>> = [];
let braveImpl = async (input: Record<string, unknown>): Promise<unknown> => ({
  ok: true,
  command: "web_search",
  data: {
    query: input.query,
    results: [{ title: "Brave", url: "https://example.test/brave", description: "Brave result" }],
    raw: { entries: ["fixture"], truncated: false },
  },
});
let makeWebSearchTool: (() => WebSearchTool) | undefined;
let makeAllTools: (() => Record<string, unknown>) | undefined;
const opts: ToolExecutionOptions = {
  toolCallId: "p-ext-search",
  messages: [] as CoreMessage[],
  abortSignal: new AbortController().signal,
};

before(async () => {
  const client = resolve(process.cwd(), "src/search/braveSearchClient.ts");
  assert.ok(existsSync(client), "src/search/braveSearchClient.ts must exist (P-EXT-SEARCH)");
  mock.module(pathToFileURL(resolve(process.cwd(), "src/search/braveSearchClient.js")).href, {
    namedExports: {
      callBraveWebSearch: async (input: Record<string, unknown>) => {
        calls.push(input);
        return braveImpl(input);
      },
      resetBraveSearchLimiterForTest: () => {},
    },
  });

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

async function isolatedHome(fn: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(resolve(tmpdir(), "frondose-p-ext-search-"));
  const saved = {
    HOME: process.env.HOME,
    FRONDOSE_HOME_BASE: process.env.FRONDOSE_HOME_BASE,
    BRAVE_API_KEY: process.env.BRAVE_API_KEY,
  };
  process.env.HOME = home;
  process.env.FRONDOSE_HOME_BASE = home;
  delete process.env.BRAVE_API_KEY;
  try {
    await fn(home);
  } finally {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.FRONDOSE_HOME_BASE === undefined) delete process.env.FRONDOSE_HOME_BASE;
    else process.env.FRONDOSE_HOME_BASE = saved.FRONDOSE_HOME_BASE;
    if (saved.BRAVE_API_KEY === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = saved.BRAVE_API_KEY;
    cleanupTmpDir(home);
  }
}

describe("P-EXT-SEARCH web_search tool — key resolution and routing", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("T-Search.Key.1: persisted braveApiKey wins over the BRAVE_API_KEY env fallback", async () => {
    // Given: a persisted key (at the production .frondose/agent path under the isolated home) and a different env key.
    await isolatedHome(async () => {
      writeSearchConfig({ braveApiKey: RAW_BRAVE_KEY }, DEFAULT_SEARCH_CONFIG_PATH());
      process.env.BRAVE_API_KEY = ENV_BRAVE_KEY;
      // When: the tool executes.
      const result = (await execute({ query: "openai", maxResults: 3 })) as { ok: boolean };
      // Then: the client receives the persisted key and returns ok:true.
      assert.equal(result.ok, true);
      assert.equal(calls.length, 1);
      assert.equal((calls[0] as { apiKey?: string }).apiKey, RAW_BRAVE_KEY);
      assert.equal(readSearchConfig().braveApiKey, RAW_BRAVE_KEY);
    });
  });

  it("T-Search.Key.2: without a persisted key, the env fallback key is used", async () => {
    // Given: no persisted key and BRAVE_API_KEY set in an isolated home.
    await isolatedHome(async () => {
      process.env.BRAVE_API_KEY = ENV_BRAVE_KEY;
      // When: the tool executes.
      const result = (await execute({ query: "openai" })) as { ok: boolean };
      // Then: the client receives the env key.
      assert.equal(result.ok, true);
      assert.equal(calls.length, 1);
      assert.equal((calls[0] as { apiKey?: string }).apiKey, ENV_BRAVE_KEY);
    });
  });

  it("T-Search.Key.3: with neither key, returns missing_config and performs zero client calls", async () => {
    // Given: no key anywhere in an isolated home.
    await isolatedHome(async () => {
      // When: the tool executes.
      const result = (await execute({ query: "openai" })) as {
        ok: boolean;
        error?: { kind: string; message: string };
      };
      // Then: missing_config with an actionable message and no client call.
      assert.equal(result.ok, false);
      assert.equal(result.error?.kind, "missing_config");
      assert.match(result.error?.message ?? "", /Brave/i);
      assert.equal(calls.length, 0);
    });
  });

  it("T-Search.Key.4: the tool description names the Brave Search API and carries no MCP wording", async () => {
    // Given: the built tool.
    assert.ok(makeWebSearchTool);
    const description = makeWebSearchTool().description ?? "";
    // Then: it describes Brave Search API and does not mention MCP_SEARCH_URL or an operator-configured MCP server.
    assert.match(description, /Brave Search API/i);
    assert.doesNotMatch(description, /MCP_SEARCH_URL|operator-configured MCP server|mcp_error/i);
  });

  it("T-Search.Tool.1: web_search stays registered with the unchanged {query, maxResults} schema", async () => {
    // Given: the full tool registry.
    assert.ok(makeAllTools);
    const tools = makeAllTools();
    // Then: web_search is present with the unchanged schema and the envelope passes through.
    assert.ok("web_search" in tools);
    const tool = tools.web_search as WebSearchTool;
    const parsed = tool.parameters.safeParse({ query: "openai", maxResults: 10 });
    assert.equal(parsed.success, true);
    const parsedBad = tool.parameters.safeParse({ query: "x", maxResults: 11 });
    assert.equal(parsedBad.success, false);
    const result = (await execute({ query: "openai", maxResults: 5 })) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal((calls[0] as { maxResults?: number }).maxResults, 5);
  });
});
