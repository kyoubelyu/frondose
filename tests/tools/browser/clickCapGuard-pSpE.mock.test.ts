/**
 * P-SP-E Step 5 — T-E.CapGuard.1..5 (G-PSPE.17 NEW — Sketch I / BLOCKER-2) — assertions filled.
 * click.ts cap-aware Auto guard: hard-rejects over-cap outbound BEFORE CDP dispatch.
 *
 * STEP 5 FIX (surface): The scaffold used clickSurface="linkedin-connect" which is NOT
 * in LINKEDIN_OUTBOUND_SURFACES = {"feed","profile","network","search","company","messaging",
 * "messaging-thread","notifications"}. With a non-member surface, the cap guard is unreachable
 * (code path: LINKEDIN_OUTBOUND_SURFACES.has(clickSurface) === false → guard skipped).
 * Fixed: use clickSurface="search" (a real LinkedIn outbound surface) so the cap guard fires.
 *
 * Also sets MAI_PACE_MIN_MS=0 to disable 0.8-2.5s pacing jitter in test runs.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/browser/clickCapGuard-pSpE.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: mock session shape
type AnyObj = Record<string, any>;

// Disable pacing so tests don't sleep 0.8-2.5s per click
process.env.MAI_PACE_MIN_MS = "0";
process.env.MAI_PACE_MAX_MS = "0";

// Helper: create a mock LinkedinSession with configurable autoRun() + CDP client spy
// NOTE: clickSurface changed from "linkedin-connect" to "search" (a valid LINKEDIN_OUTBOUND_SURFACES member).
function makeMockSession(opts: {
  autoRun?: (() => { runId: string; maxConnects: number | null; connectSentCount: number } | null) | undefined;
  clickSurface?: string;
  clickLabel?: string;
  clickAtSpy?: { called: boolean };
}): AnyObj {
  const { autoRun, clickSurface = "search", clickLabel = "Connect", clickAtSpy } = opts;

  const fakeRef = "@e1";
  const fakeClient = {
    clickAt: async (_ref: string) => {
      if (clickAtSpy) clickAtSpy.called = true;
    },
    getBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    // [P-75 D-17] CdpClient.verifyRef stub — click.ts checks ref staleness before dispatch.
    // The fake client must provide it or click returns runtime_error: 'verifyRef is not a function'.
    // Default behavior: matches=true (no staleness), so cap-guard test stays focused on cap logic.
    verifyRef: async (_refKey: string, _expected: { role: string; name?: string }) => ({ matches: true }),
  };

  return {
    getOrInitClient: async () => ({ ok: true, client: fakeClient }),
    getLastContext: () => ({
      surface: clickSurface,
      entries: [{ ref: fakeRef, name: clickLabel, role: "button", clickable: true }],
    }),
    showAgentTarget: undefined,
    canClickOutbound: undefined, // P-63 guard disabled (undefined = falsy → guard skipped)
    inputMode: "cdp",
    // P-SP-E Sketch I: optional autoRun probe
    autoRun: autoRun,
  };
}

describe("T-E.CapGuard — click.ts cap-aware Auto guard (P-SP-E Sketch I / G-PSPE.17)", () => {
  // ─── T-E.CapGuard.1 ──────────────────────────────────────────────────────────
  it("T-E.CapGuard.1: autoRun returns {maxConnects:1, connectSentCount:0} + Connect click → click proceeds (under-cap)", async () => {
    // Given: session.autoRun() = {runId:'r1', maxConnects:1, connectSentCount:0} (under cap)
    // When:  makeClickTool(session).execute({label:'Connect'}) on LinkedIn search surface
    // Then:  returned envelope ok=true; client.clickAt spy was invoked (click dispatched)
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      autoRun: () => ({ runId: "r1", maxConnects: 1, connectSentCount: 0 }),
      clickSurface: "search",
      clickLabel: "Connect",
      clickAtSpy,
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: pre-builder stub
    const makeClickTool: any = mod?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.ok(false, "T-E.CapGuard.1: makeClickTool not importable — check import path");
      return;
    }

    const result = await makeClickTool(session).execute({ label: "Connect" });
    assert.ok(
      result.ok === true,
      `T-E.CapGuard.1: under-cap click must return ok=true; got: ${JSON.stringify(result)}`,
    );
    assert.ok(
      clickAtSpy.called === true,
      "T-E.CapGuard.1: client.clickAt spy must have been invoked (click was dispatched)",
    );
  });

  // ─── T-E.CapGuard.2 ──────────────────────────────────────────────────────────
  it("T-E.CapGuard.2: autoRun returns {maxConnects:1, connectSentCount:1} (at cap) + Connect click → returns {ok:false, error.kind:'invalid_input'}; clickAt spy NOT invoked", async () => {
    // Given: session.autoRun() = {runId:'r1', maxConnects:1, connectSentCount:1} (AT cap: sent === max)
    // When:  makeClickTool(session).execute({label:'Connect'}) on LinkedIn search surface
    // Then:  returned envelope ok=false; error.kind === 'invalid_input';
    //        error.message matches /Auto cap reached/;
    //        client.clickAt spy was NEVER invoked (hard reject before CDP dispatch)
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      autoRun: () => ({ runId: "r1", maxConnects: 1, connectSentCount: 1 }),
      clickSurface: "search",
      clickLabel: "Connect",
      clickAtSpy,
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: any = mod?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.ok(false, "T-E.CapGuard.2: makeClickTool not importable");
      return;
    }

    const result = await makeClickTool(session).execute({ label: "Connect" });
    assert.ok(result.ok === false, `T-E.CapGuard.2: at-cap click must return ok=false; got: ${JSON.stringify(result)}`);
    assert.ok(
      result.error?.kind === "invalid_input" || result.error?.kind === "policy_violation",
      `T-E.CapGuard.2: error.kind must be 'invalid_input' or 'policy_violation'; got: ${JSON.stringify(result.error)}`,
    );
    assert.ok(
      /Auto cap reached/i.test(result.error?.message ?? ""),
      `T-E.CapGuard.2: error.message must match /Auto cap reached/i; got: "${result.error?.message}"`,
    );
    assert.ok(
      clickAtSpy.called === false,
      "T-E.CapGuard.2: client.clickAt spy must NOT have been invoked (hard reject before CDP)",
    );
  });

  // ─── T-E.CapGuard.3 ──────────────────────────────────────────────────────────
  it("T-E.CapGuard.3: autoRun returns null (no Auto run active) → click proceeds normally (cap guard is no-op)", async () => {
    // Given: session.autoRun() returns null (not in an Auto run)
    // When:  makeClickTool(session).execute({label:'Connect'}) called
    // Then:  cap guard skipped; click proceeds; clickAt spy invoked; envelope ok=true
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      autoRun: () => null,
      clickSurface: "search",
      clickLabel: "Connect",
      clickAtSpy,
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: any = mod?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.ok(false, "T-E.CapGuard.3: makeClickTool not importable");
      return;
    }

    const result = await makeClickTool(session).execute({ label: "Connect" });
    assert.ok(
      result.ok === true,
      `T-E.CapGuard.3: null autoRun → click must proceed (ok=true); got: ${JSON.stringify(result)}`,
    );
    assert.ok(
      clickAtSpy.called === true,
      "T-E.CapGuard.3: client.clickAt spy must have been invoked (no cap guard when autoRun=null)",
    );
  });

  // ─── T-E.CapGuard.4 ──────────────────────────────────────────────────────────
  it("T-E.CapGuard.4: autoRun returns {maxConnects:null} (no cap configured) → click proceeds even at high connectSentCount (no cap to exceed)", async () => {
    // Given: session.autoRun() = {runId:'r1', maxConnects:null, connectSentCount:999} (no cap)
    // When:  makeClickTool(session).execute({label:'Connect'}) called
    // Then:  cap guard does NOT fire (maxConnects===null means no cap);
    //        click proceeds normally; clickAt spy invoked
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      autoRun: () => ({ runId: "r1", maxConnects: null, connectSentCount: 999 }),
      clickSurface: "search",
      clickLabel: "Connect",
      clickAtSpy,
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: any = mod?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.ok(false, "T-E.CapGuard.4: makeClickTool not importable");
      return;
    }

    const result = await makeClickTool(session).execute({ label: "Connect" });
    assert.ok(
      result.ok === true,
      `T-E.CapGuard.4: maxConnects=null → click must proceed (ok=true); got: ${JSON.stringify(result)}`,
    );
    assert.ok(
      clickAtSpy.called === true,
      "T-E.CapGuard.4: clickAt spy must have been invoked (null maxConnects = no cap)",
    );
  });

  // ─── T-E.CapGuard.5 ──────────────────────────────────────────────────────────
  // [P-AUTO-1+2 REVISED] Updated comments: 'Send' is now classified as 'message_send'
  // by classifyOutboundLabel() — it is still NOT in the connect cap scope, and this
  // test remains TRUE (the connect cap does not fire for message_send). The classifier
  // is the mechanism; the observed behavior (cap does not fire) is unchanged.
  it("T-E.CapGuard.5: click label is 'Send' (message_send class) → connect cap guard does NOT fire even at connect cap limit", async () => {
    // Given: session.autoRun() = {runId:'r1', maxConnects:1, connectSentCount:1} (at cap)
    //        BUT click label = 'Send' (classifies as message_send — not connect-type)
    // When:  makeClickTool(session).execute({label:'Send'}) called
    // Then:  connect cap guard does NOT fire (classifyOutboundLabel('Send')='message_send');
    //        click proceeds normally; clickAt spy invoked
    //        NOTE: P-AUTO-1+2 hard-gates CONNECT-TYPE outbound only; message_send gating is a later phase.
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      autoRun: () => ({ runId: "r1", maxConnects: 1, connectSentCount: 1 }),
      clickSurface: "search",
      clickLabel: "Send",
      clickAtSpy,
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: any = mod?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.ok(false, "T-E.CapGuard.5: makeClickTool not importable");
      return;
    }

    const result = await makeClickTool(session).execute({ label: "Send" });
    assert.ok(
      result.ok === true,
      `T-E.CapGuard.5: 'Send' label → cap guard must NOT fire; got: ${JSON.stringify(result)}`,
    );
    assert.ok(
      clickAtSpy.called === true,
      "T-E.CapGuard.5: clickAt spy must have been invoked ('Send' is not in connect cap scope)",
    );
  });
});
