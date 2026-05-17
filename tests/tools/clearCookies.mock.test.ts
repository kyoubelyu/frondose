/**
 * P-28.5 Step 5 — T-CC.1..3
 *
 * Tests for clear_cookies worker tool (src/tools/linkedin/clearCookies.ts).
 * Gate coverage: G-P28.5.4 (no-origins → clearBrowserCookies once),
 *                G-P28.5.5 (origins list → clearOriginData per origin),
 *                G-P28.5.6 (session error → fail envelope)
 *
 * DI surface: makeClearCookiesTool(session) — fake session with fake CdpClient
 * that records clearBrowserCookies() / clearOriginData() calls.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import { makeClearCookiesTool } from "../../src/tools/browser/clearCookies.js";

// ─── Fake session helpers ──────────────────────────────────────────────────────

function makeFakeHandle() {
  const clearBrowserCookiesCalls: number[] = [];
  const clearOriginDataCalls: string[] = [];
  const handle = {
    Network: {
      enable: async () => {},
      clearBrowserCookies: async () => {
        clearBrowserCookiesCalls.push(Date.now());
      },
    },
    Storage: {
      clearDataForOrigin: async (args: { origin: string; storageTypes: string }) => {
        clearOriginDataCalls.push(args.origin);
      },
    },
    Runtime: {
      evaluate: async (_args: unknown) => ({ result: { type: "string", value: "https://example.com" } }),
    },
    _ws: { readyState: 1 },
    close: async () => {},
  };
  return { handle, clearBrowserCookiesCalls, clearOriginDataCalls };
}

function makeSuccessSession() {
  const { handle, clearBrowserCookiesCalls, clearOriginDataCalls } = makeFakeHandle();
  const client = CdpClient.fromHandle(handle);
  const session = {
    inputMode: "cdp" as const,
    getOrInitClient: async () => ({ ok: true as const, client }),
    getClient: () => client,
    heartbeat: async () => true,
    setLastContext: () => {},
    getLastContext: () => undefined,
  };
  return { session, clearBrowserCookiesCalls, clearOriginDataCalls };
}

function makeFailSession() {
  return {
    inputMode: "cdp" as const,
    getOrInitClient: async () => ({
      ok: false as const,
      error: "chrome_unavailable" as const,
      message: "mock: no chrome",
    }),
    getClient: () => undefined,
    heartbeat: async () => false,
    setLastContext: () => {},
    getLastContext: () => undefined,
  };
}

// ─── T-CC.1 ───────────────────────────────────────────────────────────────────

describe("clear_cookies: no origins → clearBrowserCookies called once (G-P28.5.4)", () => {
  it("T-CC.1: given fake session with ok client, when execute({}) (no origins), clearBrowserCookies called once; clearOriginData NOT called", async () => {
    // Given: fake CdpClient recording clearBrowserCookies + clearOriginData calls
    //        fake session with getOrInitClient → {ok:true, client}
    // When:  makeClearCookiesTool(session).execute({})
    // Then:  clearBrowserCookiesCalls.length === 1; clearOriginDataCalls.length === 0
    //        result.ok===true; result.data.cleared==="all"
    const { session, clearBrowserCookiesCalls, clearOriginDataCalls } = makeSuccessSession();
    const tool = makeClearCookiesTool(session);
    const result = await tool.execute({}, { messages: [], toolCallId: "cc1" });
    assert.equal(clearBrowserCookiesCalls.length, 1, "T-CC.1: clearBrowserCookies called once");
    assert.equal(clearOriginDataCalls.length, 0, "T-CC.1: clearOriginData not called");
    assert.ok((result as { ok: boolean }).ok === true, "T-CC.1: result.ok===true");
    assert.equal(
      (result as { data?: { cleared?: unknown } }).data?.cleared,
      "all",
      "T-CC.1: cleared==='all'",
    );
  });
});

// ─── T-CC.2 ───────────────────────────────────────────────────────────────────

describe("clear_cookies: origins list → clearOriginData per origin (G-P28.5.5)", () => {
  it("T-CC.2: given execute({origins:['https://accounts.google.com','https://www.linkedin.com']}), clearOriginData called once per origin; clearBrowserCookies NOT called", async () => {
    // Given: fake CdpClient recording clearOriginData calls
    // When:  execute({origins:["https://accounts.google.com","https://www.linkedin.com"]})
    // Then:  clearOriginDataCalls === ["https://accounts.google.com","https://www.linkedin.com"]
    //        clearBrowserCookiesCalls.length === 0; result.ok===true
    const { session, clearBrowserCookiesCalls, clearOriginDataCalls } = makeSuccessSession();
    const tool = makeClearCookiesTool(session);
    const result = await tool.execute(
      { origins: ["https://accounts.google.com", "https://www.linkedin.com"] },
      { messages: [], toolCallId: "cc2" },
    );
    assert.deepEqual(
      clearOriginDataCalls,
      ["https://accounts.google.com", "https://www.linkedin.com"],
      "T-CC.2: clearOriginData called for each origin in order",
    );
    assert.equal(clearBrowserCookiesCalls.length, 0, "T-CC.2: clearBrowserCookies not called");
    assert.ok((result as { ok: boolean }).ok === true, "T-CC.2: result.ok===true");
  });
});

// ─── T-CC.3 ───────────────────────────────────────────────────────────────────

describe("clear_cookies: session error → fail envelope (G-P28.5.6)", () => {
  it("T-CC.3: given session whose getOrInitClient returns {ok:false}, when execute, result is a fail envelope (no throw)", async () => {
    // Given: fake session with getOrInitClient → {ok:false, error:'chrome_unavailable'}
    // When:  makeClearCookiesTool(session).execute({})
    // Then:  result.ok === false; no throw
    const session = makeFailSession();
    const tool = makeClearCookiesTool(session);
    const result = await tool.execute({}, { messages: [], toolCallId: "cc3" });
    assert.equal((result as { ok: boolean }).ok, false, "T-CC.3: result.ok===false");
    assert.equal(
      (result as { error?: string }).error,
      "chrome_unavailable",
      "T-CC.3: chrome_unavailable error passed through",
    );
  });
});
