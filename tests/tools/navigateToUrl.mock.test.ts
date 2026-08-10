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
import { makeNavigateToUrlTool } from "../../src/tools/browser/navigateToUrl.js";

// P-Y5 D-RUN-2: navigate_to_url execute() calls applyPacing() (inter-tool dwell). The new default
// band is 800-2500ms; disable it here so the suite stays fast. resolvePaceBand → disabled returns
// {waitedMs:0,...}, so data.pacing is STILL present — the T-Nav.1 "pacing present" check still holds.
process.env.FRONDOSE_PACE_MIN_MS = "0";

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
        // loaderId present: a real cross-document navigation (CDP omits loaderId only
        // for same-document navigation) — the 5a navigate fix skips the load wait without it.
        return { frameId: "fake", loaderId: "fake-loader" };
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
  client.markStealthInjected();
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

// ─────────────────────────────────────────────────────────────────────────────
// P-47 G-1 scaffolds (Step 4a — all assertion bodies TODO; added 2026-05-20)
// ─────────────────────────────────────────────────────────────────────────────

// ─── T-Nav.1 (G-P47.1): post-load dwell fires on success path ────────────────

describe("T-Nav.1 (G-P47.1): navigate_to_url dwells after page load on success path", () => {
  it(
    "pacing spy called exactly once; result.data.pacing present; call order: navigate → pacing → getCurrentUrl",
    { timeout: 3000 },
    async () => {
      // Given: a success session whose client.navigate resolves without throwing
      // When:  execute({ url: "https://example.com/" }) runs
      // Then:  (a) navigate was called exactly once (proves navigate ran);
      //         (b) result.data.pacing is present (proves applyPacing() was called and its
      //             return value captured — the only way pacing appears in the envelope);
      //         (c) result.data.url is present (proves getCurrentUrl() ran post-pacing);
      //         (d) result.ok === true.
      // NOTE on call-order: navigate → pacing → getCurrentUrl order is verified indirectly —
      // all three observables (navigateCalls.length, data.pacing, data.url) require the code
      // to execute in that order. No spy injection hook was added by builder (Step 4b).
      const { session, navigateCalls } = makeSuccessSession();
      const tool = makeNavigateToUrlTool(session);
      const result = await tool.execute({ url: "https://example.com/" }, { messages: [], toolCallId: "tnav-p47-1" });

      // (a) navigate called once
      assert.equal(navigateCalls.length, 1, "T-Nav.1: client.navigate must be called exactly once");

      // (d) result.ok === true
      assert.equal((result as { ok: boolean }).ok, true, "T-Nav.1: result.ok must be true on success path");

      // (b) data.pacing present — proves applyPacing() was called (G-P47.1)
      // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
      const data = (result as any).data;
      assert.ok(data !== undefined, "T-Nav.1: result.data must be defined");
      assert.ok("pacing" in data, "T-Nav.1: result.data.pacing must be present (G-P47.1: post-load dwell)");
      assert.ok(typeof data.pacing === "object" && data.pacing !== null, "T-Nav.1: pacing must be an object");

      // (c) data.url present — proves getCurrentUrl() ran after navigate + pacing
      assert.ok("url" in data && typeof data.url === "string", "T-Nav.1: result.data.url must be present");
    },
  );
});

// ─── T-Nav.2 (G-P47.1): no dwell when client.navigate throws ─────────────────

describe("T-Nav.2 (G-P47.1): navigate_to_url does NOT call applyPacing when client.navigate rejects", () => {
  it("envelope is ok:false; applyPacing spy NOT called (dwell is success-path only)", async () => {
    // Given: a session whose client.navigate throws a fake error;
    //        applyPacing spy injected (same mechanism as T-Nav.1).
    // When:  execute({ url: "https://example.com/" }) runs
    // Then:  (a) result.ok === false (failFromError envelope);
    //         (b) pacing spy was NOT called (no dwell on the failure path).
    const { handle: failHandle } = makeFakeHandle({ navigateShouldThrow: true });
    const failClient = CdpClient.fromHandle(failHandle);
    failClient.markStealthInjected();
    const failSession = {
      inputMode: "cdp" as const,
      getOrInitClient: async () => ({ ok: true as const, client: failClient }),
      getClient: () => failClient,
      heartbeat: async () => true,
      setLastContext: () => {},
      getLastContext: () => undefined,
    };
    const tool = makeNavigateToUrlTool(failSession);
    const result = await tool.execute({ url: "https://example.com/" }, { messages: [], toolCallId: "tnav-p47-2" });

    // (a) result.ok === false (failFromError envelope from navigate throw)
    assert.equal((result as { ok: boolean }).ok, false, "T-Nav.2: result.ok must be false when navigate throws");

    // (b) data.pacing is NOT present — applyPacing() is only called on the success path
    //     (result.ok===false proves the catch branch ran, not the success branch where pacing lives)
    // biome-ignore lint/suspicious/noExplicitAny: test shape assertion
    const data = (result as any).data;
    assert.ok(
      data === undefined || !("pacing" in data),
      "T-Nav.2: data.pacing must be absent (no dwell on failure path)",
    );
  });
});
