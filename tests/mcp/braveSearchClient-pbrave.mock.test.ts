import assert from "node:assert/strict";
import { dirname, isAbsolute, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

type BraveMcpModule = {
  BRAVE_MCP_RAW_ENTRY_LIMIT?: number;
  BRAVE_MCP_RAW_TEXT_LIMIT?: number;
  buildBraveMcpServerParameters?: (apiKey: string, importMetaUrl?: string) => {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    shell?: boolean;
    stderr?: unknown;
  };
  callBraveWebSearch?: (input: Record<string, unknown>, deps?: Record<string, unknown>) => Promise<unknown>;
  closeBraveSearchMcpSessionForTest?: () => Promise<void> | void;
};

const BRAVE_KEY = "bsa_test_effective_key_123456";
const CLIENT_MODULE = "../../src/mcp/braveSearchClient.js";

async function loadClient(): Promise<BraveMcpModule> {
  try {
    return (await import(CLIENT_MODULE)) as BraveMcpModule;
  } catch {
    return {};
  }
}

function assertClientModule(mod: BraveMcpModule): asserts mod is Required<BraveMcpModule> {
  assert.equal(typeof mod.buildBraveMcpServerParameters, "function", "Builder must add buildBraveMcpServerParameters()");
  assert.equal(typeof mod.callBraveWebSearch, "function", "Builder must add callBraveWebSearch()");
  assert.equal(
    typeof mod.closeBraveSearchMcpSessionForTest,
    "function",
    "Builder must add closeBraveSearchMcpSessionForTest()",
  );
}

afterEach(async () => {
  const mod = await loadClient();
  await mod.closeBraveSearchMcpSessionForTest?.();
});

function makeDeps(options: {
  callTool?: (request: unknown) => Promise<unknown>;
  connect?: () => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  events?: string[];
}) {
  const events = options.events ?? [];
  let clientId = 0;
  const clients: Array<{ id: number; closeCount: number }> = [];
  return {
    events,
    clients,
    createClient: () => {
      const id = ++clientId;
      clients.push({ id, closeCount: 0 });
      events.push(`client:${id}:create`);
      return {
        connect: async () => {
          events.push(`client:${id}:connect`);
          await options.connect?.();
        },
        callTool: async (request: unknown) => {
          events.push(`client:${id}:call`);
          return options.callTool?.(request) ?? { content: [{ type: "text", text: "{\"web\":{\"results\":[]}}" }] };
        },
        close: async () => {
          events.push(`client:${id}:close`);
          clients[id - 1].closeCount++;
        },
      };
    },
    createTransport: (params: unknown) => {
      events.push(`transport:create:${JSON.stringify(params)}`);
      return {
        close: async () => {
          events.push("transport:close");
        },
      };
    },
    now: options.now ?? (() => 0),
    sleep: options.sleep ?? (async () => {}),
  };
}

describe("P-BRAVE-MCP client launch contract", () => {
  it("T-BraveMcp.Launch.1: builds an app-local stdio launch with process.execPath, no shell/bin/npx/key argv, and safe cwd", async () => {
    const mod = await loadClient();
    assertClientModule(mod);

    // Given: a fake Brave key and the source import URL.
    // When: server parameters are built.
    // Then: the child launches app-local Brave MCP over stdio without shell/PATH/bin/key argv, and cwd cannot load repo .env.
    const params = mod.buildBraveMcpServerParameters(BRAVE_KEY);
    const args = params.args ?? [];
    const script = args[0] ?? "";

    assert.equal(params.command, process.execPath);
    assert.ok(isAbsolute(script), `server script must be absolute; got ${script}`);
    assert.match(script.replace(/\\/g, "/"), /node_modules\/@brave\/brave-search-mcp-server\/dist\/index\.js$/);
    assert.deepEqual(args.slice(1), [
      "--transport",
      "stdio",
      "--enabled-tools",
      "brave_web_search",
      "--logging-level",
      "error",
    ]);
    assert.notEqual(params.shell, true, "stdio transport must not request a shell");
    assert.ok(!args.some((arg) => arg.includes(BRAVE_KEY)), "API key must never be passed in argv");
    assert.ok(!args.some((arg) => /\bnpx\b|brave-search-mcp-server$/.test(arg)), "must not rely on npx/package bin");
    assert.ok(params.cwd, "safe child cwd must be supplied because Brave loads dotenv on startup");
    assert.ok(isAbsolute(params.cwd), `cwd must be absolute; got ${params.cwd}`);
    assert.equal(resolve(params.cwd), dirname(script), "cwd should be the app-local Brave server script directory");
    assert.notEqual(resolve(params.cwd), process.cwd(), "cwd must not be the repo root, where .env may exist");
  });

  it("T-BraveMcp.Launch.2: supplies only Brave MCP env keys, excluding provider/search secrets from process.env", async () => {
    const mod = await loadClient();
    assertClientModule(mod);
    const saved = {
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      TAVILY_API_KEY: process.env.TAVILY_API_KEY,
      RANDOM_OPERATOR_SECRET: process.env.RANDOM_OPERATOR_SECRET,
    };
    process.env.DEEPSEEK_API_KEY = "deepseek-secret";
    process.env.OPENAI_API_KEY = "openai-secret";
    process.env.ANTHROPIC_API_KEY = "anthropic-secret";
    process.env.TAVILY_API_KEY = "tavily-secret";
    process.env.RANDOM_OPERATOR_SECRET = "do-not-copy";
    try {
      // Given: process.env has unrelated provider/operator secrets.
      // When: Frondose builds the supplied StdioServerParameters.env.
      // Then: the supplied env contains only BRAVE_API_KEY and Brave MCP variables, before SDK-level merging.
      const params = mod.buildBraveMcpServerParameters(BRAVE_KEY);
      assert.deepEqual(Object.keys(params.env ?? {}).sort(), [
        "BRAVE_API_KEY",
        "BRAVE_MCP_ENABLED_TOOLS",
        "BRAVE_MCP_LOG_LEVEL",
        "BRAVE_MCP_TRANSPORT",
      ]);
      assert.equal(params.env?.BRAVE_API_KEY, BRAVE_KEY);
      assert.equal(params.env?.BRAVE_MCP_TRANSPORT, "stdio");
      assert.equal(params.env?.BRAVE_MCP_ENABLED_TOOLS, "brave_web_search");
      assert.equal(params.env?.BRAVE_MCP_LOG_LEVEL, "error");
      for (const forbidden of Object.keys(saved)) {
        assert.ok(!(forbidden in (params.env ?? {})), `supplied env must not include ${forbidden}`);
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("P-BRAVE-MCP client call shape and lifecycle", () => {
  it("T-BraveMcp.Call.1: calls brave_web_search with query, count:maxResults, and result_filter:['web']", async () => {
    const mod = await loadClient();
    assertClientModule(mod);
    const calls: unknown[] = [];
    const deps = makeDeps({
      callTool: async (request) => {
        calls.push(request);
        return { content: [{ type: "text", text: "{\"web\":{\"results\":[]}}" }] };
      },
    });

    // Given: a fake SDK client.
    // When: callBraveWebSearch runs.
    // Then: the MCP call shape is exactly the Brave web search tool contract.
    await mod.callBraveWebSearch({ apiKey: BRAVE_KEY, query: "current market map", maxResults: 7 }, deps);

    assert.deepEqual(calls[0], {
      name: "brave_web_search",
      arguments: { query: "current market map", count: 7, result_filter: ["web"] },
    });
  });

  it("T-BraveMcp.Lifecycle.1: closes a key-A session before creating a key-B session", async () => {
    const mod = await loadClient();
    assertClientModule(mod);
    const events: string[] = [];
    const deps = makeDeps({ events });

    // Given: one cached session for key A.
    // When: a second call uses key B.
    // Then: the old client/transport are closed before the new session is created.
    await mod.callBraveWebSearch({ apiKey: "key-A", query: "first", maxResults: 1 }, deps);
    await mod.callBraveWebSearch({ apiKey: "key-B", query: "second", maxResults: 1 }, deps);

    const closeIdx = events.indexOf("client:1:close");
    const createSecondIdx = events.indexOf("client:2:create");
    assert.ok(closeIdx >= 0, `old client was not closed; events=${events.join(" > ")}`);
    assert.ok(createSecondIdx >= 0, `new client was not created; events=${events.join(" > ")}`);
    assert.ok(closeIdx < createSecondIdx, `old session must close before key-B session creation; events=${events.join(" > ")}`);
  });

  it("T-BraveMcp.Lifecycle.2: clears a failed initialization so the next call can retry with a fresh session", async () => {
    const mod = await loadClient();
    assertClientModule(mod);
    let connectAttempts = 0;
    const deps = makeDeps({
      connect: async () => {
        connectAttempts++;
        if (connectAttempts === 1) throw new Error(`init failed for ${BRAVE_KEY}`);
      },
    });

    // Given: the first MCP initialization fails.
    // When: the next search call uses the same key.
    // Then: the failed session is not cached and a fresh session is created.
    const first = await Promise.allSettled([
      mod.callBraveWebSearch({ apiKey: BRAVE_KEY, query: "first", maxResults: 1 }, deps),
    ]);
    assert.equal(first.length, 1, "the failed init attempt should settle");
    await mod.callBraveWebSearch({ apiKey: BRAVE_KEY, query: "retry", maxResults: 1 }, deps);

    assert.equal(connectAttempts, 2, "init failure must clear cache so retry creates/connects a new session");
  });
});

describe("P-BRAVE-MCP limiter and sanitized output", () => {
  it("T-BraveMcp.Rate.1: concurrent MCP calls start at least 3000ms apart and the chain recovers after failure", async () => {
    const mod = await loadClient();
    assertClientModule(mod);
    let now = 0;
    let callCount = 0;
    const starts: number[] = [];
    const deps = makeDeps({
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      callTool: async () => {
        starts.push(now);
        callCount++;
        if (callCount === 1) throw new Error("first MCP failure");
        return { content: [{ type: "text", text: "{\"web\":{\"results\":[]}}" }] };
      },
    });

    // Given: three concurrent searches and a fake clock/sleep.
    // When: the first MCP call fails.
    // Then: later calls still start, and start-to-start spacing remains >=3000ms.
    const settled = await Promise.allSettled([
      mod.callBraveWebSearch({ apiKey: BRAVE_KEY, query: "one", maxResults: 1 }, deps),
      mod.callBraveWebSearch({ apiKey: BRAVE_KEY, query: "two", maxResults: 1 }, deps),
      mod.callBraveWebSearch({ apiKey: BRAVE_KEY, query: "three", maxResults: 1 }, deps),
    ]);

    assert.equal(starts.length, 3, "one MCP failure must not permanently block the limiter chain");
    assert.ok(starts[1] - starts[0] >= 3000, `second call started too soon: ${starts.join(",")}`);
    assert.ok(starts[2] - starts[1] >= 3000, `third call started too soon: ${starts.join(",")}`);
    assert.equal(settled[2].status, "fulfilled", "a later queued call must recover after an earlier MCP failure");
  });

  it("T-BraveMcp.Raw.1: redacts the effective key from success results/raw/errors and bounds raw payload size", async () => {
    const mod = await loadClient();
    assertClientModule(mod);
    const rawEntryLimit = mod.BRAVE_MCP_RAW_ENTRY_LIMIT ?? 10;
    const rawTextLimit = mod.BRAVE_MCP_RAW_TEXT_LIMIT ?? 2000;
    const manyResults = Array.from({ length: rawEntryLimit + 4 }, (_, i) => ({
      title: `Result ${i} ${BRAVE_KEY}`,
      url: `https://example.com/${BRAVE_KEY}/${i}`,
      description: `${"x".repeat(rawTextLimit + 20)} ${BRAVE_KEY}`,
    }));
    const successDeps = makeDeps({
      callTool: async () => ({
        content: [{ type: "text", text: JSON.stringify({ web: { results: manyResults } }) }],
      }),
    });

    // Given: MCP success data contains the effective key in result fields and oversized raw text.
    // When: the client returns its command envelope.
    // Then: the key is absent from every returned string and raw diagnostics are bounded.
    const success = (await mod.callBraveWebSearch(
      { apiKey: BRAVE_KEY, query: "sanitize success", maxResults: rawEntryLimit + 4 },
      successDeps,
    )) as { data?: { raw?: { entries?: string[] } } };

    assert.ok(!JSON.stringify(success).includes(BRAVE_KEY), "success envelope must not contain the raw API key");
    const rawEntries = success.data?.raw?.entries ?? [];
    assert.ok(rawEntries.length <= rawEntryLimit, `raw entries must be capped at ${rawEntryLimit}`);
    assert.ok(
      rawEntries.every((entry) => entry.length <= rawTextLimit),
      `every raw entry must be capped at ${rawTextLimit} chars`,
    );

    await mod.closeBraveSearchMcpSessionForTest();
    const errorDeps = makeDeps({
      callTool: async () => ({ isError: true, content: [{ type: "text", text: `MCP error leaked ${BRAVE_KEY}` }] }),
    });
    const failure = await mod.callBraveWebSearch(
      { apiKey: BRAVE_KEY, query: "sanitize error", maxResults: 1 },
      errorDeps,
    );
    assert.ok(!JSON.stringify(failure).includes(BRAVE_KEY), "failure envelope must not contain the raw API key");
  });
});
