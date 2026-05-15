/**
 * P-26 Step 5 — T-QLG.1..5
 *
 * Tests for query_lead_globally tool (makeQueryLeadGloballyTool).
 * Gate coverage: G-P26.19
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDEMPOTENT_TOOLS } from "../../src/agent/retryWrapper.js";
import { makeQueryLeadGloballyTool } from "../../src/tools/server/queryLeadGlobally.js";

const COORDS = { serverUrl: "http://127.0.0.1:19999", token: "test-token", workerId: "w1" };

describe("query_lead_globally tool (G-P26.19)", () => {
  it("T-QLG.1: with serverCoords=null, execute returns {ok:false, error: 'server.url not configured...'}", async () => {
    // Given: makeQueryLeadGloballyTool(null)
    // When:  execute({personRef:"https://www.linkedin.com/in/alice/"})
    // Then:  {ok:false, error: string containing "server.url not configured"}
    const tool = makeQueryLeadGloballyTool(null);
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const result = (await (tool.execute as (a: unknown, o: object) => Promise<any>)(
      { personRef: "https://www.linkedin.com/in/alice/" },
      {},
    )) as { ok: boolean; error: string };
    assert.equal(result.ok, false, "T-QLG.1: ok=false for null coords");
    assert.ok(
      result.error.includes("server.url not configured"),
      `T-QLG.1: error contains 'server.url not configured'; got: ${result.error}`,
    );
  });

  it("T-QLG.2: with serverCoords + mocked fetch 200, execute returns the server JSON response", async () => {
    // Given: serverCoords set; global fetch mocked to return {allowed:true, lastTouchedBy:null, ...}
    // When:  execute({personRef:"https://www.linkedin.com/in/alice/"})
    // Then:  returns {allowed:true, lastTouchedBy:null, lastTouchedTs:null, reason:null}
    const mockResponse = { allowed: true, lastTouchedBy: null, lastTouchedTs: null, reason: null };
    // biome-ignore lint/suspicious/noExplicitAny: global override
    const origFetch = (globalThis as any).fetch;
    // biome-ignore lint/suspicious/noExplicitAny: global override
    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });
    try {
      const tool = makeQueryLeadGloballyTool(COORDS);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = await (tool.execute as (a: unknown, o: object) => Promise<any>)(
        { personRef: "https://www.linkedin.com/in/alice/" },
        {},
      );
      assert.deepEqual(result, mockResponse, "T-QLG.2: returns server JSON verbatim");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
    }
  });

  it("T-QLG.3: with serverCoords + mocked fetch returning HTTP 500, execute returns {ok:false, error:'server returned HTTP 500'}", async () => {
    // Given: serverCoords set; fetch mocked to return status 500
    // When:  execute({personRef: ...})
    // Then:  {ok:false, error:"server returned HTTP 500"}
    // biome-ignore lint/suspicious/noExplicitAny: global override
    const origFetch = (globalThis as any).fetch;
    // biome-ignore lint/suspicious/noExplicitAny: global override
    (globalThis as any).fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    try {
      const tool = makeQueryLeadGloballyTool(COORDS);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = await (tool.execute as (a: unknown, o: object) => Promise<any>)(
        { personRef: "https://www.linkedin.com/in/alice/" },
        {},
      );
      assert.deepEqual(
        result,
        { ok: false, error: "server returned HTTP 500" },
        "T-QLG.3: returns 500 error envelope",
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
    }
  });

  it("T-QLG.4: with serverCoords + fetch throwing (AbortError / network failure), execute returns {ok:false, error:'server unreachable...'}", async () => {
    // Given: serverCoords set; fetch mocked to throw AbortError
    // When:  execute({personRef: ...})
    // Then:  {ok:false, error: starts with "server unreachable"}
    // biome-ignore lint/suspicious/noExplicitAny: global override
    const origFetch = (globalThis as any).fetch;
    const abortErr = new DOMException("The operation was aborted", "AbortError");
    // biome-ignore lint/suspicious/noExplicitAny: global override
    (globalThis as any).fetch = async () => {
      throw abortErr;
    };
    try {
      const tool = makeQueryLeadGloballyTool(COORDS);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = await (tool.execute as (a: unknown, o: object) => Promise<any>)(
        { personRef: "https://www.linkedin.com/in/alice/" },
        {},
      );
      assert.equal((result as { ok: boolean }).ok, false, "T-QLG.4: ok=false");
      assert.ok(
        (result as { error: string }).error.startsWith("server unreachable"),
        `T-QLG.4: error starts with 'server unreachable'; got: ${(result as { error: string }).error}`,
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
    }
  });

  it("T-QLG.5: 'query_lead_globally' is in IDEMPOTENT_TOOLS set", () => {
    // Given: IDEMPOTENT_TOOLS from src/agent/retryWrapper.ts
    // When:  check membership
    // Then:  IDEMPOTENT_TOOLS.has("query_lead_globally") === true
    assert.ok(IDEMPOTENT_TOOLS.has("query_lead_globally"), "T-QLG.5: query_lead_globally in IDEMPOTENT_TOOLS");
  });
});
