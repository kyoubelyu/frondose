import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, describe, it } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

type RequestOptions = { signal?: AbortSignal; timeout?: number };
type SearchMcpInput = {
  serverUrl: string;
  query: string;
  maxResults: number;
  abortSignal?: AbortSignal;
};
type SearchMcpDeps = {
  requestTimeoutMs?: number;
  createTransport?: (url: URL) => { close?: () => Promise<void> };
  createClient?: () => {
    connect: (transport: unknown, options?: RequestOptions) => Promise<void>;
    listTools: (
      params?: Record<string, unknown>,
      options?: RequestOptions,
    ) => Promise<{ tools: Array<{ name: string }>; nextCursor?: string }>;
    callTool: (
      request: { name: string; arguments?: Record<string, unknown> },
      resultSchema?: unknown,
      options?: RequestOptions,
    ) => Promise<unknown>;
    close: () => Promise<void>;
  };
};
type SearchMcpModule = {
  MCP_SEARCH_TIMEOUT_MS?: number;
  MCP_SEARCH_MAX_TOOL_PAGES?: number;
  MCP_SEARCH_RAW_ENTRY_LIMIT?: number;
  MCP_SEARCH_RAW_TEXT_LIMIT?: number;
  callSearchMcp?: (input: SearchMcpInput, deps?: SearchMcpDeps) => Promise<unknown>;
};

const CLIENT_MODULE = "../../src/mcp/searchMcpClient.js";
const openServers = new Set<ReturnType<typeof createServer>>();

async function loadClient(): Promise<SearchMcpModule> {
  try {
    return (await import(CLIENT_MODULE)) as SearchMcpModule;
  } catch {
    return {};
  }
}

function requireClient(mod: SearchMcpModule): asserts mod is Required<SearchMcpModule> {
  assert.equal(typeof mod.callSearchMcp, "function", "Builder must add callSearchMcp()");
  assert.equal(mod.MCP_SEARCH_TIMEOUT_MS, 30_000, "every MCP request must use the planned 30-second bound");
  assert.equal(mod.MCP_SEARCH_MAX_TOOL_PAGES, 20, "tool discovery must have an explicit page cap");
  assert.equal(mod.MCP_SEARCH_RAW_ENTRY_LIMIT, 10, "raw diagnostics must have an explicit entry cap");
  assert.equal(mod.MCP_SEARCH_RAW_TEXT_LIMIT, 2_000, "raw diagnostics must have an explicit text cap");
}

function assertExactMcpError(value: unknown): void {
  const envelope = value as {
    ok?: boolean;
    command?: string;
    error?: { kind?: string; message?: string };
  };
  assert.equal(envelope.ok, false);
  assert.equal(envelope.command, "web_search");
  assert.deepEqual(Object.keys(envelope).sort(), ["command", "error", "ok"]);
  assert.equal(envelope.error?.kind, "mcp_error");
  assert.deepEqual(Object.keys(envelope.error ?? {}).sort(), ["kind", "message"]);
  assert.equal(typeof envelope.error?.message, "string");
  assert.ok((envelope.error?.message.length ?? 0) <= 2_000);
}

function fakeDeps(options: {
  tools?: Array<{ name: string }>;
  pages?: Array<{ tools: Array<{ name: string }>; nextCursor?: string }>;
  result?: unknown;
  createTransportError?: Error;
  createClientError?: Error;
  clientCloseError?: Error;
  transportCloseError?: Error;
  connectError?: Error;
  listError?: Error;
  callError?: Error;
  waitForAbortAt?: "connect" | "list" | "call";
  events: string[];
  requests: Array<{ name: string; arguments?: Record<string, unknown> }>;
  requestOptions: Array<RequestOptions | undefined>;
  urls: string[];
}): SearchMcpDeps {
  const transport = {
    close: async () => {
      options.events.push("transport.close");
      if (options.transportCloseError) throw options.transportCloseError;
    },
  };
  return {
    createTransport: (url) => {
      if (options.createTransportError) throw options.createTransportError;
      options.urls.push(url.toString());
      options.events.push("transport.create");
      return transport;
    },
    createClient: () => {
      if (options.createClientError) throw options.createClientError;
      return {
        connect: async (_transport, requestOptions) => {
          options.events.push("client.connect");
          options.requestOptions.push(requestOptions);
          if (options.connectError) throw options.connectError;
          if (options.waitForAbortAt === "connect") await rejectWhenAborted(requestOptions?.signal);
        },
        listTools: async (params, requestOptions) => {
          options.events.push("client.listTools");
          options.requestOptions.push(requestOptions);
          if (options.listError) throw options.listError;
          if (options.waitForAbortAt === "list") await rejectWhenAborted(requestOptions?.signal);
          if (options.pages) {
            const cursor = typeof params?.cursor === "string" ? params.cursor : undefined;
            const index = cursor ? Number(cursor.replace("page-", "")) : 0;
            return options.pages[index] ?? { tools: [], nextCursor: cursor };
          }
          return { tools: options.tools ?? [{ name: "web_search" }] };
        },
        callTool: async (request, _schema, requestOptions) => {
          options.events.push("client.callTool");
          options.requests.push(request);
          options.requestOptions.push(requestOptions);
          if (options.callError) throw options.callError;
          if (options.waitForAbortAt === "call") await rejectWhenAborted(requestOptions?.signal);
          return (
            options.result ?? {
              structuredContent: {
                query: "frondose",
                results: [{ title: "Frondose", url: "https://example.test/frondose", description: "Result" }],
              },
              content: [{ type: "text", text: "fixture raw" }],
            }
          );
        },
        close: async () => {
          options.events.push("client.close");
          if (options.clientCloseError) throw options.clientCloseError;
          await transport.close();
        },
      };
    },
  };
}

async function rejectWhenAborted(signal?: AbortSignal): Promise<never> {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  await new Promise<never>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")), {
      once: true,
    });
  });
  throw new Error("unreachable");
}

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        }),
    ),
  );
  openServers.clear();
});

describe("P-WEB-SEARCH-MCP-SCOPE remote MCP client", () => {
  // Given a configured MCP URL, when search completes, then exact args, bounds, ordering, and closure are observable.
  it("T-MCP-SCOPE.2: configured invocation dispatches exact web_search arguments with bounded lifecycle", async () => {
    const mod = await loadClient();
    requireClient(mod);
    const events: string[] = [];
    const requests: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const requestOptions: Array<RequestOptions | undefined> = [];
    const urls: string[] = [];
    const controller = new AbortController();

    const result = (await mod.callSearchMcp(
      {
        serverUrl: "https://mcp.example.test/search",
        query: "frondose",
        maxResults: 2,
        abortSignal: controller.signal,
      },
      fakeDeps({ events, requests, requestOptions, urls }),
    )) as {
      ok?: boolean;
      command?: string;
      data?: {
        query?: string;
        results?: Array<{ title: string; url: string; description: string }>;
        raw?: { entries: string[]; truncated: boolean };
      };
    };

    assert.equal(result.ok, true);
    assert.equal(result.command, "web_search");
    assert.equal(result.data?.query, "frondose");
    assert.deepEqual(result.data?.results, [
      { title: "Frondose", url: "https://example.test/frondose", description: "Result" },
    ]);
    assert.deepEqual(result.data?.raw, { entries: ["fixture raw"], truncated: false });
    assert.deepEqual(urls, ["https://mcp.example.test/search"]);
    assert.deepEqual(requests, [{ name: "web_search", arguments: { query: "frondose", maxResults: 2 } }]);
    assert.deepEqual(events, [
      "transport.create",
      "client.connect",
      "client.listTools",
      "client.callTool",
      "client.close",
      "transport.close",
    ]);
    assert.equal(requestOptions.length, 3);
    for (const options of requestOptions) {
      assert.equal(options?.signal, controller.signal);
      assert.equal(options?.timeout, 30_000);
    }

    const closeFailureEvents: string[] = [];
    const closeFailureResult = (await mod.callSearchMcp(
      { serverUrl: "https://mcp.example.test/search", query: "close failure", maxResults: 1 },
      fakeDeps({
        clientCloseError: new Error("client close failed"),
        events: closeFailureEvents,
        requests: [],
        requestOptions: [],
        urls: [],
      }),
    )) as {
      ok?: boolean;
      command?: string;
      data?: {
        query?: string;
        results?: Array<{ title: string; url: string; description: string }>;
        raw?: { entries: string[]; truncated: boolean };
      };
    };
    assert.equal(closeFailureResult.ok, true);
    assert.equal(closeFailureResult.command, "web_search");
    assert.deepEqual(closeFailureResult.data, {
      query: "close failure",
      results: [{ title: "Frondose", url: "https://example.test/frondose", description: "Result" }],
      raw: { entries: ["fixture raw"], truncated: false },
    });
    assert.deepEqual(closeFailureEvents.slice(-2), ["client.close", "transport.close"]);
  });

  // Given paginated discovery, when exact web_search is later, duplicated, or trapped in a cursor cycle, then resolution is bounded.
  it("T-MCP-SCOPE.3b: tool discovery follows bounded pages and rejects cross-page duplicates or cursor cycles", async () => {
    const mod = await loadClient();
    requireClient(mod);

    const laterRequests: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const laterEvents: string[] = [];
    const later = (await mod.callSearchMcp(
      { serverUrl: "https://mcp.example.test/search", query: "later", maxResults: 1 },
      fakeDeps({
        pages: [{ tools: [{ name: "other" }], nextCursor: "page-1" }, { tools: [{ name: "web_search" }] }],
        events: laterEvents,
        requests: laterRequests,
        requestOptions: [],
        urls: [],
      }),
    )) as { ok?: boolean };
    assert.equal(later.ok, true);
    assert.equal(laterRequests.length, 1);
    assert.deepEqual(laterEvents.slice(-2), ["client.close", "transport.close"]);

    for (const pages of [
      [{ tools: [{ name: "web_search" }], nextCursor: "page-1" }, { tools: [{ name: "web_search" }] }],
      [{ tools: [{ name: "other" }], nextCursor: "page-0" }],
      Array.from({ length: 21 }, (_value, index) => ({
        tools: [{ name: `other-${index}` }],
        nextCursor: `page-${index + 1}`,
      })),
    ]) {
      const requests: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
      const events: string[] = [];
      const result = (await mod.callSearchMcp(
        { serverUrl: "https://mcp.example.test/search", query: "bounded", maxResults: 1 },
        fakeDeps({ pages, events, requests, requestOptions: [], urls: [] }),
      )) as { ok?: boolean; error?: { kind?: string } };
      assertExactMcpError(result);
      assert.deepEqual(requests, []);
      assert.ok(events.filter((event) => event === "client.listTools").length <= 20);
      assert.deepEqual(events.slice(-2), ["client.close", "transport.close"]);
    }
  });

  // Given alias-only or duplicate tool lists, when validated, then neither list dispatches and both close with mcp_error.
  it("T-MCP-SCOPE.3: missing or duplicate exact remote tool fails closed without alias dispatch", async () => {
    const mod = await loadClient();
    requireClient(mod);

    for (const tools of [[{ name: "brave_web_search" }], [{ name: "web_search" }, { name: "web_search" }]]) {
      const events: string[] = [];
      const requests: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
      const result = (await mod.callSearchMcp(
        { serverUrl: "https://mcp.example.test/search", query: "exact", maxResults: 1 },
        fakeDeps({ tools, events, requests, requestOptions: [], urls: [] }),
      )) as { ok?: boolean; error?: { kind?: string } };

      assertExactMcpError(result);
      assert.deepEqual(requests, []);
      assert.ok(events.includes("client.close"), "the client must close after tool-list rejection");
    }
  });

  // Given pre-abort and mid-phase aborts, when invoked, then each returns promptly and closes every acquired transport owner.
  it("T-MCP-SCOPE.4c: pre-aborted and in-flight connect/list/call cancellation return promptly with cleanup", async () => {
    const mod = await loadClient();
    requireClient(mod);

    const pre = new AbortController();
    pre.abort(new Error("pre-aborted"));
    const preEvents: string[] = [];
    const preResult = (await mod.callSearchMcp(
      { serverUrl: "https://mcp.example.test/search", query: "pre", maxResults: 1, abortSignal: pre.signal },
      fakeDeps({ events: preEvents, requests: [], requestOptions: [], urls: [] }),
    )) as { ok?: boolean; error?: { kind?: string } };
    assertExactMcpError(preResult);
    assert.deepEqual(preEvents, [], "pre-abort must return before transport construction");

    for (const phase of ["connect", "list", "call"] as const) {
      const controller = new AbortController();
      const events: string[] = [];
      const pending = mod.callSearchMcp(
        {
          serverUrl: "https://mcp.example.test/search",
          query: phase,
          maxResults: 1,
          abortSignal: controller.signal,
        },
        fakeDeps({ waitForAbortAt: phase, events, requests: [], requestOptions: [], urls: [] }),
      ) as Promise<{ ok?: boolean; error?: { kind?: string } }>;
      setTimeout(() => controller.abort(new Error(`${phase} aborted`)), 5);
      const result = await Promise.race([
        pending,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${phase} abort hung`)), 500)),
      ]);
      assertExactMcpError(result);
      assert.deepEqual(events.slice(-2), ["client.close", "transport.close"]);
    }
  });

  // Given text/structured/malformed MCP outputs, when normalized, then exact bounds and recursive endpoint redaction hold.
  it("T-MCP-SCOPE.4d: normalization accepts exact structured/text shapes and bounds every returned diagnostic", async () => {
    const mod = await loadClient();
    requireClient(mod);
    const endpoint = "https://mcp.example.test/search?token=result-secret";
    const many = Array.from({ length: 14 }, (_, index) => ({
      title: `Title ${index} ${"t".repeat(400)}`,
      url: index === 0 ? endpoint : `https://result.example/${index}`,
      description: `Description ${index} ${"d".repeat(2_500)}`,
    }));
    const extraRaw = Array.from({ length: 13 }, (_value, index) => ({
      type: "text",
      text: `raw-${index}-${"r".repeat(2_500)}`,
    }));

    for (const result of [
      {
        structuredContent: { query: "result-secret", results: many },
        content: [{ type: "text", text: "primary raw" }, ...extraRaw],
      },
      { content: [{ type: "text", text: JSON.stringify({ query: "result-secret", results: many }) }, ...extraRaw] },
    ]) {
      const events: string[] = [];
      const envelope = (await mod.callSearchMcp(
        { serverUrl: endpoint, query: "normalize", maxResults: 10 },
        fakeDeps({ result, events, requests: [], requestOptions: [], urls: [] }),
      )) as {
        ok?: boolean;
        data?: {
          query?: string;
          results?: Array<Record<string, string>>;
          raw?: { entries?: string[]; truncated?: boolean };
        };
      };
      assert.equal(envelope.ok, true);
      assert.equal(envelope.data?.query, "normalize");
      assert.deepEqual(Object.keys(envelope).sort(), ["command", "data", "ok"]);
      assert.deepEqual(Object.keys(envelope.data ?? {}).sort(), ["query", "raw", "results"]);
      assert.equal(envelope.data?.results?.length, 10);
      assert.ok(
        envelope.data?.results?.every(
          (entry) => JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(["description", "title", "url"]),
        ),
      );
      assert.deepEqual(Object.keys(envelope.data?.raw ?? {}).sort(), ["entries", "truncated"]);
      assert.ok(envelope.data?.results?.every((entry) => entry.title.length <= 300));
      assert.ok(envelope.data?.results?.every((entry) => entry.url.length <= 2_048));
      assert.ok(envelope.data?.results?.every((entry) => entry.description.length <= 2_000));
      assert.equal(envelope.data?.raw?.entries?.length, 10);
      assert.equal(envelope.data?.raw?.truncated, true);
      assert.ok(envelope.data?.raw?.entries?.every((entry) => entry.length <= 2_000));
      assert.ok(!JSON.stringify(envelope).includes(endpoint));
      assert.ok(!JSON.stringify(envelope).includes("result-secret"));
      assert.deepEqual(events.slice(-2), ["client.close", "transport.close"]);
    }

    const structuredOnlyEvents: string[] = [];
    const structuredOnly = await mod.callSearchMcp(
      { serverUrl: endpoint, query: "structured only", maxResults: 1 },
      fakeDeps({
        result: {
          structuredContent: {
            results: [{ title: "Structured", url: "https://structured.example", description: "Only" }],
          },
        },
        events: structuredOnlyEvents,
        requests: [],
        requestOptions: [],
        urls: [],
      }),
    );
    assert.deepEqual(structuredOnly, {
      ok: true,
      command: "web_search",
      data: {
        query: "structured only",
        results: [{ title: "Structured", url: "https://structured.example", description: "Only" }],
        raw: { entries: [], truncated: false },
      },
    });
    assert.deepEqual(structuredOnlyEvents.slice(-2), ["client.close", "transport.close"]);

    const boundedEvents: string[] = [];
    const bounded = (await mod.callSearchMcp(
      { serverUrl: endpoint, query: "bounded success", maxResults: 3 },
      fakeDeps({
        result: {
          structuredContent: {
            results: many.map((entry, index) => ({
              ...entry,
              title: index === 0 ? `title result-secret ${endpoint}` : entry.title,
              description: index === 1 ? "description result-secret" : entry.description,
            })),
          },
          content: [
            { type: "text", text: "raw result-secret" },
            { type: "text", text: "second bounded raw" },
          ],
        },
        events: boundedEvents,
        requests: [],
        requestOptions: [],
        urls: [],
      }),
    )) as {
      ok?: boolean;
      data?: { results?: Array<Record<string, string>>; raw?: { entries?: string[]; truncated?: boolean } };
    };
    assert.equal(bounded.ok, true);
    assert.equal(bounded.data?.results?.length, 3);
    assert.equal(bounded.data?.raw?.entries?.length, 2);
    assert.equal(bounded.data?.raw?.truncated, false);
    assert.ok(!JSON.stringify(bounded).includes(endpoint));
    assert.ok(!JSON.stringify(bounded).includes("result-secret"));
    assert.deepEqual(boundedEvents.slice(-2), ["client.close", "transport.close"]);

    const entryEvents: string[] = [];
    const entryBounded = (await mod.callSearchMcp(
      { serverUrl: endpoint, query: "entry bounded", maxResults: 1 },
      fakeDeps({
        result: {
          structuredContent: { results: many.slice(0, 1) },
          content: Array.from({ length: 11 }, (_, index) => ({ type: "text", text: `short-${index}` })),
        },
        events: entryEvents,
        requests: [],
        requestOptions: [],
        urls: [],
      }),
    )) as { ok?: boolean; data?: { raw?: { entries?: string[]; truncated?: boolean } } };
    assert.equal(entryBounded.ok, true);
    assert.deepEqual(
      entryBounded.data?.raw?.entries,
      Array.from({ length: 10 }, (_, index) => `short-${index}`),
    );
    assert.equal(entryBounded.data?.raw?.truncated, true);
    assert.deepEqual(entryEvents.slice(-2), ["client.close", "transport.close"]);

    const textEvents: string[] = [];
    const textBounded = (await mod.callSearchMcp(
      { serverUrl: endpoint, query: "text bounded", maxResults: 1 },
      fakeDeps({
        result: {
          structuredContent: { results: many.slice(0, 1) },
          content: [{ type: "text", text: "x".repeat(2_001) }],
        },
        events: textEvents,
        requests: [],
        requestOptions: [],
        urls: [],
      }),
    )) as { ok?: boolean; data?: { raw?: { entries?: string[]; truncated?: boolean } } };
    assert.equal(textBounded.ok, true);
    assert.equal(textBounded.data?.raw?.entries?.length, 1);
    assert.equal(textBounded.data?.raw?.entries?.[0], "x".repeat(2_000));
    assert.equal(textBounded.data?.raw?.truncated, true);
    assert.deepEqual(textEvents.slice(-2), ["client.close", "transport.close"]);

    for (const malformed of [
      { content: [] },
      { content: [{ type: "text", text: "not json" }] },
      {},
      { structuredContent: { results: [{ url: "https://missing-title.test", description: "x" }] } },
      { structuredContent: { results: [{ title: 123, url: "https://bad-title.test", description: "x" }] } },
      { structuredContent: { results: [{ title: "x", url: null, description: "x" }] } },
      { structuredContent: { results: [{ title: "x", url: "https://bad-description.test", description: [] }] } },
    ]) {
      const events: string[] = [];
      const envelope = (await mod.callSearchMcp(
        { serverUrl: "https://mcp.example.test/search", query: "malformed", maxResults: 1 },
        fakeDeps({ result: malformed, events, requests: [], requestOptions: [], urls: [] }),
      )) as { ok?: boolean; error?: { kind?: string } };
      assertExactMcpError(envelope);
      assert.deepEqual(events.slice(-2), ["client.close", "transport.close"]);

      const rejectingCleanupEvents: string[] = [];
      const withRejectingCleanup = await mod.callSearchMcp(
        { serverUrl: "https://mcp.example.test/search", query: "malformed", maxResults: 1 },
        fakeDeps({
          result: malformed,
          clientCloseError: new Error("client close failed"),
          transportCloseError: new Error("transport close failed"),
          events: rejectingCleanupEvents,
          requests: [],
          requestOptions: [],
          urls: [],
        }),
      );
      assert.deepEqual(
        withRejectingCleanup,
        envelope,
        "cleanup rejection must preserve the original normalization failure envelope",
      );
      assert.deepEqual(rejectingCleanupEvents.slice(-2), ["client.close", "transport.close"]);
    }

    let nested: unknown = { marker: "depth-21", endpoint, token: "result-secret" };
    for (let depth = 20; depth >= 0; depth--) nested = { marker: `depth-${depth}`, nested };
    const depthEvents: string[] = [];
    const deepFailure = await mod.callSearchMcp(
      { serverUrl: endpoint, query: "depth", maxResults: 1 },
      fakeDeps({
        result: { isError: true, structuredContent: nested, content: [{ type: "text", text: "failed" }] },
        events: depthEvents,
        requests: [],
        requestOptions: [],
        urls: [],
      }),
    );
    assertExactMcpError(deepFailure);
    assert.ok(!JSON.stringify(deepFailure).includes(endpoint));
    assert.ok(!JSON.stringify(deepFailure).includes("result-secret"));
    assert.ok(JSON.stringify(deepFailure).includes("depth-20"));
    assert.ok(!JSON.stringify(deepFailure).includes("depth-21"));
    assert.ok(JSON.stringify(deepFailure).includes("[truncated]"));
    assert.deepEqual(depthEvents.slice(-2), ["client.close", "transport.close"]);
  });

  // Given invalid endpoints and echoed URL secrets, when failures return, then construction is blocked and secrets are absent.
  it("T-MCP-SCOPE.4: endpoint validation and recursive diagnostics redact URL secrets", async () => {
    const mod = await loadClient();
    requireClient(mod);

    for (const serverUrl of [
      "not a url",
      "file:///tmp/search.sock",
      "ftp://example.test/search",
      "https://alice:password@mcp.example.test/search",
    ]) {
      const urls: string[] = [];
      const result = (await mod.callSearchMcp(
        { serverUrl, query: "invalid", maxResults: 1 },
        fakeDeps({ events: [], requests: [], requestOptions: [], urls }),
      )) as { ok?: boolean; error?: { kind?: string } };
      assertExactMcpError(result);
      assert.deepEqual(urls, []);
      if (serverUrl.includes("alice")) {
        assert.ok(!JSON.stringify(result).includes("alice"));
        assert.ok(!JSON.stringify(result).includes("password"));
      }
    }

    const secretUrl = "https://mcp.example.test/search?token=query-secret&tenant=tenant-secret";
    const echoed = `failed ${secretUrl} query-secret tenant-secret`;
    const failureDeps = [
      { connectError: new Error(echoed) },
      { listError: new Error(echoed) },
      { callError: new Error(echoed) },
      {
        result: {
          isError: true,
          structuredContent: {
            nested: {
              endpoint: secretUrl,
              token: "query-secret",
              [secretUrl]: "endpoint key",
              "query-secret": "query key",
              "tenant-secret": "tenant key",
            },
          },
          content: [{ type: "text", text: echoed }],
        },
      },
    ];
    for (const failure of failureDeps) {
      const events: string[] = [];
      const baseline = await mod.callSearchMcp(
        { serverUrl: secretUrl, query: "redact", maxResults: 1 },
        fakeDeps({ events, requests: [], requestOptions: [], urls: [], ...failure }),
      );
      assertExactMcpError(baseline);
      const serialized = JSON.stringify(baseline);
      for (const secret of [secretUrl, "query-secret", "tenant-secret"]) {
        assert.ok(!serialized.includes(secret), `returned envelope leaked ${secret}`);
      }
      assert.deepEqual(events.slice(-2), ["client.close", "transport.close"]);

      const rejectingCleanupEvents: string[] = [];
      const withRejectingCleanup = await mod.callSearchMcp(
        { serverUrl: secretUrl, query: "redact", maxResults: 1 },
        fakeDeps({
          events: rejectingCleanupEvents,
          requests: [],
          requestOptions: [],
          urls: [],
          ...failure,
          clientCloseError: new Error("client close failed"),
          transportCloseError: new Error("transport close failed"),
        }),
      );
      assert.deepEqual(withRejectingCleanup, baseline, "cleanup rejection must preserve the original failure envelope");
      assert.deepEqual(rejectingCleanupEvents.slice(-2), ["client.close", "transport.close"]);
    }
  });

  // Given acquired resources and a connect rejection, when failure is handled, then mcp_error returns and both owners close.
  it("T-MCP-SCOPE.4b: connect failures remain bounded and close acquired resources", async () => {
    const mod = await loadClient();
    requireClient(mod);
    const events: string[] = [];

    const result = (await mod.callSearchMcp(
      { serverUrl: "https://mcp.example.test/search", query: "connect", maxResults: 1 },
      fakeDeps({
        connectError: new Error("connect failed"),
        events,
        requests: [],
        requestOptions: [],
        urls: [],
      }),
    )) as { ok?: boolean; error?: { kind?: string } };

    assertExactMcpError(result);
    assert.ok(events.includes("client.close"));
    assert.ok(events.includes("transport.close"));
  });

  // Given transport creation succeeds but client creation throws, when handled, then the still-unowned transport closes directly.
  it("T-MCP-SCOPE.4b2: client-construction failure closes the unowned transport", async () => {
    const mod = await loadClient();
    requireClient(mod);
    const events: string[] = [];
    const result = (await mod.callSearchMcp(
      { serverUrl: "https://mcp.example.test/search", query: "construct", maxResults: 1 },
      fakeDeps({
        createClientError: new Error("client construction failed"),
        events,
        requests: [],
        requestOptions: [],
        urls: [],
      }),
    )) as { ok?: boolean; error?: { kind?: string } };
    assertExactMcpError(result);
    assert.deepEqual(events, ["transport.create", "transport.close"]);
  });

  // Given transport construction throws before ownership, when handled, then mcp_error returns without a close attempt.
  it("T-MCP-SCOPE.4b1: transport-construction failure returns a bounded envelope before ownership", async () => {
    const mod = await loadClient();
    requireClient(mod);
    const events: string[] = [];
    const result = (await mod.callSearchMcp(
      { serverUrl: "https://mcp.example.test/search", query: "transport construct", maxResults: 1 },
      fakeDeps({
        createTransportError: new Error("transport construction failed"),
        events,
        requests: [],
        requestOptions: [],
        urls: [],
      }),
    )) as { ok?: boolean; error?: { kind?: string } };
    assertExactMcpError(result);
    assert.deepEqual(events, []);
  });

  // Given a real pinned-SDK server, when production performs list/call, then MCP framing carries exact args and one result.
  it("T-MCP-SCOPE.5: pinned SDK completes a real Streamable HTTP list/call round-trip", async () => {
    const mod = await loadClient();
    requireClient(mod);
    const observed: Array<Record<string, unknown>> = [];
    const httpServer = createServer(async (req, res) => {
      const server = new McpServer({ name: "frondose-search-fixture", version: "1.0.0" });
      server.registerTool(
        "web_search",
        {
          inputSchema: { query: z.string(), maxResults: z.number().int() },
        },
        async ({ query, maxResults }) => {
          if (query === "timeout fixture") await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
          observed.push({ query, maxResults });
          return {
            structuredContent: {
              query,
              results: [{ title: "Fixture", url: "https://example.test/current", description: "Current fixture" }],
            },
            content: [{ type: "text", text: "fixture transport raw" }],
          };
        },
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    openServers.add(httpServer);
    await new Promise<void>((resolveListen) => httpServer.listen(0, "127.0.0.1", resolveListen));
    const address = httpServer.address();
    assert.ok(address && typeof address === "object");

    let successTransportClosed = false;
    const result = (await mod.callSearchMcp(
      {
        serverUrl: `http://127.0.0.1:${address.port}/mcp`,
        query: "sdk fixture",
        maxResults: 1,
      },
      {
        createTransport: (url) => {
          const transport = new StreamableHTTPClientTransport(url);
          const close = transport.close.bind(transport);
          transport.close = async () => {
            successTransportClosed = true;
            await close();
          };
          return transport;
        },
      },
    )) as { ok?: boolean; data?: { results?: unknown[] } };

    assert.equal(result.ok, true);
    assert.deepEqual(observed, [{ query: "sdk fixture", maxResults: 1 }]);
    assert.equal(result.data?.results?.length, 1);
    assert.equal(successTransportClosed, true);

    const startedAt = Date.now();
    let timeoutTransportClosed = false;
    const timedOut = (await mod.callSearchMcp(
      {
        serverUrl: `http://127.0.0.1:${address.port}/mcp`,
        query: "timeout fixture",
        maxResults: 1,
      },
      {
        requestTimeoutMs: 20,
        createTransport: (url) => {
          const transport = new StreamableHTTPClientTransport(url);
          const close = transport.close.bind(transport);
          transport.close = async () => {
            timeoutTransportClosed = true;
            await close();
          };
          return transport;
        },
      },
    )) as { ok?: boolean; error?: { kind?: string } };
    assertExactMcpError(timedOut);
    assert.ok(Date.now() - startedAt < 500, "real SDK timeout must return promptly");
    assert.equal(timeoutTransportClosed, true, "timeout cleanup must close the real SDK transport");
  });
});
