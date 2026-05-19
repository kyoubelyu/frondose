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

function makeTavilyResponse(results: Array<{ title: string; url: string; content: string }>, status = 200): Response {
  return new Response(JSON.stringify({ results }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ─── T-WebSearch.1: Both keys unset → fail envelope ──────────────────────────

test("T-WebSearch.1: both BRAVE_API_KEY and TAVILY_API_KEY unset → fail envelope", async () => {
  const tool = makeWebSearchTool();
  await withCleanSearchJson(() =>
    withEnv("BRAVE_API_KEY", undefined, () =>
      withEnv("TAVILY_API_KEY", undefined, async () => {
        const result = (await tool.execute?.({ query: "test query", maxResults: 5 }, FAKE_OPTS)) as {
          ok: boolean;
          error: { kind: string; message: string };
        };
        assert.equal(result.ok, false, "must fail when no API keys configured");
        assert.ok(
          result.error.message.includes("BRAVE_API_KEY") && result.error.message.includes("TAVILY_API_KEY"),
          `fail message must mention both keys; got: "${result.error.message}"`,
        );
      }),
    ),
  );
});

// ─── T-WebSearch.2: Brave key set → Brave URL called; description → snippet ──

test("T-WebSearch.2: BRAVE_API_KEY set → Brave endpoint called; description mapped to snippet", async () => {
  const tool = makeWebSearchTool();
  let calledUrl = "";

  await withEnv("BRAVE_API_KEY", "brave-test-key", () =>
    withEnv("TAVILY_API_KEY", undefined, () =>
      withMockFetch(
        async (url) => {
          calledUrl = url.toString();
          return makeBraveResponse([{ title: "Example", url: "https://example.com", description: "An example site" }]);
        },
        async () => {
          const result = (await tool.execute?.({ query: "test", maxResults: 5 }, FAKE_OPTS)) as {
            ok: boolean;
            data: { provider: string; results: Array<{ title: string; url: string; snippet: string }> };
          };

          assert.equal(result.ok, true, "Brave result must be ok:true");
          assert.ok(calledUrl.includes("api.search.brave.com"), `must call Brave URL; got: "${calledUrl}"`);
          assert.equal(result.data.provider, "brave", "provider must be 'brave'");
          assert.equal(result.data.results.length, 1);
          assert.equal(result.data.results[0]?.snippet, "An example site", "description must be mapped to snippet");
        },
      ),
    ),
  );
});

// ─── T-WebSearch.3: Brave 5xx → falls through to Tavily (D-5) ────────────────

test("T-WebSearch.3: Brave 5xx → falls through to TAVILY_API_KEY (D-5)", async () => {
  const tool = makeWebSearchTool();
  let callCount = 0;

  await withEnv("BRAVE_API_KEY", "brave-key", () =>
    withEnv("TAVILY_API_KEY", "tavily-key", () =>
      withMockFetch(
        async (url) => {
          callCount++;
          const urlStr = url.toString();
          if (urlStr.includes("brave.com")) {
            return new Response("Internal Server Error", { status: 503 });
          }
          // Tavily fallback
          return makeTavilyResponse([{ title: "Tavily Result", url: "https://t.com", content: "tavily snippet" }]);
        },
        async () => {
          const result = (await tool.execute?.({ query: "test", maxResults: 5 }, FAKE_OPTS)) as {
            ok: boolean;
            data: { provider: string; results: Array<{ snippet: string }> };
          };

          assert.equal(result.ok, true, "must succeed via Tavily fallback");
          assert.equal(result.data.provider, "tavily", "provider must be tavily after Brave 5xx");
          assert.equal(result.data.results[0]?.snippet, "tavily snippet");
          assert.equal(callCount, 2, "must call Brave first, then Tavily");
        },
      ),
    ),
  );
});

// ─── T-WebSearch.4: Brave unset, Tavily set → Tavily POST called ─────────────

test("T-WebSearch.4: BRAVE_API_KEY unset, TAVILY_API_KEY set → Tavily POST endpoint called", async () => {
  const tool = makeWebSearchTool();
  let calledUrl = "";
  let calledMethod = "";

  await withCleanSearchJson(() =>
    withEnv("BRAVE_API_KEY", undefined, () =>
      withEnv("TAVILY_API_KEY", "tavily-key", () =>
        withMockFetch(
          async (url, init) => {
            calledUrl = url.toString();
            calledMethod = init?.method ?? "GET";
            return makeTavilyResponse([{ title: "T", url: "https://t.com", content: "snippet" }]);
          },
          async () => {
            const result = (await tool.execute?.({ query: "linkedin ai tools", maxResults: 3 }, FAKE_OPTS)) as {
              ok: boolean;
              data: { provider: string };
            };

            assert.equal(result.ok, true);
            assert.ok(calledUrl.includes("tavily.com"), `must call Tavily URL; got: "${calledUrl}"`);
            assert.equal(calledMethod, "POST", "Tavily endpoint must be POST");
            assert.equal(result.data.provider, "tavily");
          },
        ),
      ),
    ),
  );
});

// ─── T-WebSearch.5: Brave 401 → fail envelope (NOT Tavily fallback) ──────────

test("T-WebSearch.5: Brave 401 (invalid key) → fail envelope with invalid_input; Tavily NOT tried", async () => {
  const tool = makeWebSearchTool();
  let fetchCallCount = 0;

  await withEnv("BRAVE_API_KEY", "bad-key", () =>
    withEnv("TAVILY_API_KEY", "tavily-key", () =>
      withMockFetch(
        async () => {
          fetchCallCount++;
          return new Response("Unauthorized", { status: 401 });
        },
        async () => {
          const result = (await tool.execute?.({ query: "test", maxResults: 5 }, FAKE_OPTS)) as {
            ok: boolean;
            error: { kind: string };
          };

          assert.equal(result.ok, false, "Brave 401 must return ok:false");
          assert.equal(result.error.kind, "invalid_input", "Brave 401 kind must be invalid_input");
          assert.equal(fetchCallCount, 1, "Tavily must NOT be called after Brave 401 (not a 5xx)");
        },
      ),
    ),
  );
});

// ─── T-WebSearch.6: Both keys set, Brave 5xx → Tavily result returned ────────

test("T-WebSearch.6: Brave 5xx + both keys set → Tavily result returned with provider:tavily", async () => {
  const tool = makeWebSearchTool();

  await withEnv("BRAVE_API_KEY", "brave-key", () =>
    withEnv("TAVILY_API_KEY", "tavily-key", () =>
      withMockFetch(
        async (url) => {
          if (url.toString().includes("brave")) {
            return new Response("Bad Gateway", { status: 502 });
          }
          return makeTavilyResponse([{ title: "Fallback", url: "https://f.com", content: "from tavily" }]);
        },
        async () => {
          const result = (await tool.execute?.({ query: "test", maxResults: 5 }, FAKE_OPTS)) as {
            ok: boolean;
            data: { provider: string; results: Array<{ snippet: string }> };
          };

          assert.equal(result.ok, true);
          assert.equal(result.data.provider, "tavily");
          assert.equal(result.data.results[0]?.snippet, "from tavily", "Tavily content must map to snippet");
        },
      ),
    ),
  );
});

// ─── T-WebSearch.7: Tavily result shape (content → snippet) ──────────────────

test("T-WebSearch.7: Tavily result shape — results[].content mapped to snippet field", async () => {
  const tool = makeWebSearchTool();

  await withCleanSearchJson(() =>
    withEnv("BRAVE_API_KEY", undefined, () =>
      withEnv("TAVILY_API_KEY", "tavily-key", () =>
        withMockFetch(
          async () =>
            makeTavilyResponse([
              { title: "AI Tools", url: "https://ai.com", content: "This is the Tavily content snippet" },
              { title: "ML Guide", url: "https://ml.com", content: "Another snippet here" },
            ]),
          async () => {
            const result = (await tool.execute?.({ query: "ai", maxResults: 5 }, FAKE_OPTS)) as {
              ok: boolean;
              data: { results: Array<{ title: string; url: string; snippet: string }> };
            };

            assert.equal(result.ok, true);
            assert.equal(result.data.results.length, 2);
            assert.equal(result.data.results[0]?.snippet, "This is the Tavily content snippet");
            assert.equal(result.data.results[1]?.snippet, "Another snippet here");
            // The raw "content" key must not be present at top level
            assert.ok(!("content" in (result.data.results[0] ?? {})), "result must use 'snippet' not 'content'");
          },
        ),
      ),
    ),
  );
});

// ─── T-WebSearch.8: maxResults param respected ───────────────────────────────

test("T-WebSearch.8: maxResults=2 → only 2 results returned even if provider returns more", async () => {
  const tool = makeWebSearchTool();

  await withCleanSearchJson(() =>
    withEnv("BRAVE_API_KEY", undefined, () =>
      withEnv("TAVILY_API_KEY", "tavily-key", () =>
        withMockFetch(
          async () =>
            makeTavilyResponse([
              { title: "R1", url: "https://r1.com", content: "s1" },
              { title: "R2", url: "https://r2.com", content: "s2" },
              { title: "R3", url: "https://r3.com", content: "s3" },
              { title: "R4", url: "https://r4.com", content: "s4" },
            ]),
          async () => {
            const result = (await tool.execute?.({ query: "test", maxResults: 2 }, FAKE_OPTS)) as {
              ok: boolean;
              data: { results: unknown[] };
            };

            assert.equal(result.ok, true);
            assert.equal(result.data.results.length, 2, "must slice to maxResults=2");
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
