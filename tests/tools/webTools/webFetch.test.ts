/**
 * P-9 mock tests — T-WebFetch.1..T-WebFetch.8
 *
 * Tests for makeWebFetchTool() in src/tools/webTools/webFetch.ts.
 *
 * T-WebFetch.1 — Happy path: HTTPS URL → ok envelope (status, contentType, text, truncated=false)
 * T-WebFetch.2 — Large response → truncated to maxChars; truncated=true + suffix message
 * T-WebFetch.3 — HTTP 4xx → fail envelope with status message
 * T-WebFetch.4 — Network error (fetch throws) → fail envelope via failFromError
 * T-WebFetch.5 — HTTP URL (not HTTPS) → Zod validation error before fetch fires
 * T-WebFetch.6 — User-Agent header is "kyoubelyu/frondose" (F-REN-4b flip: was kyoubelyu/mai-agent)
 * T-WebFetch.7 — Optional prompt echoed in result
 * T-WebFetch.8 — maxChars param respected (non-default value)
 *
 * Gate coverage: G-P9.7 (web_fetch mock path)
 *
 * No LLM, no Chrome. globalThis.fetch is monkey-patched for each test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CoreMessage, ToolExecutionOptions } from "ai";
import { makeWebFetchTool } from "../../../src/tools/webTools/webFetch.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

const FAKE_OPTS: ToolExecutionOptions = { toolCallId: "wf-1", messages: [] as CoreMessage[] };

/** Monkey-patch globalThis.fetch for the duration of fn(); restores in finally. */
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

function makeResponse(body: string, status = 200, contentType = "text/html"): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

// ─── T-WebFetch.1: Happy path ─────────────────────────────────────────────────

test("T-WebFetch.1: happy path — HTTPS URL → ok envelope with status, contentType, text", async () => {
  const tool = makeWebFetchTool();

  await withMockFetch(
    async () => makeResponse("<html><body>Hello World</body></html>", 200, "text/html"),
    async () => {
      const result = (await tool.execute?.({ url: "https://example.com", maxChars: 8000 }, FAKE_OPTS)) as {
        ok: boolean;
        data: { url: string; status: number; contentType: string; text: string; truncated: boolean };
      };

      assert.equal(result.ok, true, "must return ok:true");
      assert.equal(result.data.url, "https://example.com");
      assert.equal(result.data.status, 200);
      assert.equal(result.data.contentType, "text/html");
      assert.ok(result.data.text.includes("Hello World"), "text must contain response body");
      assert.equal(result.data.truncated, false, "short response must not be truncated");
    },
  );
});

// ─── T-WebFetch.9: fetch is bounded by a timeout (P-AUTO-L3FIX-6) ──────────────

test("T-WebFetch.9: web_fetch passes an AbortSignal.timeout to fetch so a hung page cannot stall the agent loop (P-AUTO-L3FIX-6)", async () => {
  const tool = makeWebFetchTool();
  let captured: AbortSignal | null | undefined;

  await withMockFetch(
    async (_url, init) => {
      captured = init?.signal;
      return makeResponse("ok", 200, "text/plain");
    },
    async () => {
      await tool.execute?.({ url: "https://example.com", maxChars: 8000 }, FAKE_OPTS);
    },
  );

  assert.ok(
    captured instanceof AbortSignal,
    "web_fetch must bound the fetch with an AbortSignal (timeout) — unbounded fetch is an un-abortable-hang vector",
  );
});

// ─── T-WebFetch.2: Large response → truncated ─────────────────────────────────

test("T-WebFetch.2: response longer than maxChars → truncated:true + truncation suffix", async () => {
  const tool = makeWebFetchTool();
  const bigBody = "A".repeat(20_000);
  const maxChars = 5_000;

  await withMockFetch(
    async () => makeResponse(bigBody, 200, "text/plain"),
    async () => {
      const result = (await tool.execute?.({ url: "https://example.com/big", maxChars }, FAKE_OPTS)) as {
        ok: boolean;
        data: { text: string; truncated: boolean };
      };

      assert.equal(result.ok, true);
      assert.equal(result.data.truncated, true, "large response must set truncated:true");
      // text should start with the first maxChars characters
      assert.ok(result.data.text.startsWith("A".repeat(maxChars)), "text must start with first maxChars chars");
      // text should end with the truncation notice
      assert.ok(result.data.text.includes("[truncated"), "text must contain truncation notice");
    },
  );
});

// ─── T-WebFetch.3: HTTP 4xx → fail envelope ──────────────────────────────────

test("T-WebFetch.3: HTTP 404 → fail envelope with status in message", async () => {
  const tool = makeWebFetchTool();

  await withMockFetch(
    async () => makeResponse("Not Found", 404, "text/plain"),
    async () => {
      const result = (await tool.execute?.({ url: "https://example.com/missing", maxChars: 8000 }, FAKE_OPTS)) as {
        ok: boolean;
        error: { kind: string; message: string };
      };

      assert.equal(result.ok, false, "4xx must return ok:false");
      assert.ok(
        result.error.message.includes("404"),
        `message must include HTTP status; got: "${result.error.message}"`,
      );
    },
  );
});

// ─── T-WebFetch.4: Network error → fail envelope ─────────────────────────────

test("T-WebFetch.4: network error (fetch throws) → fail envelope via failFromError", async () => {
  const tool = makeWebFetchTool();

  await withMockFetch(
    async () => {
      throw new TypeError("Failed to fetch");
    },
    async () => {
      const result = (await tool.execute?.({ url: "https://example.com", maxChars: 8000 }, FAKE_OPTS)) as {
        ok: boolean;
        error: { message: string };
      };

      assert.equal(result.ok, false, "network error must return ok:false");
      assert.ok(
        result.error.message.includes("Failed to fetch"),
        `must include error message; got: "${result.error.message}"`,
      );
    },
  );
});

// ─── T-WebFetch.5: HTTP URL → Zod schema rejects (D-15) ─────────────────────

test("T-WebFetch.5: HTTP URL (not HTTPS) → Zod schema refine rejects at parse time (D-15)", () => {
  // The Vercel SDK validates params BEFORE calling execute() during streamText.
  // We verify the schema contract directly by parsing the params.
  const tool = makeWebFetchTool();
  const schema = tool.parameters;

  // HTTP URL must fail the .refine() check
  const httpResult = schema.safeParse({ url: "http://example.com", maxChars: 8000 });
  assert.equal(httpResult.success, false, "HTTP URL must fail Zod .refine() validation (D-15)");
  assert.ok(
    JSON.stringify(httpResult.error).includes("https") ||
      JSON.stringify(httpResult.error).toLowerCase().includes("https"),
    "Error message must mention https",
  );

  // HTTPS URL must succeed
  const httpsResult = schema.safeParse({ url: "https://example.com", maxChars: 8000 });
  assert.equal(httpsResult.success, true, "HTTPS URL must pass Zod validation");
});

// ─── T-WebFetch.6: User-Agent header (NIT-1 fix verification) ────────────────

test("T-WebFetch.6: User-Agent header contains 'kyoubelyu/frondose' (F-REN-4b lockstep flip)", async () => {
  // Given: webFetch.ts User-Agent updated to frondose/1.0 (+https://github.com/kyoubelyu/frondose)
  // When:  tool.execute runs with a mocked fetch
  // Then:  captured User-Agent contains 'kyoubelyu/frondose'; NOT 'kyoubelyu/mai-agent'
  const tool = makeWebFetchTool();
  let capturedUserAgent = "";

  await withMockFetch(
    async (_url, init) => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedUserAgent = headers?.["User-Agent"] ?? "";
      return makeResponse("<html>ok</html>");
    },
    async () => {
      await tool.execute?.({ url: "https://example.com", maxChars: 8000 }, FAKE_OPTS);
    },
  );

  assert.ok(
    capturedUserAgent.includes("kyoubelyu/frondose"),
    `User-Agent must contain 'kyoubelyu/frondose' (F-REN-4b flip); got: "${capturedUserAgent}"`,
  );
  assert.ok(
    !capturedUserAgent.includes("kyoubelyu/mai-agent"),
    `User-Agent must NOT contain 'kyoubelyu/mai-agent' after F-REN-4b rename; got: "${capturedUserAgent}"`,
  );
});

// ─── T-WebFetch.7: Optional prompt echoed in result ──────────────────────────

test("T-WebFetch.7: optional prompt field echoed in ok envelope when provided", async () => {
  const tool = makeWebFetchTool();

  await withMockFetch(
    async () => makeResponse("<html>content</html>"),
    async () => {
      const result = (await tool.execute?.(
        { url: "https://example.com", maxChars: 8000, prompt: "extracting the blog title" },
        FAKE_OPTS,
      )) as { ok: boolean; data: { prompt?: string } };

      assert.equal(result.ok, true);
      assert.equal(result.data.prompt, "extracting the blog title", "prompt must be echoed in result");
    },
  );
});

// ─── T-WebFetch.8: maxChars param respected ──────────────────────────────────

test("T-WebFetch.8: non-default maxChars (200) → text truncated to exactly 200 chars prefix", async () => {
  const tool = makeWebFetchTool();
  const body = "X".repeat(10_000);

  await withMockFetch(
    async () => makeResponse(body, 200, "text/plain"),
    async () => {
      const result = (await tool.execute?.({ url: "https://example.com", maxChars: 200 }, FAKE_OPTS)) as {
        ok: boolean;
        data: { text: string; truncated: boolean };
      };

      assert.equal(result.ok, true);
      assert.equal(result.data.truncated, true);
      // Text starts with exactly 200 X's
      assert.ok(result.data.text.startsWith("X".repeat(200)), "text must start with exactly maxChars chars");
    },
  );
});
