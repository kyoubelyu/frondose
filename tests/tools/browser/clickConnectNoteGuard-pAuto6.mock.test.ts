/**
 * P-AUTO-6 Step 3 — Test Scaffold (outside-in TDD, all assertions TODO/failing)
 *
 * Layer C: click.ts guard for connectNoteRequiredForLabel seam (T-AUTO6.1-click, .2-click, .8)
 *
 * Mirrors the autoOutboundGuard.mock.test.ts makeMockSession+makeClickTool pattern.
 * The guard fires AFTER the daily/cooldown block (~:198) and BEFORE clickAt (:223).
 * Session seam: session.connectNoteRequiredForLabel?: (label, surface) => { block, reason? }
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/browser/clickConnectNoteGuard-pAuto6.mock.test.ts
 *
 * Builder seams required:
 *   - session.connectNoteRequiredForLabel wired in click.ts (§3.4 sketch)
 *   - makeClickTool(session) imported from src/tools/browser/click.ts
 *
 * Red-state intent: all behavioral assertions are TODO. makeClickTool import
 * succeeds (it already exists), but the guard code path does not exist yet,
 * so the behavioral assertions will fail at Step-5 fill time.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Disable pacing so tests don't sleep 0.8-2.5s per click
process.env.FRONDOSE_PACE_MIN_MS = "0";
process.env.FRONDOSE_PACE_MAX_MS = "0";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution
type AnyFn = (...args: any[]) => any;

// ─── Mock-session builder (mirrors autoOutboundGuard.mock.test.ts pattern) ───

/**
 * Build a mock session for the connect-note guard tests.
 * connectNoteRequired is injectable: supply { block, reason } or undefined.
 */
// biome-ignore lint/suspicious/noExplicitAny: mock session shape
function makeMockSession(opts: {
  clickLabel?: string;
  clickSurface?: string;
  clickAtSpy?: { called: boolean };
  connectNoteRequiredForLabel?: ((label: string, surface: string) => { block: boolean; reason?: string }) | undefined;
  // The guard fires AFTER the outbound approval gate; supply a passing autoRun+daily
  // so tests isolate only the connect-note guard behavior.
  autoRun?: (() => { runId: string; maxConnects: number | null; connectSentCount: number } | null) | undefined;
  dailyOutbound?: (() => { remaining: number; cooldownRemainingMs: number } | null) | undefined;
  canClickOutbound?: ((label: string, surface: string) => boolean) | undefined;
  resolvedMode?: (() => "manual" | "magical" | "auto") | undefined;
// biome-ignore lint/suspicious/noExplicitAny: mock return shape
}): Record<string, any> {
  const {
    clickLabel = "Invite Onder Temel to connect",
    clickSurface = "search",
    clickAtSpy,
    connectNoteRequiredForLabel,
    autoRun,
    dailyOutbound,
    canClickOutbound,
    resolvedMode,
  } = opts;

  const fakeRef = "@e1";
  const fakeClient = {
    clickAt: async (_ref: string) => {
      if (clickAtSpy) clickAtSpy.called = true;
    },
    getBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    verifyRef: async (_refKey: string, _expected: { role: string; name?: string }) => ({ matches: true }),
  };

  return {
    getOrInitClient: async () => ({ ok: true, client: fakeClient }),
    getLastContext: () => ({
      surface: clickSurface,
      entries: [{ ref: fakeRef, name: clickLabel, role: "button", clickable: true }],
    }),
    showAgentTarget: undefined,
    inputMode: "cdp",
    autoRun,
    dailyOutbound,
    canClickOutbound,
    resolvedMode,
    connectNoteRequiredForLabel,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// G-AUTO6.ClickGuard — connect-note guard in click.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("G-AUTO6.ClickGuard — click.ts connect-note guard (P-AUTO-6 §3.4)", () => {
  // ─── T-AUTO6.1-click — block path: seam returns block:true ───────────────
  it("T-AUTO6.1-click: connectNoteRequiredForLabel seam returns {block:true} → click returns reason='connect_note_required', clickAt NOT called", async () => {
    // Given: session.connectNoteRequiredForLabel = () => ({ block: true, reason: 'x' })
    //        and the outbound approval gates (autoRun/daily) are all passing
    //        click label='Invite Onder Temel to connect', surface='search'
    // When:  makeClickTool(session).execute({label:'Invite Onder Temel to connect'}) called
    // Then:  ok=false, result.reason='connect_note_required'; clickAt spy NOT called
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Invite Onder Temel to connect",
      clickSurface: "search",
      clickAtSpy,
      connectNoteRequiredForLabel: () => ({
        block: true,
        reason: 'a connect_note draft exists for "Onder Temel" — open profile to attach the note',
      }),
      // Provide a passing autoRun+daily so the guard is reached; canClickOutbound=true
      autoRun: () => ({ runId: "r1", maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
      resolvedMode: () => "auto",
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.fail("T-AUTO6.1-click: makeClickTool not importable from src/tools/browser/click.ts");
    }

    const result = await makeClickTool(session).execute({ label: "Invite Onder Temel to connect" });
    assert.equal(result.ok, false, "block=true must return ok=false");
    assert.ok(
      result.reason === "connect_note_required" || result.error?.reason === "connect_note_required",
      `must have reason='connect_note_required'; got: ${JSON.stringify(result)}`,
    );
    assert.equal(clickAtSpy.called, false, "clickAt must NOT be called when blocked");
  });

  // ─── T-AUTO6.2-click — pass path: seam returns block:false → click proceeds ─
  it("T-AUTO6.2-click: connectNoteRequiredForLabel seam returns {block:false} → click dispatches (clickAt called)", async () => {
    // Given: session.connectNoteRequiredForLabel = () => ({ block: false })
    //        all other gates pass (autoRun+daily OK), label='Invite Jane Roe to connect', surface='search'
    // When:  makeClickTool(session).execute({label:'Invite Jane Roe to connect'}) called
    // Then:  ok=true; clickAt spy IS called (no block)
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Invite Jane Roe to connect",
      clickSurface: "search",
      clickAtSpy,
      connectNoteRequiredForLabel: () => ({ block: false }),
      autoRun: () => ({ runId: "r1", maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
      resolvedMode: () => "auto",
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.fail("T-AUTO6.2-click: makeClickTool not importable");
    }

    const result = await makeClickTool(session).execute({ label: "Invite Jane Roe to connect" });
    assert.equal(result.ok, true, "block=false must return ok=true (click proceeds)");
    assert.equal(clickAtSpy.called, true, "clickAt must be called when not blocked");
  });

  // ─── T-AUTO6.8 — seam undefined → guard chains away, click proceeds ──────
  it("T-AUTO6.8: session.connectNoteRequiredForLabel undefined → guard is a no-op, click proceeds (seam not wired = safe degradation)", async () => {
    // Given: session.connectNoteRequiredForLabel is undefined (not wired in REPL/test/server)
    //        all other gates pass, label='Invite Jane Roe to connect', surface='search'
    // When:  makeClickTool(session).execute({label:'Invite Jane Roe to connect'}) called
    // Then:  click proceeds normally (ok=true); no throw; clickAt called
    //        mirrors the canClickOutbound optional-seam pattern
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Invite Jane Roe to connect",
      clickSurface: "search",
      clickAtSpy,
      connectNoteRequiredForLabel: undefined, // explicitly unwired
      autoRun: () => ({ runId: "r1", maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
      resolvedMode: () => "auto",
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.fail("T-AUTO6.8: makeClickTool not importable");
    }

    const result = await makeClickTool(session).execute({ label: "Invite Jane Roe to connect" });
    assert.equal(result.ok, true, "undefined seam must not block — click proceeds");
    assert.equal(clickAtSpy.called, true, "clickAt must be called when seam is undefined");
  });
});
