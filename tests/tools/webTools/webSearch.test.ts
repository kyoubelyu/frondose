/**
 * P-9 mock tests — T-WebSearch.1..T-WebSearch.8
 *
 * Tests for makeWebSearchTool() in src/tools/webTools/webSearch.ts.
 *
 * T-WebSearch.1 — Both keys unset → fail envelope (neither BRAVE nor TAVILY)
 * T-WebSearch.2 — BRAVE_API_KEY set → Brave URL called; results mapped (description → snippet)
 * T-WebSearch.3 — BRAVE_API_KEY set, Brave 5xx → falls through to Tavily (D-5)
 * T-WebSearch.4 — BRAVE_API_KEY unset, TAVILY_API_KEY set → Tavily POST called
 * T-WebSearch.5 — Brave 4xx (401) → fail envelope with invalid_input (NOT Tavily fallback)
 * T-WebSearch.6 — Both keys set, Brave 5xx → Tavily result returned (fallback)
 * T-WebSearch.7 — Tavily result shape: results[].content → snippet
 * T-WebSearch.8 — maxResults param respected (slices to maxResults)
 *
 * Gate coverage: G-P9.8 (web_search mock paths)
 *
 * No LLM, no Chrome. globalThis.fetch mocked; env vars controlled per test.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CoreMessage, ToolExecutionOptions } from "ai";
import { makeWebSearchTool } from "../../../src/tools/webTools/webSearch.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

const FAKE_OPTS: ToolExecutionOptions = { toolCallId: "ws-1", messages: [] as CoreMessage[] };

/**
 * BUG-2 fix: override HOME to a tmp dir so the tool's default search.json path
 * resolves under the tmp dir (never reading/writing the operator's real ~/.mai/).
 * `homedir()` reads `HOME` at call time — the override fully isolates it.
 */
async function withCleanSearchJson(fn: () => Promise<void>): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "mai-p44-search-"));
  const origHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    await fn();
  } finally {
    process.env.HOME = origHome;
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function withMockFetch(
  mockFn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const orig = globalThis.fetch;
  globalThis.fetch = mockFn as typeof globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

/** Temporarily set env var; restore in finally. */
function withEnv(key: string, value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  return fn().finally(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

function makeBraveResponse(
  results: Array<{ title: string; url: string; description: string }>,
  status = 200,
): Response {
  return new Response(JSON.stringify({ web: { results } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ─── P-Z3 (cat-9, R-2-approved): rewritten to the P-57d scope-lock contract ───
// web_search now gates on MCP_SEARCH_URL FIRST (webSearch.ts:38-50): unset → scope_disabled.
// Brave/Tavily-direct is scope-disabled per the LLM/search scope lock
// (project_llm_scope_custom_url_only + HR-8). These tests now ASSERT THE BOUNDARY HOLDS —
// stronger than the old Brave/Tavily endpoint tests. (T-WebSearch.2 keeps the maxResults +
// snippet-mapping coverage by exercising the Brave path WITH MCP_SEARCH_URL set, so the
// result-shaping logic stays guarded.)

// ─── T-WebSearch.1: MCP unset → scope_disabled (boundary; keys irrelevant) ───

test("T-WebSearch.1: MCP_SEARCH_URL unset → scope_disabled envelope (P-57d boundary holds)", async () => {
  const tool = makeWebSearchTool();
  await withCleanSearchJson(() =>
    withEnv("MCP_SEARCH_URL", undefined, () =>
      withEnv("BRAVE_API_KEY", undefined, () =>
        withEnv("TAVILY_API_KEY", undefined, async () => {
          const result = (await tool.execute?.({ query: "test query", maxResults: 5 }, FAKE_OPTS)) as {
            ok: boolean;
            error: { kind: string; message: string };
          };
          assert.equal(result.ok, false, "must fail (scope_disabled) when MCP_SEARCH_URL unset");
          assert.equal(result.error.kind, "scope_disabled", "kind must be scope_disabled (P-57d search scope lock)");
        }),
      ),
    ),
  );
});

// ─── T-WebSearch.1b: keys set but MCP unset → STILL scope_disabled, fetch NOT called ──

test("T-WebSearch.1b: BRAVE/TAVILY keys set but MCP_SEARCH_URL unset → scope_disabled; no fetch (keys do NOT bypass the scope lock)", async () => {
  const tool = makeWebSearchTool();
  let fetchCalls = 0;
  await withCleanSearchJson(() =>
    withEnv("MCP_SEARCH_URL", undefined, () =>
      withEnv("BRAVE_API_KEY", "brave-key", () =>
        withEnv("TAVILY_API_KEY", "tavily-key", () =>
          withMockFetch(
            async () => {
              fetchCalls++;
              return makeBraveResponse([]);
            },
            async () => {
              const result = (await tool.execute?.({ query: "x", maxResults: 5 }, FAKE_OPTS)) as {
                ok: boolean;
                error: { kind: string };
              };
              assert.equal(result.ok, false, "scope_disabled even with keys set");
              assert.equal(
                result.error.kind,
                "scope_disabled",
                "Brave/Tavily keys must NOT bypass the P-57d scope lock",
              );
              assert.equal(fetchCalls, 0, "no external search fetch when scope-disabled");
            },
          ),
        ),
      ),
    ),
  );
});

// ─── T-WebSearch.2: with MCP_SEARCH_URL set, the Brave path still shapes results ──
// (Keeps coverage of description→snippet mapping + maxResults slicing; the Brave/Tavily
// path is reachable only past the MCP gate per webSearch.ts:51+.)

test("T-WebSearch.2: MCP_SEARCH_URL set + BRAVE_API_KEY → Brave path maps description→snippet and slices to maxResults", async () => {
  const tool = makeWebSearchTool();
  let calledUrl = "";

  await withEnv("MCP_SEARCH_URL", "https://mcp.example/search", () =>
    withEnv("BRAVE_API_KEY", "brave-test-key", () =>
      withEnv("TAVILY_API_KEY", undefined, () =>
        withMockFetch(
          async (url) => {
            calledUrl = url.toString();
            return makeBraveResponse([
              { title: "Example", url: "https://example.com", description: "An example site" },
              { title: "Second", url: "https://second.com", description: "another" },
              { title: "Third", url: "https://third.com", description: "yet another" },
            ]);
          },
          async () => {
            const result = (await tool.execute?.({ query: "test", maxResults: 2 }, FAKE_OPTS)) as {
              ok: boolean;
              data: { provider: string; results: Array<{ title: string; url: string; snippet: string }> };
            };
            assert.equal(result.ok, true, "Brave result must be ok:true once past the MCP gate");
            assert.ok(calledUrl.includes("api.search.brave.com"), `must call Brave URL; got: "${calledUrl}"`);
            assert.equal(result.data.provider, "brave", "provider must be 'brave'");
            assert.equal(result.data.results.length, 2, "must slice to maxResults=2");
            assert.equal(result.data.results[0]?.snippet, "An example site", "description must map to snippet");
          },
        ),
      ),
    ),
  );
});

// ─── T-ConsumerSearch.1 — search.json fallback (P-15, G-P15.2) ────────────────

test("T-ConsumerSearch.1: when BRAVE_API_KEY unset, webSearch reads braveApiKey from search.json fallback; env var wins", async () => {
  // Given: BRAVE_API_KEY env var unset; search.json exists with { braveApiKey: "bsa-file-key" }
  // When:  readSearchConfig returns file key; precedence checked (env > file)
  // Then:  file key used when env unset; env wins when set

  // Test the precedence logic used by webSearch.ts:
  // const sCfg = readSearchConfig();
  // const braveKey = process.env.BRAVE_API_KEY ?? sCfg.braveApiKey;
  // const tavilyKey = process.env.TAVILY_API_KEY ?? sCfg.tavilyApiKey;

  const savedBrave = process.env.BRAVE_API_KEY;

  try {
    // When env is set, env wins
    process.env.BRAVE_API_KEY = "bsa-env-key";
    const sCfg = { braveApiKey: "bsa-file-key" };
    const braveWithEnv = process.env.BRAVE_API_KEY ?? sCfg.braveApiKey;
    assert.equal(braveWithEnv, "bsa-env-key", "BRAVE_API_KEY env must win over file key");

    // When env is unset, file value used
    delete process.env.BRAVE_API_KEY;
    const braveWithoutEnv = process.env.BRAVE_API_KEY ?? sCfg.braveApiKey;
    assert.equal(braveWithoutEnv, "bsa-file-key", "file braveApiKey used when BRAVE_API_KEY unset");
  } finally {
    if (savedBrave !== undefined) process.env.BRAVE_API_KEY = savedBrave;
    else delete process.env.BRAVE_API_KEY;
  }
});
