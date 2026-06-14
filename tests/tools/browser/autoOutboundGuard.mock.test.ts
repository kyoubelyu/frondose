/**
 * P-AUTO-1+2 Step 3 — Test Scaffold (outside-in TDD, all assertions TODO/failing)
 * Covers: G-A2.Classifier · G-A2.HardGate · G-A2.Count · G-A2.NoDoubleCount
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/browser/autoOutboundGuard.mock.test.ts
 *
 * Builder seams required (expose from src/tools/browser/outboundGuard.ts or sibling):
 *   - `classifyOutboundLabel(label: string): "connect_open" | "connect_send" | "message_send" | "benign"`
 *   - `session.dailyOutbound?: () => { remaining: number; cooldownRemainingMs: number } | null`
 *     added to LinkedinSession (serve.ts) for hard-gate use in click.ts
 *   - click.ts must return `{ok:false, reason:"auto_cap_reached"}` (distinct envelope) not just
 *     `{ok:false, error:{kind:"invalid_input",...}}` alone — or both (the reason field is new)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Disable pacing so tests don't sleep 0.8-2.5s per click
process.env.MAI_PACE_MIN_MS = "0";
process.env.MAI_PACE_MAX_MS = "0";

// ─── Classifier helpers ────────────────────────────────────────────────────────

type OutboundClass = "connect_open" | "connect_send" | "message_send" | "benign";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution
type AnyFn = (...args: any[]) => any;

// ─── Click mock harness ────────────────────────────────────────────────────────

/**
 * Build a mock session for hard-gate tests.
 * autoRun, dailyOutbound, canClickOutbound are all injectable.
 */
// biome-ignore lint/suspicious/noExplicitAny: mock session shape
function makeMockSession(opts: {
  clickLabel?: string;
  clickSurface?: string;
  clickAtSpy?: { called: boolean };
  autoRun?: (() => { runId: string; maxConnects: number | null; connectSentCount: number } | null) | undefined;
  dailyOutbound?: (() => { remaining: number; cooldownRemainingMs: number } | null) | undefined;
  canClickOutbound?: ((label: string, surface: string) => boolean) | undefined;
  resolvedMode?: (() => "manual" | "magical" | "auto") | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: ledger write spy
  appendAutoLedgerSpy?: { calls: any[] };
// biome-ignore lint/suspicious/noExplicitAny: mock return shape
}): Record<string, any> {
  const {
    clickLabel = "Send invitation",
    clickSurface = "profile",
    clickAtSpy,
    autoRun,
    dailyOutbound,
    canClickOutbound,
    resolvedMode,
    appendAutoLedgerSpy,
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
    // Ledger write spy: builder wires appendAutoLedger into the click path via session
    // or a per-runId handle — we stub it here so G-A2.Count can assert it was called
    _appendAutoLedgerSpy: appendAutoLedgerSpy,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// G-A2.Classifier — shared label classifier
// ─────────────────────────────────────────────────────────────────────────────

describe("G-A2.Classifier — classifyOutboundLabel shared classifier (P-AUTO-1+2)", () => {
  // ─── T-A2.Cls.1 ───────────────────────────────────────────────────────────
  it("T-A2.Cls.1: label='Connect' → 'connect_open'", async () => {
    // Given: classifyOutboundLabel is exported from outboundGuard.ts (or sibling)
    // When:  classifyOutboundLabel("Connect") called
    // Then:  returns "connect_open" (opens modal — does NOT count toward connect cap)
    const mod = await import("../../../src/tools/browser/outboundGuard.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const classifyOutboundLabel: AnyFn = (mod as any)?.classifyOutboundLabel ?? null;
    if (!classifyOutboundLabel) {
      assert.fail("T-A2.Cls.1: classifyOutboundLabel not exported from outboundGuard — builder must add it");
    }
    const result: OutboundClass = classifyOutboundLabel("Connect");
    assert.equal(result, "connect_open", `T-A2.Cls.1: "Connect" must be "connect_open"; got "${result}"`);
  });

  // ─── T-A2.Cls.2 ───────────────────────────────────────────────────────────
  it('T-A2.Cls.2: label="Send invitation" → "connect_send"', async () => {
    // Given: classifyOutboundLabel available
    // When:  classifyOutboundLabel("Send invitation") called
    // Then:  returns "connect_send" (final send — counts toward connect cap + ledger)
    const mod = await import("../../../src/tools/browser/outboundGuard.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const classifyOutboundLabel: AnyFn = (mod as any)?.classifyOutboundLabel ?? null;
    if (!classifyOutboundLabel) {
      assert.fail("T-A2.Cls.2: classifyOutboundLabel not exported — builder must add it");
    }
    const result: OutboundClass = classifyOutboundLabel("Send invitation");
    assert.equal(result, "connect_send", `T-A2.Cls.2: "Send invitation" must be "connect_send"; got "${result}"`);
  });

  // ─── T-A2.Cls.3 ───────────────────────────────────────────────────────────
  it('T-A2.Cls.3: label="Send invite" → "connect_send"', async () => {
    // Given: classifyOutboundLabel available
    // When:  classifyOutboundLabel("Send invite") called
    // Then:  returns "connect_send"
    const mod = await import("../../../src/tools/browser/outboundGuard.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const classifyOutboundLabel: AnyFn = (mod as any)?.classifyOutboundLabel ?? null;
    if (!classifyOutboundLabel) {
      assert.fail("T-A2.Cls.3: classifyOutboundLabel not exported — builder must add it");
    }
    const result: OutboundClass = classifyOutboundLabel("Send invite");
    assert.equal(result, "connect_send", `T-A2.Cls.3: "Send invite" must be "connect_send"; got "${result}"`);
  });

  // ─── T-A2.Cls.4 ───────────────────────────────────────────────────────────
  it('T-A2.Cls.4: label="Send without a note" → "connect_send"', async () => {
    // Given: classifyOutboundLabel available
    // When:  classifyOutboundLabel("Send without a note") called
    // Then:  returns "connect_send"
    const mod = await import("../../../src/tools/browser/outboundGuard.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const classifyOutboundLabel: AnyFn = (mod as any)?.classifyOutboundLabel ?? null;
    if (!classifyOutboundLabel) {
      assert.fail("T-A2.Cls.4: classifyOutboundLabel not exported — builder must add it");
    }
    const result: OutboundClass = classifyOutboundLabel("Send without a note");
    assert.equal(result, "connect_send", `T-A2.Cls.4: "Send without a note" must be "connect_send"; got "${result}"`);
  });

  // ─── T-A2.Cls.5 ───────────────────────────────────────────────────────────
  it('T-A2.Cls.5: label="Send now" → "connect_send"', async () => {
    // Given: classifyOutboundLabel available
    // When:  classifyOutboundLabel("Send now") called
    // Then:  returns "connect_send"
    const mod = await import("../../../src/tools/browser/outboundGuard.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const classifyOutboundLabel: AnyFn = (mod as any)?.classifyOutboundLabel ?? null;
    if (!classifyOutboundLabel) {
      assert.fail("T-A2.Cls.5: classifyOutboundLabel not exported — builder must add it");
    }
    const result: OutboundClass = classifyOutboundLabel("Send now");
    assert.equal(result, "connect_send", `T-A2.Cls.5: "Send now" must be "connect_send"; got "${result}"`);
  });

  // ─── T-A2.Cls.6 ───────────────────────────────────────────────────────────
  it('T-A2.Cls.6: label="Send" (bare DM send) → "message_send"', async () => {
    // Given: classifyOutboundLabel available
    // When:  classifyOutboundLabel("Send") called (plain message send, not connect family)
    // Then:  returns "message_send" (NOT counted by connect cap)
    const mod = await import("../../../src/tools/browser/outboundGuard.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const classifyOutboundLabel: AnyFn = (mod as any)?.classifyOutboundLabel ?? null;
    if (!classifyOutboundLabel) {
      assert.fail("T-A2.Cls.6: classifyOutboundLabel not exported — builder must add it");
    }
    const result: OutboundClass = classifyOutboundLabel("Send");
    assert.equal(result, "message_send", `T-A2.Cls.6: bare "Send" must be "message_send"; got "${result}"`);
  });

  // ─── T-A2.Cls.7 ───────────────────────────────────────────────────────────
  it('T-A2.Cls.7: label="More" → "benign"', async () => {
    // Given: classifyOutboundLabel available
    // When:  classifyOutboundLabel("More") called
    // Then:  returns "benign" (not outbound)
    const mod = await import("../../../src/tools/browser/outboundGuard.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const classifyOutboundLabel: AnyFn = (mod as any)?.classifyOutboundLabel ?? null;
    if (!classifyOutboundLabel) {
      assert.fail("T-A2.Cls.7: classifyOutboundLabel not exported — builder must add it");
    }
    const result: OutboundClass = classifyOutboundLabel("More");
    assert.equal(result, "benign", `T-A2.Cls.7: "More" must be "benign"; got "${result}"`);
  });

  // ─── T-A2.Cls.8 ───────────────────────────────────────────────────────────
  it('T-A2.Cls.8: label="Follow" → "benign" (Follow is its own gate, not connect-type)', async () => {
    // Given: classifyOutboundLabel available
    // When:  classifyOutboundLabel("Follow") called
    // Then:  returns "benign" (Follow handled by FOLLOW_LABEL_RE separately, not connect cap)
    const mod = await import("../../../src/tools/browser/outboundGuard.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const classifyOutboundLabel: AnyFn = (mod as any)?.classifyOutboundLabel ?? null;
    if (!classifyOutboundLabel) {
      assert.fail("T-A2.Cls.8: classifyOutboundLabel not exported — builder must add it");
    }
    const result: OutboundClass = classifyOutboundLabel("Follow");
    assert.equal(result, "benign", `T-A2.Cls.8: "Follow" must be "benign" from classifier perspective; got "${result}"`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G-A2.HardGate — hard gates in click path (cap / daily / cooldown)
// ─────────────────────────────────────────────────────────────────────────────

describe("G-A2.HardGate — click.ts hard gates before clickAt (P-AUTO-1+2)", () => {
  // ─── T-A2.Gate.1 ──────────────────────────────────────────────────────────
  it("T-A2.Gate.1: connect_send label + running run + per-run cap reached → rejected with reason='auto_cap_reached' BEFORE clickAt", async () => {
    // Given: session.autoRun()={runId:'r1', maxConnects:2, connectSentCount:2}, dailyOutbound OK
    //        click label="Send invitation" (connect_send class) on profile surface
    // When:  makeClickTool(session).execute({label:'Send invitation'})
    // Then:  ok=false, reason='auto_cap_reached'; clickAt spy NOT called
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send invitation",
      clickSurface: "profile",
      clickAtSpy,
      autoRun: () => ({ runId: "r1", maxConnects: 2, connectSentCount: 2 }),
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true, // Auto-mode authorized
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.fail("T-A2.Gate.1: makeClickTool not importable — check import path");
    }

    const result = await makeClickTool(session).execute({ label: "Send invitation" });
    assert.ok(result.ok === false, `T-A2.Gate.1: cap-reached must return ok=false; got: ${JSON.stringify(result)}`);
    // Distinct reason field (new P-AUTO-1+2 envelope requirement)
    assert.ok(
      result.reason === "auto_cap_reached" || result.error?.reason === "auto_cap_reached",
      `T-A2.Gate.1: must have reason='auto_cap_reached'; got: ${JSON.stringify(result)}`,
    );
    assert.equal(clickAtSpy.called, false, "T-A2.Gate.1: clickAt must NOT have been called (hard reject before CDP)");
  });

  // ─── T-A2.Gate.2 ──────────────────────────────────────────────────────────
  it("T-A2.Gate.2: connect_send label + daily quota exhausted → rejected with reason='daily_quota_reached' BEFORE clickAt", async () => {
    // Given: session.autoRun() has cap=10/sent=0 (cap not exceeded), but dailyOutbound.remaining=0
    //        click label="Send without a note" on profile surface, canClickOutbound=true
    // When:  makeClickTool(session).execute({label:'Send without a note'})
    // Then:  ok=false, reason='daily_quota_reached'; clickAt NOT called
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send without a note",
      clickSurface: "profile",
      clickAtSpy,
      autoRun: () => ({ runId: "r1", maxConnects: 10, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 0, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.fail("T-A2.Gate.2: makeClickTool not importable");
    }

    const result = await makeClickTool(session).execute({ label: "Send without a note" });
    assert.ok(result.ok === false, `T-A2.Gate.2: daily-quota-reached must return ok=false; got: ${JSON.stringify(result)}`);
    assert.ok(
      result.reason === "daily_quota_reached" || result.error?.reason === "daily_quota_reached",
      `T-A2.Gate.2: must have reason='daily_quota_reached'; got: ${JSON.stringify(result)}`,
    );
    assert.equal(clickAtSpy.called, false, "T-A2.Gate.2: clickAt must NOT have been called");
  });

  // ─── T-A2.Gate.3 ──────────────────────────────────────────────────────────
  it("T-A2.Gate.3: connect_send label + cooldown active → rejected with reason='cooldown_active' BEFORE clickAt", async () => {
    // Given: autoRun cap=10/sent=0, dailyOutbound.remaining=5, cooldownRemainingMs=120000
    //        click label="Send invite", canClickOutbound=true
    // When:  makeClickTool(session).execute({label:'Send invite'})
    // Then:  ok=false, reason='cooldown_active'; clickAt NOT called
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send invite",
      clickSurface: "profile",
      clickAtSpy,
      autoRun: () => ({ runId: "r1", maxConnects: 10, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 5, cooldownRemainingMs: 120_000 }),
      canClickOutbound: () => true,
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.fail("T-A2.Gate.3: makeClickTool not importable");
    }

    const result = await makeClickTool(session).execute({ label: "Send invite" });
    assert.ok(result.ok === false, `T-A2.Gate.3: cooldown-active must return ok=false; got: ${JSON.stringify(result)}`);
    assert.ok(
      result.reason === "cooldown_active" || result.error?.reason === "cooldown_active",
      `T-A2.Gate.3: must have reason='cooldown_active'; got: ${JSON.stringify(result)}`,
    );
    assert.equal(clickAtSpy.called, false, "T-A2.Gate.3: clickAt must NOT have been called");
  });

  // ─── T-A2.Gate.4 ──────────────────────────────────────────────────────────
  it("T-A2.Gate.4: connect_send label + NO active auto run → fail-closed (rejected) BEFORE clickAt", async () => {
    // Given: session.autoRun()=null (no running auto_runs row) + dailyOutbound=null
    //        canClickOutbound=true (would authorize), but no active run → fail-closed
    //        click label="Send invitation"
    // When:  makeClickTool(session).execute({label:'Send invitation'})
    // Then:  ok=false (fail-closed), reason indicates no active run; clickAt NOT called
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send invitation",
      clickSurface: "profile",
      clickAtSpy,
      autoRun: () => null,
      dailyOutbound: () => null,
      canClickOutbound: () => true, // mode=auto but no run → still fail-closed
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.fail("T-A2.Gate.4: makeClickTool not importable");
    }

    const result = await makeClickTool(session).execute({ label: "Send invitation" });
    // Fail-closed: no active run + no daily snapshot → must reject
    assert.ok(result.ok === false, `T-A2.Gate.4: no-active-run connect_send must fail-closed (ok=false); got: ${JSON.stringify(result)}`);
    assert.equal(clickAtSpy.called, false, "T-A2.Gate.4: clickAt must NOT have been called (fail-closed)");
  });

  // ─── T-A2.Gate.5 ──────────────────────────────────────────────────────────
  it("T-A2.Gate.5: connect_send label + under-cap + daily OK + no cooldown → click dispatched (all gates pass)", async () => {
    // Given: autoRun={maxConnects:5, connectSentCount:0}, dailyOutbound={remaining:14, cooldownRemainingMs:0}
    //        canClickOutbound=true, label="Send invitation"
    // When:  makeClickTool(session).execute({label:'Send invitation'})
    // Then:  ok=true; clickAt spy invoked (CDP dispatch happened)
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send invitation",
      clickSurface: "profile",
      clickAtSpy,
      autoRun: () => ({ runId: "r1", maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 14, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.fail("T-A2.Gate.5: makeClickTool not importable");
    }

    const result = await makeClickTool(session).execute({ label: "Send invitation" });
    assert.ok(result.ok === true, `T-A2.Gate.5: all-gates-pass click must return ok=true; got: ${JSON.stringify(result)}`);
    assert.equal(clickAtSpy.called, true, "T-A2.Gate.5: clickAt spy must have been invoked (CDP dispatch)");
  });

  // ─── T-A2.Gate.6 ──────────────────────────────────────────────────────────
  it("T-A2.Gate.6: connect_open label ('Connect') is NOT subject to hard daily/cooldown gate (only connect_send labels are)", async () => {
    // Given: connect_open label="Connect", dailyOutbound.remaining=0 (daily exhausted)
    //        autoRun={maxConnects:5, connectSentCount:0}, canClickOutbound=true
    // When:  makeClickTool(session).execute({label:'Connect'})
    // Then:  ok=true (Connect opens modal; the modal button will be the connect_send gate)
    //        clickAt spy invoked
    // NOTE: the existing cap guard on "Connect" must remain (it uses the old regex) — this
    //       test verifies that the NEW daily/cooldown gate fires on connect_send labels only.
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Connect",
      clickSurface: "profile",
      clickAtSpy,
      autoRun: () => ({ runId: "r1", maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 0, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.fail("T-A2.Gate.6: makeClickTool not importable");
    }

    const result = await makeClickTool(session).execute({ label: "Connect" });
    assert.ok(
      result.ok === true,
      `T-A2.Gate.6: connect_open label must NOT be blocked by daily gate; got: ${JSON.stringify(result)}`,
    );
    assert.equal(clickAtSpy.called, true, "T-A2.Gate.6: clickAt must have been invoked for connect_open");
  });

  // ─── T-A2.Gate.7 ──────────────────────────────────────────────────────────
  it("T-A2.Gate.7: message_send label ('Send') + daily quota=0 → NOT gated by connect hard gate (message scope is separate)", async () => {
    // Given: label="Send" (message_send class), dailyOutbound.remaining=0
    //        autoRun={maxConnects:1, connectSentCount:1} (connect cap also reached)
    //        canClickOutbound=true
    // When:  makeClickTool(session).execute({label:'Send'})
    // Then:  ok=true — P-AUTO-1+2 scopes connect-type hard gates only; message gating is a later phase
    //        clickAt spy invoked
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send",
      clickSurface: "messaging",
      clickAtSpy,
      autoRun: () => ({ runId: "r1", maxConnects: 1, connectSentCount: 1 }),
      dailyOutbound: () => ({ remaining: 0, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
    });

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.fail("T-A2.Gate.7: makeClickTool not importable");
    }

    const result = await makeClickTool(session).execute({ label: "Send" });
    assert.ok(
      result.ok === true,
      `T-A2.Gate.7: message_send not in connect gate scope; got: ${JSON.stringify(result)}`,
    );
    assert.equal(clickAtSpy.called, true, "T-A2.Gate.7: clickAt must have been invoked (message send proceeds)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G-A2.Count — connect_sent ledger write on successful connect_send dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe("G-A2.Count — click layer appends connect_sent/success on connect_send dispatch (P-AUTO-1+2)", () => {
  // ─── T-A2.Count.1 ─────────────────────────────────────────────────────────
  it("T-A2.Count.1: successful connect_send CDP dispatch → click layer appends exactly 1 connect_sent/success ledger row", async () => {
    // Given: autoRun={runId:'r1', maxConnects:5, connectSentCount:0}, daily OK
    //        label="Send invitation" (connect_send), canClickOutbound=true
    //        session has a salesDbPath that allows appendAutoLedger to fire
    // When:  makeClickTool(session).execute({label:'Send invitation'})
    // Then:  DB has exactly 1 auto_run_ledger row for run_id='r1', action_type='connect_sent', result='success'
    //
    // Builder seam: the click tool must receive the salesDbPath (or appendAutoLedger fn)
    // via session.appendConnectSentLedger or session.salesDbPath.
    // This test uses a real in-memory SQLite for ledger verification.
    const { randomUUID } = await import("node:crypto");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const salesDbPath = join(tmpdir(), `auto-count-${randomUUID()}.sqlite`);

    // Seed the database with a running auto_run row
    const dbMod = await import("../../../src/persistence/salesDb.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const openSalesDatabase: AnyFn = (dbMod as any)?.openSalesDatabase ?? null;
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const insertAutoRun: AnyFn = (dbMod as any)?.insertAutoRun ?? null;
    if (!openSalesDatabase || !insertAutoRun) {
      assert.fail("T-A2.Count.1: salesDb not importable");
    }
    const db = openSalesDatabase(salesDbPath);
    const runRow = insertAutoRun(db, { maxConnects: 5 });

    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send invitation",
      clickSurface: "profile",
      clickAtSpy,
      autoRun: () => ({ runId: runRow.id, maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 14, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
    });
    // Builder must wire: session.salesDbPath = salesDbPath (or equivalent seam)
    // so click.ts can call appendAutoLedger after clickAt
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    (session as any).salesDbPath = salesDbPath;

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) {
      assert.fail("T-A2.Count.1: makeClickTool not importable");
    }

    const result = await makeClickTool(session).execute({ label: "Send invitation" });
    assert.ok(result.ok === true, `T-A2.Count.1: click must succeed before we verify ledger; got: ${JSON.stringify(result)}`);
    assert.equal(clickAtSpy.called, true, "T-A2.Count.1: clickAt spy must have been called");

    // Verify exactly 1 ledger row was written by the click layer
    // biome-ignore lint/suspicious/noExplicitAny: raw SQL assertion
    const rows = (db as any)
      .prepare(
        `SELECT * FROM auto_run_ledger WHERE run_id = ? AND action_type = 'connect_sent' AND result = 'success'`,
      )
      // biome-ignore lint/suspicious/noExplicitAny: runtime
      .all(runRow.id) as any[];
    assert.equal(rows.length, 1, `T-A2.Count.1: click layer must append exactly 1 connect_sent/success ledger row; got ${rows.length}`);
  });

  // ─── T-A2.Count.2 ─────────────────────────────────────────────────────────
  it("T-A2.Count.2: successful connect_send + subsequent record_auto_action for same run → total ledger rows = 2 (shows double-count WITHOUT soul.ts fix)", async () => {
    // Given: a successful connect_send click (1 ledger row from click layer)
    //        THEN record_auto_action({runId, actionType:'connect_sent', result:'success'}) called
    // When:  both writes complete
    // Then:  total ledger rows for run_id = 2 (double-count)
    //        This test documents the double-count hazard; it PASSES when the builder
    //        implements the soul.ts update (agent won't call record_auto_action for connect-type)
    //        — but the ledger mechanics are correct. The soul.ts change is validated by
    //        inspecting soul.ts contents, not by this test.
    //        Builder NOTE: this test is INFORMATIONAL — it verifies the append-only mechanic
    //        so the reviewer understands the double-count risk and confirms soul.ts was updated.
    const { randomUUID } = await import("node:crypto");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const salesDbPath = join(tmpdir(), `auto-doublecount-${randomUUID()}.sqlite`);
    const dbMod = await import("../../../src/persistence/salesDb.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const openSalesDatabase: AnyFn = (dbMod as any)?.openSalesDatabase ?? null;
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const insertAutoRun: AnyFn = (dbMod as any)?.insertAutoRun ?? null;
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const appendAutoLedger: AnyFn = (dbMod as any)?.appendAutoLedger ?? null;
    if (!openSalesDatabase || !insertAutoRun || !appendAutoLedger) {
      assert.fail("T-A2.Count.2: salesDb functions not importable");
    }
    const db = openSalesDatabase(salesDbPath);
    const runRow = insertAutoRun(db, { maxConnects: 5 });

    // Simulate click layer writing 1 row
    appendAutoLedger(db, { runId: runRow.id, actionType: "connect_sent", result: "success" });

    // Simulate agent also calling record_auto_action (the double-count)
    appendAutoLedger(db, { runId: runRow.id, actionType: "connect_sent", result: "success" });

    // biome-ignore lint/suspicious/noExplicitAny: raw SQL
    const rows = (db as any)
      .prepare(`SELECT COUNT(*) AS n FROM auto_run_ledger WHERE run_id = ? AND action_type = 'connect_sent'`)
      // biome-ignore lint/suspicious/noExplicitAny: runtime
      .get(runRow.id) as { n: number };
    assert.equal(rows.n, 2, "T-A2.Count.2: without soul.ts fix, double append = 2 rows (documents the hazard)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G-A2.UTC — countOutboundSince daily window anchored to UTC
// ─────────────────────────────────────────────────────────────────────────────

describe("G-A2.UTC — countOutboundSince UTC start-of-day anchor (P-AUTO-1+2)", () => {
  // ─── T-A2.UTC.1 ───────────────────────────────────────────────────────────
  it("T-A2.UTC.1: countOutboundSince with UTC midnight as sinceMs counts rows on or after that timestamp only", async () => {
    // Given: 2 ledger rows: one at UTC midnight (ts = utcMidnight), one at utcMidnight - 1ms
    // When:  countOutboundSince(db, utcMidnight) called
    // Then:  count === 1 (only the row AT midnight counts; before-midnight row does not)
    const { randomUUID } = await import("node:crypto");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const salesDbPath = join(tmpdir(), `auto-utc-${randomUUID()}.sqlite`);
    const dbMod = await import("../../../src/persistence/salesDb.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const openSalesDatabase: AnyFn = (dbMod as any)?.openSalesDatabase ?? null;
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const insertAutoRun: AnyFn = (dbMod as any)?.insertAutoRun ?? null;
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const countOutboundSince: AnyFn = (dbMod as any)?.countOutboundSince ?? null;
    if (!openSalesDatabase || !insertAutoRun || !countOutboundSince) {
      assert.fail("T-A2.UTC.1: salesDb functions not importable");
    }

    const db = openSalesDatabase(salesDbPath);
    const runRow = insertAutoRun(db, { maxConnects: 5 });

    // Compute UTC midnight for today
    const now = new Date();
    const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    // Insert 2 rows manually: one at exactly midnight, one 1ms before
    // biome-ignore lint/suspicious/noExplicitAny: raw SQL for test setup
    (db as any)
      .prepare(
        `INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, ts, count_weight, result)
         VALUES (?, ?, 'connect_sent', NULL, ?, 1.0, 'success')`,
      )
      .run(randomUUID(), runRow.id, utcMidnight); // AT midnight
    // biome-ignore lint/suspicious/noExplicitAny: raw SQL for test setup
    (db as any)
      .prepare(
        `INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, ts, count_weight, result)
         VALUES (?, ?, 'connect_sent', NULL, ?, 1.0, 'success')`,
      )
      .run(randomUUID(), runRow.id, utcMidnight - 1); // 1ms BEFORE midnight

    const count = countOutboundSince(db, utcMidnight);
    assert.equal(count, 1, `T-A2.UTC.1: UTC midnight anchor — only 1 row at or after midnight; got ${count}`);
  });

  // ─── T-A2.UTC.2 ───────────────────────────────────────────────────────────
  it("T-A2.UTC.2: helper utcStartOfDay() returns UTC midnight (ms) for today (used by dailyOutbound probe)", async () => {
    // Given: current time is known
    // When:  utcStartOfDay() (a new helper exposed from auto-run.ts or serve.ts) called
    // Then:  returns a ms timestamp exactly at 00:00:00.000 UTC for today
    //        i.e. new Date(result).getUTCHours() === 0 && getUTCMinutes() === 0 && getUTCSeconds() === 0
    //
    // Builder must expose: export function utcStartOfDay(nowMs?: number): number
    // from src/persistence/sales/auto-run.ts
    const mod = await import("../../../src/persistence/salesDb.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const utcStartOfDay: AnyFn = (mod as any)?.utcStartOfDay ?? null;
    if (!utcStartOfDay) {
      assert.fail("T-A2.UTC.2: utcStartOfDay not exported — builder must add it to auto-run.ts");
    }
    const result: number = utcStartOfDay();
    const d = new Date(result);
    assert.equal(d.getUTCHours(), 0, `T-A2.UTC.2: utcStartOfDay().getUTCHours() must be 0; got ${d.getUTCHours()}`);
    assert.equal(d.getUTCMinutes(), 0, `T-A2.UTC.2: getUTCMinutes() must be 0; got ${d.getUTCMinutes()}`);
    assert.equal(d.getUTCSeconds(), 0, `T-A2.UTC.2: getUTCSeconds() must be 0; got ${d.getUTCSeconds()}`);
    assert.equal(d.getUTCMilliseconds(), 0, `T-A2.UTC.2: getUTCMilliseconds() must be 0; got ${d.getUTCMilliseconds()}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G-A2.FailClosed — click-path fail-closed gates (P-AUTO-1+2 Step-5a, audit B-1/B-3)
// Added at Step 5 after the Codex Step-6 audit REJECT: the daily gate must fail-closed
// (not silently skip) when the Auto run or the daily snapshot is missing, and a ledger
// write failure after a successful dispatch must BLOCK the run (deterministic accounting).
// ─────────────────────────────────────────────────────────────────────────────

describe("G-A2.FailClosed — click-path fail-closed gates (P-AUTO-1+2 B-1/B-3)", () => {
  // ─── T-A2.FC.1 ────────────────────────────────────────────────────────────
  it("T-A2.FC.1: resolvedMode='auto' + autoRun()=null (no running run) + daily OK → connect_send rejected 'no_active_run' BEFORE clickAt", async () => {
    // Given: Auto runtime mode but NO running auto-run row; daily snapshot fine; canClickOutbound stubbed true
    // When:  makeClickTool(session).execute({label:'Send invitation'})
    // Then:  fail-closed reject with reason 'no_active_run' and the CDP clickAt MUST NOT fire
    //   Covers the in-tool backstop to canClickOutbound (B-1 defense-in-depth)
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send invitation",
      clickAtSpy,
      autoRun: () => null,
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
      resolvedMode: () => "auto",
    });
    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) assert.fail("T-A2.FC.1: makeClickTool not importable");
    const result = await makeClickTool(session).execute({ label: "Send invitation" });
    assert.ok(
      result.ok === false && (result.reason === "no_active_run" || result.error?.reason === "no_active_run"),
      `T-A2.FC.1: must reject with reason 'no_active_run'; got ${JSON.stringify(result)}`,
    );
    assert.equal(clickAtSpy.called, false, "T-A2.FC.1: clickAt MUST NOT fire — the gate rejects before dispatch");
  });

  // ─── T-A2.FC.2 ────────────────────────────────────────────────────────────
  it("T-A2.FC.2: connect_send + dailyOutbound()=null (snapshot unavailable) → rejected 'no_daily_snapshot' BEFORE clickAt", async () => {
    // Given: a running auto-run, but the daily snapshot probe returns null (must NOT silently skip the cap)
    // When:  makeClickTool(session).execute({label:'Send invitation'})
    // Then:  fail-closed reject with reason 'no_daily_snapshot'; clickAt MUST NOT fire
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send invitation",
      clickAtSpy,
      autoRun: () => ({ runId: "r1", maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => null,
      canClickOutbound: () => true,
      resolvedMode: () => "auto",
    });
    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) assert.fail("T-A2.FC.2: makeClickTool not importable");
    const result = await makeClickTool(session).execute({ label: "Send invitation" });
    assert.ok(
      result.ok === false && (result.reason === "no_daily_snapshot" || result.error?.reason === "no_daily_snapshot"),
      `T-A2.FC.2: must reject with reason 'no_daily_snapshot'; got ${JSON.stringify(result)}`,
    );
    assert.equal(clickAtSpy.called, false, "T-A2.FC.2: clickAt MUST NOT fire on a null daily snapshot");
  });

  // ─── T-A2.FC.3 ────────────────────────────────────────────────────────────
  it("T-A2.FC.3: connect_send dispatches but the ledger INSERT throws → run marked 'blocked' + reason 'ledger_write_failed'", async () => {
    // Given: a real temp DB with a running auto-run, but auto_run_ledger is dropped so the post-clickAt
    //        INSERT throws. The connect already dispatched (clickAt fired) — we cannot un-send it.
    // When:  makeClickTool(session).execute({label:'Send invitation'})
    // Then:  fail-closed (B-3) — the run row is updated to status='blocked' (so getCurrentAutoRun no
    //        longer returns it → no further uncounted outbound) AND the envelope reason is 'ledger_write_failed'.
    const { randomUUID } = await import("node:crypto");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const salesDbPath = join(tmpdir(), `auto-ledgerfail-${randomUUID()}.sqlite`);
    const dbMod = await import("../../../src/persistence/salesDb.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const openSalesDatabase: AnyFn = (dbMod as any)?.openSalesDatabase ?? null;
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const insertAutoRun: AnyFn = (dbMod as any)?.insertAutoRun ?? null;
    if (!openSalesDatabase || !insertAutoRun) assert.fail("T-A2.FC.3: salesDb not importable");
    const db = openSalesDatabase(salesDbPath);
    const runRow = insertAutoRun(db, { maxConnects: 5 });
    // Force the post-dispatch ledger INSERT to fail; auto_runs stays so the 'blocked' UPDATE can still write.
    // biome-ignore lint/suspicious/noExplicitAny: raw DDL
    (db as any).exec("DROP TABLE auto_run_ledger");

    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send invitation",
      clickAtSpy,
      autoRun: () => ({ runId: runRow.id, maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 14, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
      resolvedMode: () => "auto",
    });
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    (session as any).salesDbPath = salesDbPath;

    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) assert.fail("T-A2.FC.3: makeClickTool not importable");
    const result = await makeClickTool(session).execute({ label: "Send invitation" });

    assert.equal(clickAtSpy.called, true, "T-A2.FC.3: the connect must dispatch (clickAt fires) before the ledger write");
    assert.ok(
      result.ok === false && (result.reason === "ledger_write_failed" || result.error?.reason === "ledger_write_failed"),
      `T-A2.FC.3: must return fail-closed 'ledger_write_failed'; got ${JSON.stringify(result)}`,
    );
    // The run MUST now be blocked so no further uncounted outbound is authorized.
    // biome-ignore lint/suspicious/noExplicitAny: raw SQL assertion
    const row = (db as any).prepare("SELECT status FROM auto_runs WHERE id = ?").get(runRow.id) as { status: string };
    assert.equal(row.status, "blocked", `T-A2.FC.3: run must be marked 'blocked' after a ledger-write failure; got '${row?.status}'`);
    // The in-memory latch must ALSO be set — the guaranteed fail-closed independent of the DB block.
    // biome-ignore lint/suspicious/noExplicitAny: mock shape
    assert.equal((session as any).outboundDisabled, true, "T-A2.FC.3: session.outboundDisabled latch must be set after a ledger-write failure");
  });

  // ─── T-A2.FC.4 ────────────────────────────────────────────────────────────
  it("T-A2.FC.4: session.outboundDisabled latch set → next connect_send blocked 'outbound_disabled' regardless of a healthy run+daily, clickAt NOT fired", async () => {
    // Given: the in-memory fail-closed latch is set (a prior connect's ledger write failed this
    //        session) even though autoRun is running and the daily snapshot is healthy
    // When:  makeClickTool(session).execute({label:'Send invitation'})
    // Then:  rejected with reason 'outbound_disabled' BEFORE clickAt — the latch is DB-independent,
    //        so it holds even when the durable 'blocked' write could not be persisted (B-3 guarantee)
    const clickAtSpy = { called: false };
    const session = makeMockSession({
      clickLabel: "Send invitation",
      clickAtSpy,
      autoRun: () => ({ runId: "r1", maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
      resolvedMode: () => "auto",
    });
    // biome-ignore lint/suspicious/noExplicitAny: mock shape — latch set by a prior failed ledger write
    (session as any).outboundDisabled = true;
    const mod = await import("../../../src/tools/browser/click.js").catch(() => null);
    // biome-ignore lint/suspicious/noExplicitAny: runtime resolution
    const makeClickTool: AnyFn = (mod as any)?.makeClickTool ?? null;
    if (!makeClickTool) assert.fail("T-A2.FC.4: makeClickTool not importable");
    const result = await makeClickTool(session).execute({ label: "Send invitation" });
    assert.ok(
      result.ok === false && (result.reason === "outbound_disabled" || result.error?.reason === "outbound_disabled"),
      `T-A2.FC.4: must reject with reason 'outbound_disabled'; got ${JSON.stringify(result)}`,
    );
    assert.equal(clickAtSpy.called, false, "T-A2.FC.4: clickAt MUST NOT fire when the session latch is set");
  });
});
