/**
 * P-26 Step 5 — T-PE.1..4
 *
 * Tests for publish_event tool (makePublishEventTool).
 * Gate coverage: G-P26.20
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IDEMPOTENT_TOOLS } from "../../src/agent/retryWrapper.js";
import { makePublishEventTool } from "../../src/tools/server/publishEvent.js";

const COORDS = { serverUrl: "http://127.0.0.1:19999", token: "test-token", workerId: "w1" };

describe("publish_event tool (G-P26.20)", () => {
  it("T-PE.1: with serverCoords=null, execute returns {ok:false, error:'server.url not configured; publish_event is a no-op.'}", async () => {
    // Given: makePublishEventTool(null)
    // When:  execute({type:"outreach_sent"})
    // Then:  {ok:false, error:"server.url not configured; publish_event is a no-op."}
    const tool = makePublishEventTool(null);
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const result = await (tool.execute as (a: unknown, o: object) => Promise<any>)({ type: "outreach_sent" }, {});
    assert.deepEqual(
      result,
      {
        ok: false,
        error: "server.url not configured; publish_event is a no-op.",
      },
      "T-PE.1: expected null-coords error envelope",
    );
  });

  it("T-PE.2: with serverCoords + mocked fetch 200, execute returns {ok:true}", async () => {
    // Given: serverCoords set; fetch mocked to return status 200, body {ok:true,id:1}
    // When:  execute({type:"outreach_sent", data:{person:"alice"}})
    // Then:  {ok:true}
    // biome-ignore lint/suspicious/noExplicitAny: global override
    const origFetch = (globalThis as any).fetch;
    // biome-ignore lint/suspicious/noExplicitAny: global override
    (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, id: 1 }) });
    try {
      const tool = makePublishEventTool(COORDS);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = await (tool.execute as (a: unknown, o: object) => Promise<any>)(
        { type: "outreach_sent", data: { person: "alice" } },
        {},
      );
      assert.deepEqual(result, { ok: true }, "T-PE.2: {ok:true} on success");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
    }
  });

  it("T-PE.3: with serverCoords + fetch throwing, execute returns {ok:true, warning:'server unreachable...'} (fire-and-forget)", async () => {
    // Given: serverCoords set; fetch mocked to throw network error
    // When:  execute({type:"x"})
    // Then:  {ok:true, warning: string containing "server unreachable, event dropped"}
    // biome-ignore lint/suspicious/noExplicitAny: global override
    const origFetch = (globalThis as any).fetch;
    // biome-ignore lint/suspicious/noExplicitAny: global override
    (globalThis as any).fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    try {
      const tool = makePublishEventTool(COORDS);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = (await (tool.execute as (a: unknown, o: object) => Promise<any>)({ type: "x" }, {})) as {
        ok: boolean;
        warning: string;
      };
      assert.equal(result.ok, true, "T-PE.3: ok=true even on server failure");
      assert.ok(
        result.warning.includes("server unreachable, event dropped"),
        `T-PE.3: warning contains 'server unreachable, event dropped'; got: ${result.warning}`,
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (globalThis as any).fetch = origFetch;
    }
  });

  it("T-PE.4: 'publish_event' is NOT in IDEMPOTENT_TOOLS (fire-and-forget, double-fire risks double-event)", () => {
    // Given: IDEMPOTENT_TOOLS from src/agent/retryWrapper.ts
    // When:  check membership
    // Then:  IDEMPOTENT_TOOLS.has("publish_event") === false
    assert.ok(!IDEMPOTENT_TOOLS.has("publish_event"), "T-PE.4: publish_event must NOT be in IDEMPOTENT_TOOLS");
  });
});
