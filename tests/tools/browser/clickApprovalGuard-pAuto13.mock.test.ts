/**
 * P-AUTO-13 Step 3 — Test Scaffold — T-A13.ApprovalGuard.1..3 (G-A13.1 + G-A13.3 + G-A13.4)
 *
 * Covers:
 *   G-A13.1 — click.ts:117 approval-guard reject now carries reason='approval_required'
 *   G-A13.3 — ref_stale returns runtime_error with NO reason field
 *   G-A13.4 — all existing guard tokens still emitted via failWithReason helper
 *             (adds missing branches: auto_cap_reached, daily_quota_reached, cooldown_active)
 *             The connect_note_required branch is covered by clickConnectNoteGuard-pAuto6.mock.test.ts.
 *             The no_active_run / no_daily_snapshot / ledger_write_failed / outbound_disabled
 *             branches are covered by autoOutboundGuard.mock.test.ts (T-A2.FC.1..4).
 *
 * Follows the clickConnectNoteGuard-pAuto6.mock.test.ts + autoOutboundGuard.mock.test.ts pattern:
 *   makeMockSession() → makeClickTool(session).execute({label}) → assert envelope shape.
 *
 * Step-3 compile note:
 *   - makeClickTool already exists (pre-builder) so the imports succeed.
 *   - The approval-guard code at click.ts:117 returns a bare fail() today (no reason token).
 *     G-A13.1 will FAIL at Step 3 because result.reason is undefined.
 *   - The ref_stale test (G-A13.3) may PASS or FAIL depending on whether verifyRef
 *     already exists; it is intentionally a confirming scaffold (asserts a PRE-EXISTING invariant).
 *   - The missing-branch tests (G-A13.4-cap/quota/cooldown) will FAIL until Step 4 rewrites
 *     the producer sites to use failWithReason (today they use `{...f, reason:"X" as const}`
 *     which IS already emitted — so these tests may surprisingly PASS at Step 3 if the shapes
 *     are already correct; the TODO comments mark the assertion TODO intent).
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/browser/clickApprovalGuard-pAuto13.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Disable pacing so tests don't sleep 0.8-2.5s per click
process.env.MAI_PACE_MIN_MS = "0";
process.env.MAI_PACE_MAX_MS = "0";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution
type AnyFn = (...args: any[]) => any;

// ─── Mock-session builder (mirrors autoOutboundGuard + clickConnectNoteGuard pattern) ───────

/**
 * Build a mock session for P-AUTO-13 approval guard tests.
 * canClickOutbound / requiresApproval seam is injectable via the session.canClickOutbound field.
 * All other guards (auto_cap / daily / cooldown) are made "passing" by default so tests
 * isolate the specific guard under test.
 */
// biome-ignore lint/suspicious/noExplicitAny: mock session shape
function makeMockSession(opts: {
  clickLabel?: string;
  clickSurface?: string;
  clickAtSpy?: { called: boolean };
  canClickOutbound?: ((label: string, surface: string) => boolean) | undefined;
  autoRun?: (() => { runId: string; maxConnects: number | null; connectSentCount: number } | null) | undefined;
  dailyOutbound?: (() => { remaining: number; cooldownRemainingMs: number } | null) | undefined;
  resolvedMode?: (() => "manual" | "magical" | "auto") | undefined;
  verifyRefResult?: { matches: boolean };
// biome-ignore lint/suspicious/noExplicitAny: mock return shape
}): Record<string, any> {
  const {
    clickLabel = "Send invitation",
    clickSurface = "profile",
    clickAtSpy,
    canClickOutbound,
    autoRun,
    dailyOutbound,
    resolvedMode,
    verifyRefResult = { matches: true },
  } = opts;

  const fakeRef = "@e1";
  const fakeClient = {
    clickAt: async (_ref: string) => {
      if (clickAtSpy) clickAtSpy.called = true;
    },
    getBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    verifyRef: async (_refKey: string, _expected: { role: string; name?: string }) => verifyRefResult,
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
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// G-A13.1 — approval-guard reject carries reason='approval_required'
// ─────────────────────────────────────────────────────────────────────────────

describe("G-A13.1 — click.ts:117 approval-guard reject now carries reason='approval_required' (P-AUTO-13)", () => {
  // ─── T-A13.ApprovalGuard.1 ────────────────────────────────────────────────
  it("T-A13.ApprovalGuard.1: when canClickOutbound returns false for an approval-requiring label → ok=false, reason='approval_required', clickAt NOT called", async () => {
    // Given: a LinkedIn outbound surface ('profile') with a connect-type label that requiresApproval;
    //        session.canClickOutbound returns false (operator has not approved this action)
    // When:  makeClickTool(session).execute({label:'Send invitation'}) called
    // Then:  envelope has ok===false, error.kind==='invalid_input', AND top-level reason==='approval_required';
    //        clickAt spy MUST NOT be called (guard fires BEFORE CDP dispatch)

    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send invitation",
      clickSurface: "profile",
      clickAtSpy,
      // Block the approval gate — canClickOutbound returns false for this label+surface
      canClickOutbound: (_label: string, _surface: string) => false,
      // Provide a passing autoRun + daily so the approval guard is reached first
      autoRun: () => ({ runId: "r1", maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      resolvedMode: () => "auto",
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.ok(false, "T-A13.ApprovalGuard.1: makeClickTool not importable from src/tools/browser/click.ts");
      return;
    }

    const result = await makeClickTool(session).execute({ label: "Send invitation" });

    // TODO (assertion body — filled at Step 5):
    // assert.equal(result.ok, false, "approval-blocked must return ok=false");
    // assert.equal(result.error?.kind, "invalid_input", "must be invalid_input kind");
    // assert.equal(result.reason, "approval_required", "MUST carry top-level reason='approval_required'");
    // assert.equal(clickAtSpy.called, false, "clickAt MUST NOT fire when approval-blocked");

    assert.equal(result.ok, false, "T-A13.ApprovalGuard.1: approval-blocked must return ok=false");
    assert.ok(
      result.reason === "approval_required" || result.error?.reason === "approval_required",
      `T-A13.ApprovalGuard.1: must carry reason='approval_required'; got: ${JSON.stringify(result)}`,
    );
    assert.equal(clickAtSpy.called, false, "T-A13.ApprovalGuard.1: clickAt MUST NOT fire when approval-blocked");
  });

  // ─── T-A13.ApprovalGuard.2 — canClickOutbound returns true → click proceeds ─
  it("T-A13.ApprovalGuard.2: when canClickOutbound returns true for an approval-requiring label → click proceeds (no block, clickAt called)", async () => {
    // Given: same approval-requiring label on a LinkedIn surface; canClickOutbound returns true
    // When:  makeClickTool(session).execute({label:'Send invitation'}) called
    // Then:  click proceeds (ok=true or no approval-reject); clickAt IS called

    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send invitation",
      clickSurface: "profile",
      clickAtSpy,
      // Approval gate passes
      canClickOutbound: () => true,
      autoRun: () => ({ runId: "r1", maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      resolvedMode: () => "auto",
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.ok(false, "T-A13.ApprovalGuard.2: makeClickTool not importable");
      return;
    }

    const result = await makeClickTool(session).execute({ label: "Send invitation" });

    // TODO (assertion body — filled at Step 5):
    // assert.equal(result.ok, true, "canClickOutbound=true must not block");
    // assert.equal(clickAtSpy.called, true, "clickAt must fire when approval granted");

    assert.equal(result.ok, true, "T-A13.ApprovalGuard.2: canClickOutbound=true must allow click through");
    assert.equal(clickAtSpy.called, true, "T-A13.ApprovalGuard.2: clickAt must be called when approval granted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G-A13.3 — ref_stale returns runtime_error with NO reason field
// ─────────────────────────────────────────────────────────────────────────────

describe("G-A13.3 — ref_stale returns runtime_error with NO guard reason (P-AUTO-13)", () => {
  // ─── T-A13.ApprovalGuard.3 ────────────────────────────────────────────────
  it("T-A13.ApprovalGuard.3: when verifyRef returns matches:false → ok=false, error.kind='runtime_error', reason is undefined/absent", async () => {
    // Given: a click with a valid ref (@e1); verifyRef returns {matches:false} (DOM mutated)
    // When:  makeClickTool(session).execute({ref:'@e1'}) called
    // Then:  envelope has ok===false, error.kind==='runtime_error', AND reason is undefined or absent
    //        ('reason' in result === false OR result.reason === undefined)
    //        This confirms ref_stale intentionally has NO guard reason (the agent classifies it as 'failed')

    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send invitation",
      clickSurface: "profile",
      clickAtSpy,
      canClickOutbound: () => true,
      autoRun: () => ({ runId: "r1", maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      resolvedMode: () => "auto",
      // verifyRef returns matches:false → triggers ref_stale path
      verifyRefResult: { matches: false },
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.ok(false, "T-A13.ApprovalGuard.3: makeClickTool not importable");
      return;
    }

    const result = await makeClickTool(session).execute({ ref: "@e1" });

    // TODO (assertion body — filled at Step 5):
    // assert.equal(result.ok, false, "verifyRef mismatch must return ok=false");
    // assert.equal(result.error?.kind, "runtime_error", "must be runtime_error (not invalid_input)");
    // assert.equal(result.reason, undefined, "ref_stale MUST NOT carry a guard reason");

    assert.equal(result.ok, false, "T-A13.ApprovalGuard.3: verifyRef mismatch must return ok=false");
    assert.equal(
      result.error?.kind,
      "runtime_error",
      `T-A13.ApprovalGuard.3: must be runtime_error kind; got: ${result.error?.kind}`,
    );
    assert.equal(
      result.reason,
      undefined,
      `T-A13.ApprovalGuard.3: ref_stale must NOT carry a guard reason (reason must be undefined); got: ${JSON.stringify(result.reason)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G-A13.4 — missing branches: auto_cap_reached, daily_quota_reached, cooldown_active
// (The other branches are tested in autoOutboundGuard.mock.test.ts T-A2.FC.1..4
// and clickConnectNoteGuard-pAuto6.mock.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe("G-A13.4 — remaining guard tokens still emitted via failWithReason (P-AUTO-13)", () => {
  // ─── T-A13.GuardToken.1 — auto_cap_reached ───────────────────────────────
  it("T-A13.GuardToken.1: when connectSentCount >= maxConnects → reason='auto_cap_reached', clickAt NOT called", async () => {
    // Given: autoRun returns {maxConnects:1, connectSentCount:1} (at cap); daily/cooldown OK
    // When:  makeClickTool(session).execute({label:'Send invitation'}) on a connect_send-class label
    // Then:  ok=false, top-level reason==='auto_cap_reached'; clickAt NOT fired

    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send invitation",
      clickSurface: "profile",
      clickAtSpy,
      canClickOutbound: () => true,
      // At cap: connectSentCount === maxConnects
      autoRun: () => ({ runId: "r1", maxConnects: 1, connectSentCount: 1 }),
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      resolvedMode: () => "auto",
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.ok(false, "T-A13.GuardToken.1: makeClickTool not importable");
      return;
    }

    const result = await makeClickTool(session).execute({ label: "Send invitation" });

    // TODO (assertion body — filled at Step 5):
    // assert.equal(result.ok, false);
    // assert.ok(result.reason === "auto_cap_reached" || result.error?.reason === "auto_cap_reached");
    // assert.equal(clickAtSpy.called, false);

    assert.equal(result.ok, false, "T-A13.GuardToken.1: cap-reached must return ok=false");
    assert.ok(
      result.reason === "auto_cap_reached" || result.error?.reason === "auto_cap_reached",
      `T-A13.GuardToken.1: must carry reason='auto_cap_reached'; got: ${JSON.stringify(result)}`,
    );
    assert.equal(clickAtSpy.called, false, "T-A13.GuardToken.1: clickAt must NOT fire when at cap");
  });

  // ─── T-A13.GuardToken.2 — daily_quota_reached ─────────────────────────────
  it("T-A13.GuardToken.2: when dailyOutbound.remaining===0 → reason='daily_quota_reached', clickAt NOT called", async () => {
    // Given: autoRun running (under cap); dailyOutbound.remaining===0 AND cooldownRemainingMs===0
    // When:  makeClickTool(session).execute({label:'Send invitation'}) on a connect_send-class label
    // Then:  ok=false, reason==='daily_quota_reached'; clickAt NOT fired

    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send invitation",
      clickSurface: "profile",
      clickAtSpy,
      canClickOutbound: () => true,
      autoRun: () => ({ runId: "r1", maxConnects: 5, connectSentCount: 0 }),
      // Daily quota exhausted, no cooldown
      dailyOutbound: () => ({ remaining: 0, cooldownRemainingMs: 0 }),
      resolvedMode: () => "auto",
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.ok(false, "T-A13.GuardToken.2: makeClickTool not importable");
      return;
    }

    const result = await makeClickTool(session).execute({ label: "Send invitation" });

    // TODO (assertion body — filled at Step 5):
    // assert.equal(result.ok, false);
    // assert.ok(result.reason === "daily_quota_reached" || result.error?.reason === "daily_quota_reached");
    // assert.equal(clickAtSpy.called, false);

    assert.equal(result.ok, false, "T-A13.GuardToken.2: daily-quota-reached must return ok=false");
    assert.ok(
      result.reason === "daily_quota_reached" || result.error?.reason === "daily_quota_reached",
      `T-A13.GuardToken.2: must carry reason='daily_quota_reached'; got: ${JSON.stringify(result)}`,
    );
    assert.equal(clickAtSpy.called, false, "T-A13.GuardToken.2: clickAt must NOT fire when daily quota exhausted");
  });

  // ─── T-A13.GuardToken.3 — cooldown_active ──────────────────────────────────
  it("T-A13.GuardToken.3: when dailyOutbound.cooldownRemainingMs > 0 → reason='cooldown_active', clickAt NOT called", async () => {
    // Given: autoRun running (under cap); dailyOutbound.remaining > 0 BUT cooldownRemainingMs > 0
    // When:  makeClickTool(session).execute({label:'Send invitation'}) on a connect_send-class label
    // Then:  ok=false, reason==='cooldown_active'; clickAt NOT fired

    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send invitation",
      clickSurface: "profile",
      clickAtSpy,
      canClickOutbound: () => true,
      autoRun: () => ({ runId: "r1", maxConnects: 5, connectSentCount: 0 }),
      // Cooldown active (1 minute remaining)
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 60000 }),
      resolvedMode: () => "auto",
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.ok(false, "T-A13.GuardToken.3: makeClickTool not importable");
      return;
    }

    const result = await makeClickTool(session).execute({ label: "Send invitation" });

    // TODO (assertion body — filled at Step 5):
    // assert.equal(result.ok, false);
    // assert.ok(result.reason === "cooldown_active" || result.error?.reason === "cooldown_active");
    // assert.equal(clickAtSpy.called, false);

    assert.equal(result.ok, false, "T-A13.GuardToken.3: cooldown-active must return ok=false");
    assert.ok(
      result.reason === "cooldown_active" || result.error?.reason === "cooldown_active",
      `T-A13.GuardToken.3: must carry reason='cooldown_active'; got: ${JSON.stringify(result)}`,
    );
    assert.equal(clickAtSpy.called, false, "T-A13.GuardToken.3: clickAt must NOT fire during cooldown");
  });
});
