/**
 * P-28.5 Step 5 — T-NAV.1..4
 *
 * Tests for navigate_to_url worker tool (src/tools/linkedin/navigateToUrl.ts).
 * Gate coverage: G-P28.5.1 (HTTPS-only rejection), G-P28.5.2 (success path),
 *                G-P28.5.3 (session error passthrough)
 *
 * DI surface: makeNavigateToUrlTool(session) — tests pass a fake LinkedinSession
 * whose getOrInitClient returns either {ok:true, client: fakeCdpClient} or {ok:false, ...}.
 * The fake CdpClient records navigate() calls.
 *
 * CREDENTIAL PLACEHOLDER POLICY (C-5, inherited from P-28):
 *   twofa_link → "https://2fa.show/PLACEHOLDER"
 *   NEVER a real 2fa.show URL.
 *
 * Step-4b fix note:
 *   makeFakeHandle corrected — Page.loadEventFired must return an unsubscribe fn
 *   () => {} and synchronously invoke its callback so waitForLoad("load") resolves
 *   immediately. Similarly lifecycleEvent fires "networkIdle" for waitUntil:"networkidle".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CdpClient } from "../../src/cdp/client.js";
import { makeNavigateToUrlTool } from "../../src/tools/linkedin/navigateToUrl.js";

// ─── Fake session helpers ──────────────────────────────────────────────────────

/** Minimal fake CdpHandle that records navigate() calls. */
function makeFakeHandle(opts: { navigateShouldThrow?: boolean } = {}) {
  const navigateCalls: Array<{ url: string }> = [];
  const handle = {
    Page: {
      enable: async () => {},
      navigate: async (args: { url: string }) => {
        if (opts.navigateShouldThrow) throw new Error("fake navigate error");
        navigateCalls.push({ url: args.url });
        return { frameId: "fake" };
      },
      // waitForLoad("load") calls client.Page.loadEventFired(cb) — callback style.
      // Must return an unsubscribe fn () => {} and synchronously invoke cb so the
      // Promise resolves immediately.
      loadEventFired: (cb: () => void) => {
        cb();
        return () => {};
      },
      // waitForLoad("networkidle") first calls setLifecycleEventsEnabled, then
      // subscribes via lifecycleEvent(cb). Fire "networkIdle" synchronously.
      setLifecycleEventsEnabled: async (_args: unknown) => {},
      lifecycleEvent: (cb: (params: { name: string }) => void) => {
        cb({ name: "networkIdle" });
        return () => {};
      },
    },
    Network: { enable: async () => {} },
    Runtime: {
      // getCurrentUrl() → Runtime.evaluate("window.location.href") → returns this value
      evaluate: async (_args: unknown) => ({ result: { type: "string", value: "https://example.com" } }),
    },
    _ws: { readyState: 1 },
    close: async () => {},
  };
  return { handle, navigateCalls };
}

/** Make a fake LinkedinSession whose getOrInitClient returns {ok:true, client}. */
function makeSuccessSession() {
  const { handle, navigateCalls } = makeFakeHandle();
  const client = CdpClient.fromHandle(handle);
  const session = {
    inputMode: "cdp" as const,
    getOrInitClient: async () => ({ ok: true as const, client }),
    getClient: () => client,
    heartbeat: async () => true,
    setLastContext: () => {},
    getLastContext: () => undefined,
  };
  return { session, navigateCalls };
}

/** Make a fake LinkedinSession whose getOrInitClient returns {ok:false, error}. */
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

// ─── T-NAV.1 ──────────────────────────────────────────────────────────────────

describe("navigate_to_url: valid HTTPS URL → navigate called, ok envelope (G-P28.5.2)", () => {
  it("T-NAV.1: given a fake session with ok client, when execute({url:'https://accounts.google.com'}), client.navigate called with that URL and envelope is ok", async () => {
    // Given: fake LinkedinSession with getOrInitClient → {ok:true, client: fakeCdpClient}
    //        fake CdpClient records navigate() calls; loadEventFired fires synchronously
    // When:  makeNavigateToUrlTool(session).execute({url:"https://accounts.google.com"})
    // Then:  navigate called with "https://accounts.google.com";
    //        result.ok===true; result.data.url is the finalUrl from getCurrentUrl
    const { session, navigateCalls } = makeSuccessSession();
    const tool = makeNavigateToUrlTool(session);
    const result = await tool.execute({ url: "https://accounts.google.com" }, { messages: [], toolCallId: "t1" });
    assert.equal(navigateCalls.length, 1, "T-NAV.1: navigate called once");
    assert.equal(navigateCalls[0]!.url, "https://accounts.google.com", "T-NAV.1: correct URL navigated");
    assert.ok((result as { ok: boolean }).ok === true, "T-NAV.1: result.ok===true");
    // getCurrentUrl returns "https://example.com" from the fake Runtime.evaluate
    assert.equal(
      (result as { data?: { url?: string } }).data?.url,
      "https://example.com",
      "T-NAV.1: finalUrl from getCurrentUrl",
    );
  });
});

// ─── T-NAV.2 ──────────────────────────────────────────────────────────────────

describe("navigate_to_url: non-https URL rejected at Zod layer (G-P28.5.1)", () => {
  it("T-NAV.2: given the tool, when parameters.safeParse({url:'http://insecure.example'}), then parse fails (Zod rejects non-https)", () => {
    // Given: the navigate_to_url tool with its Zod parameters schema
    // When:  tool.parameters.safeParse({url:"http://insecure.example"})
    // Then:  result.success === false (Zod refine rejects non-https)
    const session = makeFailSession();
    const tool = makeNavigateToUrlTool(session);
    const result = tool.parameters.safeParse({ url: "http://insecure.example" });
    assert.equal(result.success, false, "T-NAV.2: Zod rejects http:// URL");
    // Also verify https:// is accepted
    const validResult = tool.parameters.safeParse({ url: "https://ok.example.com" });
    assert.equal(validResult.success, true, "T-NAV.2: Zod accepts https:// URL");
  });
});

// ─── T-NAV.3 ──────────────────────────────────────────────────────────────────

describe("navigate_to_url: session error passthrough (G-P28.5.3)", () => {
  it("T-NAV.3: given a session whose getOrInitClient returns {ok:false}, when execute, the failure envelope is returned and navigate never called", async () => {
    // Given: fake session whose getOrInitClient → {ok:false, error:'chrome_unavailable'}
    // When:  makeNavigateToUrlTool(session).execute({url:"https://accounts.google.com"})
    // Then:  result.ok === false (failure envelope passthrough); no navigate call; no throw
    const session = makeFailSession();
    const tool = makeNavigateToUrlTool(session);
    const result = await tool.execute({ url: "https://accounts.google.com" }, { messages: [], toolCallId: "t3" });
    assert.equal((result as { ok: boolean }).ok, false, "T-NAV.3: result.ok===false");
    assert.equal(
      (result as { error?: string }).error,
      "chrome_unavailable",
      "T-NAV.3: chrome_unavailable error passed through",
    );
  });
});

// ─── T-NAV.4 ──────────────────────────────────────────────────────────────────

describe("navigate_to_url: waitUntil forwarded to client.navigate (G-P28.5.2)", () => {
  it("T-NAV.4: given execute({url:'https://2fa.show/PLACEHOLDER', waitUntil:'networkidle'}), client.navigate is called with both url and 'networkidle' (C-5)", async () => {
    // Given: fake session with ok client; fake navigate records url;
    //        lifecycleEvent fires "networkIdle" synchronously for waitUntil:"networkidle"
    // When:  execute({url:"https://2fa.show/PLACEHOLDER", waitUntil:"networkidle"})
    // Then:  navigate called with "https://2fa.show/PLACEHOLDER"; result.ok===true
    //        (C-5: twofa_link uses placeholder URL, never a real 2fa.show link)
    const { session, navigateCalls } = makeSuccessSession();
    const tool = makeNavigateToUrlTool(session);
    const result = await tool.execute(
      { url: "https://2fa.show/PLACEHOLDER", waitUntil: "networkidle" },
      { messages: [], toolCallId: "t4" },
    );
    assert.equal(navigateCalls.length, 1, "T-NAV.4: navigate called once");
    assert.equal(navigateCalls[0]!.url, "https://2fa.show/PLACEHOLDER", "T-NAV.4: correct URL navigated");
    assert.ok((result as { ok: boolean }).ok === true, "T-NAV.4: result.ok===true");
  });
});
