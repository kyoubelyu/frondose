/**
 * P-AUTO-17 Step 5 (FILLED) — T-A17.10..T-A17.18: click.ts classify-on-resolved + ledger integrity.
 *
 * Tests for:
 *   G-A17.10 — ref NOT in lastContext.entries + recapture finds it as "Send invitation"
 *              → ONE connect_sent/success ledger row + countSuccessfulConnects=1
 *              (RESTAGED per Step-3a: true targetEntry===undefined bypass scenario)
 *   G-A17.11 — ref NOT in lastContext.entries + recapture finds it as "Like this post"
 *              (not a connect-send) → ZERO ledger rows
 *              (RESTAGED per Step-3a: true targetEntry===undefined bypass scenario)
 *   G-A17.12 — label-click end-to-end (Part-1 + Part-2): overlay resolution + ledger write
 *   G-A17.13 — per-run cap honored when classify-on-resolved fires
 *   G-A17.14 — P-33 general-web carve-out: non-LinkedIn surface → no ledger write even if name matches
 *   G-A17.15 — ledger-write failure fail-closes outbound (B-3 latch, P-AUTO-13 no-regression)
 *   G-A17.16 — type.ts substring fallback preserved (regression-fence for the other resolveByLabel caller)
 *   G-A17.17 — NEW: ref NOT in lastContext AND recapture STILL can't find it on a LinkedIn outbound
 *              surface → fail-closed reject (ok:false, unresolvable_ref_on_outbound_surface);
 *              clickAt/verifyRef NEVER called; ZERO ledger rows; outboundDisabled unchanged
 *   G-A17.18 — NEW: same unresolvable-after-recapture scenario but surface="unknown" (non-LinkedIn)
 *              → reject branch SKIPPED → click dispatches ok:true; ZERO ledger rows (P-33 carve-out)
 *
 * Step 5 note on captureCurrentSurfaceContext mock:
 *   click.ts imports captureCurrentSurfaceContext from ../../linkedin/index.js (compiled: src/linkedin/index.js).
 *   We use mock.module (--experimental-test-module-mocks) to intercept this import and return
 *   _nextCaptureResult per test. All other exports from linkedin/index.js are forwarded from the real module.
 *   mock.module MUST be called BEFORE the dynamic import of click.js (so click.js gets the mocked module).
 *   We do this inside a before() hook that runs before any test.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     --experimental-test-module-mocks \
 *     tests/tools/browser/click-outboundClassify-pAuto17.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

// biome-ignore lint/suspicious/noExplicitAny: mock session + dynamic import shapes
type AnyObj = Record<string, any>;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import
type AnyFn = (...args: any[]) => any;

// Disable pacing so tests don't sleep 0.8-2.5s per click.
process.env.FRONDOSE_PACE_MIN_MS = "0";
process.env.FRONDOSE_PACE_MAX_MS = "0";

// ─── Recapture stub state ─────────────────────────────────────────────────────
// Tests T-A17.10/11/17/18 set this before executing the click tool.
// mock.module replaces captureCurrentSurfaceContext in src/linkedin/index.js to return
// this value when called by click.ts's Phase-1 recapture branch.
// biome-ignore lint/suspicious/noExplicitAny: recapture fixture shape varies per test
let _nextCaptureResult: AnyObj | null = null;

// ─── Lazy imports (set up in before() after mock.module is active) ─────────────
let makeClickTool: AnyFn | null = null;
let makeTypeTool: AnyFn | null = null;
let openSalesDatabase: AnyFn | null = null;
let countSuccessfulConnects: AnyFn | null = null;

before(async () => {
  // Step 5: mock.module must be called BEFORE importing click.js so click.js's
  // captureCurrentSurfaceContext import resolves to the mock, not the real implementation.
  const linkedinIndexUrl = pathToFileURL(resolve(process.cwd(), "src/linkedin/index.js")).href;

  // Load the real module first to forward all other exports unchanged.
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import of real module for forwarding
  const realLinkedinIndex: AnyObj = await import(linkedinIndexUrl).catch(() => ({}));

  mock.module(linkedinIndexUrl, {
    namedExports: {
      // Forward all real exports from linkedin/index.js verbatim.
      ...realLinkedinIndex,
      // Override captureCurrentSurfaceContext to return _nextCaptureResult.
      // The real implementation does a CDP round-trip; we short-circuit that.
      captureCurrentSurfaceContext: async (_client: unknown) => {
        if (_nextCaptureResult === null) {
          throw new Error("captureCurrentSurfaceContext stub: _nextCaptureResult not set — set it before calling execute()");
        }
        return _nextCaptureResult;
      },
    },
  });

  // Import click.js AFTER mock.module is active — it will pick up the mocked captureCurrentSurfaceContext.
  const clickMod = await import("../../../src/tools/browser/click.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  makeClickTool = (clickMod as any)?.makeClickTool ?? null;

  const typeMod = await import("../../../src/tools/browser/type.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  makeTypeTool = (typeMod as any)?.makeTypeTool ?? null;

  const dbMod = await import("../../../src/persistence/salesDb.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  openSalesDatabase = (dbMod as any)?.openSalesDatabase ?? null;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  countSuccessfulConnects = (dbMod as any)?.countSuccessfulConnects ?? null;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDbPath(): string {
  return join(tmpdir(), `pAuto17-click-${randomUUID()}.sqlite`);
}

/**
 * Seed a running auto_run row and return { db, runId }.
 * Delegates to the real openSalesDatabase so migrations + schema run.
 */
function seedAutoRun(
  tmpPath: string,
  opts: { maxConnects?: number } = {},
): { db: AnyObj; runId: string } {
  assert.ok(openSalesDatabase !== null, "openSalesDatabase must be importable at this point");
  // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
  const db = openSalesDatabase!(tmpPath);
  const runId = randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, now, null, 480, opts.maxConnects ?? 5, "running", null, null);
  return { db, runId };
}

/**
 * Build a minimal mock LinkedinSession for click integration tests.
 *
 * For T-A17.10/11/17/18 (bypass tests): set `lastContextEntries` to entries that do NOT
 * include the target ref. This stages targetEntry===undefined (the true V-0.2 bypass).
 * The `_nextCaptureResult` variable controls what the Phase-1 recapture returns.
 *
 * For T-A17.12..16 (non-bypass): set `lastContextEntries` to include the target ref/entries.
 */
function makeMockSession(opts: {
  salesDbPath: string;
  runId: string;
  connectSentCount?: number;
  maxConnects?: number | null;
  surface?: string;
  activeLayer?: "page" | "overlay";
  /** entries in lastContext — for bypass tests: omit the target ref so targetEntry===undefined */
  lastContextEntries?: Array<{ ref: string; role: string; name: string }>;
  clickAtSpy?: { called: boolean; calledWith?: string };
  verifyRefSpy?: { called: boolean };
  dailyOutbound?: (() => { remaining: number; cooldownRemainingMs: number } | null) | undefined;
  autoRun?: (() => { runId: string; maxConnects: number | null; connectSentCount: number } | null) | undefined;
}): AnyObj {
  const {
    salesDbPath,
    runId,
    connectSentCount = 0,
    maxConnects = 5,
    surface = "profile",
    activeLayer = "page",
    lastContextEntries = [{ ref: "@pa1", role: "link", name: "View profile" }],
    clickAtSpy,
    verifyRefSpy,
    dailyOutbound,
    autoRun,
  } = opts;

	  const fakeClient = {
	    currentRefMap: {},
	    clickAt: async (ref: string) => {
      if (clickAtSpy) {
        clickAtSpy.called = true;
        clickAtSpy.calledWith = ref;
      }
    },
    getBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    // D-17 verifyRef stub — default: matches=true (no staleness).
    // T-A17.17 asserts this is NEVER called when Phase-2 fail-closed reject fires.
    verifyRef: async (_refKey: string, _expected: { role: string; name?: string }) => {
      if (verifyRefSpy) verifyRefSpy.called = true;
      // Look up in lastContextEntries to return plausible values.
      const entry = lastContextEntries.find((e) => e.ref === `@${_refKey}`);
      return {
        matches: true,
        currentRole: entry?.role ?? _expected.role,
        currentName: entry?.name ?? null,
      };
    },
  };

  // mutable context — Phase-1 recapture in click.ts calls session.setLastContext(fresh)
  // after captureCurrentSurfaceContext resolves. We track the latest context here.
  let currentContext: AnyObj = {
    surface,
    activeLayer,
    entries: lastContextEntries,
  };

  return {
    inputMode: "cdp" as const,
    salesDbPath,
    getOrInitClient: async () => ({ ok: true as const, client: fakeClient }),
    getLastContext: () => currentContext,
    setLastContext: (ctx: AnyObj) => {
      currentContext = ctx;
    },
    showAgentTarget: undefined,
    canClickOutbound: undefined,
    connectNoteRequiredForLabel: undefined,
    outboundDisabled: undefined as boolean | undefined,
    resolvedMode: () => "auto" as const,
    autoRun:
      autoRun ??
      (() => ({
        runId,
        maxConnects: maxConnects === undefined ? 5 : maxConnects,
        connectSentCount,
      })),
    dailyOutbound:
      dailyOutbound ??
      (() => ({
        remaining: 10,
        cooldownRemainingMs: 0,
      })),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("T-A17.10..18 — click.ts classify-on-resolved + ledger integrity (P-AUTO-17 Part 2)", () => {
  // ─── T-A17.10 (RESTAGED) ─────────────────────────────────────────────────
  it("T-A17.10: when @ov4 is NOT in lastContext.entries (targetEntry===undefined) but recapture returns {name:'Send invitation'}, ref-click writes ONE connect_sent/success ledger row + countSuccessfulConnects=1 (G-A17.10 — true V-0.2 bypass)", async () => {
    // Given: lastContext.entries=[{ref:"@pa1",...}] — @ov4 is NOT present (targetEntry===undefined, bypass).
    //        _nextCaptureResult = {surface:"profile", activeLayer:"overlay",
    //                              entries:[{ref:"@ov4", role:"button", name:"Send invitation"}]}
    //        (captureCurrentSurfaceContext stub returns this — Phase-1 recapture FINDS @ov4).
    //        auto_runs row maxConnects=5; autoRun()={runId, maxConnects:5, connectSentCount:0};
    //        dailyOutbound healthy; clickAt/verifyRef stubs wired.
    // When:  makeClickTool(session).execute({ref:"@ov4"}) called
    // Then:  Phase-1 recapture fires → targetEntry resolves to {ref:"@ov4", name:"Send invitation"}.
    //        classifyOutboundEntry("@ov4" entry, "profile") returns "connect_send".
    //        Tool returns ok:true.
    //        auto_run_ledger has EXACTLY ONE row (run_id=runId, action_type='connect_sent', result='success').
    //        countSuccessfulConnects(db, runId) === 1.
    assert.ok(makeClickTool !== null, "T-A17.10: makeClickTool must be importable (check build)");
    assert.ok(openSalesDatabase !== null, "T-A17.10: openSalesDatabase must be importable");
    assert.ok(countSuccessfulConnects !== null, "T-A17.10: countSuccessfulConnects must be importable");

    const tmpPath = makeTmpDbPath();
    const { db, runId } = seedAutoRun(tmpPath, { maxConnects: 5 });

    // Stage the recapture result — captureCurrentSurfaceContext stub returns this.
    _nextCaptureResult = {
      surface: "profile",
      activeLayer: "overlay",
      entries: [{ ref: "@ov4", role: "button", name: "Send invitation" }],
    };

    const clickAtSpy = { called: false, calledWith: "" };
    const verifyRefSpy = { called: false };
    const session = makeMockSession({
      salesDbPath: tmpPath,
      runId,
      connectSentCount: 0,
      maxConnects: 5,
      surface: "profile",
      activeLayer: "page",
      lastContextEntries: [{ ref: "@pa1", role: "link", name: "View profile" }],
      clickAtSpy,
      verifyRefSpy,
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@ov4" });

    assert.ok(result.ok === true, `T-A17.10: expected ok:true; got: ${JSON.stringify(result)}`);
    assert.ok(clickAtSpy.called === true, "T-A17.10: clickAt must have been dispatched");

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const connectCount = countSuccessfulConnects!(db, runId);
    assert.equal(connectCount, 1, `T-A17.10: countSuccessfulConnects must be 1 after connect_sent/success; got ${connectCount}`);

    // Verify the ledger row content directly
    const ledgerRow = db.prepare(
      "SELECT action_type, result FROM auto_run_ledger WHERE run_id = ? AND action_type = 'connect_sent'",
    ).get(runId) as { action_type: string; result: string } | undefined;
    assert.ok(ledgerRow !== undefined, "T-A17.10: auto_run_ledger must have a connect_sent row");
    assert.equal(ledgerRow!.result, "success", "T-A17.10: ledger row result must be 'success'");
  });

  // ─── T-A17.11 (RESTAGED) ─────────────────────────────────────────────────
  it("T-A17.11: when @ov4 is NOT in lastContext.entries (targetEntry===undefined) and recapture returns {name:'Like this post'}, ref-click does NOT write a ledger row (false-positive guard, G-A17.11)", async () => {
    // Given: lastContext.entries=[{ref:"@pa1",...}] — @ov4 is NOT present (targetEntry===undefined, bypass).
    //        _nextCaptureResult = {surface:"profile", activeLayer:"page",
    //                              entries:[{ref:"@ov4", role:"button", name:"Like this post"}]}
    //        (Phase-1 recapture FINDS @ov4 but with name "Like this post" — not connect_send).
    //        autoRun()={runId, maxConnects:5, connectSentCount:0}; dailyOutbound healthy.
    // When:  makeClickTool(session).execute({ref:"@ov4"}) called
    // Then:  Phase-1 recapture fires → targetEntry resolves to {ref:"@ov4", name:"Like this post"}.
    //        classifyOutboundEntry returns "benign" (not connect_send).
    //        Tool returns ok:true.
    //        auto_run_ledger has ZERO rows.
    assert.ok(makeClickTool !== null, "T-A17.11: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-A17.11: openSalesDatabase must be importable");
    assert.ok(countSuccessfulConnects !== null, "T-A17.11: countSuccessfulConnects must be importable");

    const tmpPath = makeTmpDbPath();
    const { db, runId } = seedAutoRun(tmpPath, { maxConnects: 5 });

    // Stage the recapture result — "Like this post" is NOT a connect-send.
    _nextCaptureResult = {
      surface: "profile",
      activeLayer: "page",
      entries: [{ ref: "@ov4", role: "button", name: "Like this post" }],
    };

    const session = makeMockSession({
      salesDbPath: tmpPath,
      runId,
      connectSentCount: 0,
      maxConnects: 5,
      surface: "profile",
      activeLayer: "page",
      lastContextEntries: [{ ref: "@pa1", role: "link", name: "View profile" }],
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@ov4" });

    assert.ok(result.ok === true, `T-A17.11: expected ok:true (benign click proceeds); got: ${JSON.stringify(result)}`);

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const connectCount = countSuccessfulConnects!(db, runId);
    assert.equal(connectCount, 0, `T-A17.11: countSuccessfulConnects must be 0 (benign click = no ledger); got ${connectCount}`);

    // Also verify the ledger is completely empty (no rows at all)
    const ledgerCount = (db.prepare("SELECT COUNT(*) AS n FROM auto_run_ledger WHERE run_id = ?").get(runId) as { n: number }).n;
    assert.equal(ledgerCount, 0, `T-A17.11: auto_run_ledger must have ZERO rows for a benign click; got ${ledgerCount}`);
  });

  // ─── T-A17.12 ─────────────────────────────────────────────────────────────
  it("T-A17.12: label-click 'Send invitation' with overlay context resolves to @ov4 + writes one ledger row (end-to-end Part-1 + Part-2) (G-A17.12)", async () => {
    // Given: session with lastContext.activeLayer="overlay",
    //        entries=[{ref:"@e7", role:"button", name:"Send invitation"} /* page noise */,
    //                  {ref:"@ov4", role:"button", name:"Send invitation"} /* modal */],
    //        plus same auto-run + dailyOutbound mocks as T-A17.10
    // When:  makeClickTool(session).execute({label:"Send invitation"}) called
    // Then:  Part-1 resolves to @ov4 (overlay-scoped exact match);
    //        Part-2 classifies as connect_send;
    //        one connect_sent/success ledger row written;
    //        countSuccessfulConnects(db, runId) advances 0→1
    assert.ok(makeClickTool !== null, "T-A17.12: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-A17.12: openSalesDatabase must be importable");
    assert.ok(countSuccessfulConnects !== null, "T-A17.12: countSuccessfulConnects must be importable");

    const tmpPath = makeTmpDbPath();
    const { db, runId } = seedAutoRun(tmpPath, { maxConnects: 5 });

    // _nextCaptureResult is irrelevant for label clicks that resolve from lastContext directly.
    // resolveByLabelWithRetry first tries ctx0.entries, which already has @ov4.
    // Set to null to ensure it's not accidentally used (the try in resolveByLabelWithRetry
    // won't need to reach the retry branch since @ov4 resolves in the first pass).
    _nextCaptureResult = {
      surface: "profile",
      activeLayer: "overlay",
      entries: [
        { ref: "@e7", role: "button", name: "Send invitation" },
        { ref: "@ov4", role: "button", name: "Send invitation" },
      ],
    };

    const session = makeMockSession({
      salesDbPath: tmpPath,
      runId,
      connectSentCount: 0,
      maxConnects: 5,
      surface: "profile",
      activeLayer: "overlay",
      lastContextEntries: [
        { ref: "@e7", role: "button", name: "Send invitation" },
        { ref: "@ov4", role: "button", name: "Send invitation" },
      ],
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ label: "Send invitation" });

    assert.ok(result.ok === true, `T-A17.12: expected ok:true; got: ${JSON.stringify(result)}`);

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const connectCount = countSuccessfulConnects!(db, runId);
    assert.equal(connectCount, 1, `T-A17.12: countSuccessfulConnects must be 1; got ${connectCount}`);

    // Verify the ledger row
    const ledgerRow = db.prepare(
      "SELECT action_type, result FROM auto_run_ledger WHERE run_id = ? AND action_type = 'connect_sent'",
    ).get(runId) as { action_type: string; result: string } | undefined;
    assert.ok(ledgerRow !== undefined, "T-A17.12: auto_run_ledger must have a connect_sent row");
    assert.equal(ledgerRow!.result, "success", "T-A17.12: ledger row result must be 'success'");
  });

  // ─── T-A17.13 ─────────────────────────────────────────────────────────────
  it("T-A17.13: per-run cap honored when classify-on-resolved fires: autoRun={connectSentCount:5, maxConnects:5} → ok:false, auto_cap_reached, no ledger row (G-A17.13)", async () => {
    // Given: session with lastContext.entries=[{ref:"@ov4", role:"button", name:"Send invitation"}]
    //        (ref IS in lastContext — testing cap gate, not the bypass path),
    //        autoRun() returns {connectSentCount:5, maxConnects:5} (AT cap)
    // When:  makeClickTool(session).execute({ref:"@ov4"}) called (entry name="Send invitation")
    // Then:  tool returns ok:false, error.kind='invalid_input', reason='auto_cap_reached';
    //        NO new ledger row written; NO CDP clickAt dispatched
    assert.ok(makeClickTool !== null, "T-A17.13: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-A17.13: openSalesDatabase must be importable");
    assert.ok(countSuccessfulConnects !== null, "T-A17.13: countSuccessfulConnects must be importable");

    const tmpPath = makeTmpDbPath();
    const { db, runId } = seedAutoRun(tmpPath, { maxConnects: 5 });

    // Set a recapture result (though the bypass path won't be taken since @ov4 IS in lastContext)
    _nextCaptureResult = {
      surface: "profile",
      activeLayer: "page",
      entries: [{ ref: "@ov4", role: "button", name: "Send invitation" }],
    };

    const clickAtSpy = { called: false };
    const session = makeMockSession({
      salesDbPath: tmpPath,
      runId,
      connectSentCount: 5, // AT cap
      maxConnects: 5,
      surface: "profile",
      activeLayer: "page",
      lastContextEntries: [{ ref: "@ov4", role: "button", name: "Send invitation" }],
      clickAtSpy,
      // Override autoRun to return AT-cap state
      autoRun: () => ({ runId, maxConnects: 5, connectSentCount: 5 }),
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@ov4" });

    assert.ok(result.ok === false, `T-A17.13: expected ok:false; got: ${JSON.stringify(result)}`);
    assert.equal((result as AnyObj).error?.kind, "invalid_input", "T-A17.13: error.kind must be 'invalid_input'");
    assert.equal((result as AnyObj).reason, "auto_cap_reached", "T-A17.13: reason must be 'auto_cap_reached'");
    assert.ok(clickAtSpy.called === false, "T-A17.13: clickAt must NOT be dispatched when cap is reached");

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const connectCount = countSuccessfulConnects!(db, runId);
    assert.equal(connectCount, 0, `T-A17.13: no ledger row must be written when cap-rejected; got ${connectCount}`);
  });

  // ─── T-A17.14 ─────────────────────────────────────────────────────────────
  it("T-A17.14: P-33 general-web carve-out — non-LinkedIn surface → ok:true, no ledger write even when entry name matches connect-send regex (G-A17.14)", async () => {
    // Given: session with lastContext.surface="unknown" (non-LinkedIn),
    //        entries=[{ref:"@ov4", role:"button", name:"Send invitation"}]
    //        (ref IS in lastContext — testing carve-out gate, not the bypass path).
    //        autoRun healthy, dailyOutbound healthy.
    // When:  makeClickTool(session).execute({ref:"@ov4"}) called
    // Then:  tool returns ok:true; NO ledger row; daily/cooldown gates do NOT fire
    assert.ok(makeClickTool !== null, "T-A17.14: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-A17.14: openSalesDatabase must be importable");
    assert.ok(countSuccessfulConnects !== null, "T-A17.14: countSuccessfulConnects must be importable");

    const tmpPath = makeTmpDbPath();
    const { db, runId } = seedAutoRun(tmpPath, { maxConnects: 5 });

    // Recapture result for non-LinkedIn surface (bypass path for @ov4 on "unknown" surface)
    _nextCaptureResult = {
      surface: "unknown",
      activeLayer: "page",
      entries: [{ ref: "@ov4", role: "button", name: "Send invitation" }],
    };

    const session = makeMockSession({
      salesDbPath: tmpPath,
      runId,
      connectSentCount: 0,
      maxConnects: 5,
      surface: "unknown",
      activeLayer: "page",
      lastContextEntries: [{ ref: "@ov4", role: "button", name: "Send invitation" }],
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@ov4" });

    assert.ok(result.ok === true, `T-A17.14: P-33 carve-out — expected ok:true on non-LinkedIn surface; got: ${JSON.stringify(result)}`);

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const connectCount = countSuccessfulConnects!(db, runId);
    assert.equal(connectCount, 0, `T-A17.14: no ledger row on non-LinkedIn surface; got ${connectCount}`);
  });

  // ─── T-A17.15 ─────────────────────────────────────────────────────────────
  it("T-A17.15: ledger-write failure fail-closes outbound: appendAutoLedger throws → ok:false, ledger_write_failed + session.outboundDisabled=true + subsequent click returns outbound_disabled (B-3 latch, P-AUTO-13 no-regression) (G-A17.15)", async () => {
    // Given: session with lastContext.entries=[{ref:"@ov4", role:"button", name:"Send invitation"}]
    //        (ref IS in lastContext — testing latch, not the bypass path),
    //        but the auto_run_ledger table is dropped before the click so appendAutoLedger throws
    // When:  makeClickTool(session).execute({ref:"@ov4"}) called
    // Then:  tool returns ok:false, error.kind='runtime_error', reason='ledger_write_failed';
    //        session.outboundDisabled === true;
    //        a subsequent click in the same session returns reason='outbound_disabled' BEFORE CDP dispatch
    assert.ok(makeClickTool !== null, "T-A17.15: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-A17.15: openSalesDatabase must be importable");

    const tmpPath = makeTmpDbPath();
    const { db, runId } = seedAutoRun(tmpPath, { maxConnects: 5 });

    // Drop the ledger table so appendAutoLedger throws (simulates DB corruption / schema mismatch)
    db.exec("DROP TABLE IF EXISTS auto_run_ledger");

    // Set recapture result so bypass tests don't interfere
    _nextCaptureResult = {
      surface: "profile",
      activeLayer: "page",
      entries: [{ ref: "@ov4", role: "button", name: "Send invitation" }],
    };

    const session = makeMockSession({
      salesDbPath: tmpPath,
      runId,
      connectSentCount: 0,
      maxConnects: 5,
      surface: "profile",
      activeLayer: "page",
      lastContextEntries: [{ ref: "@ov4", role: "button", name: "Send invitation" }],
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@ov4" });

    assert.ok(result.ok === false, `T-A17.15: expected ok:false when ledger write fails; got: ${JSON.stringify(result)}`);
    assert.equal((result as AnyObj).error?.kind, "runtime_error", "T-A17.15: error.kind must be 'runtime_error'");
    assert.equal((result as AnyObj).reason, "ledger_write_failed", "T-A17.15: reason must be 'ledger_write_failed'");
    assert.ok(session.outboundDisabled === true, "T-A17.15: session.outboundDisabled must be true after ledger failure (B-3 latch)");

    // Second click in same session — must be rejected immediately with outbound_disabled
    const clickAtSpy2 = { called: false };
    // Wire a fresh clickAt spy into the client (session is the same object so the latch is already set)
    // For the second click, also use an entry that would be connect_send so the latch fires
    // But the latch check happens BEFORE CDP dispatch, so clickAt should NOT be called.
    // We use a second makeMockSession with the same session object's outboundDisabled flag.
    // Actually, the session IS the same object — just call execute again.
    const session2Context = {
      surface: "profile",
      activeLayer: "page" as const,
      entries: [{ ref: "@ov4", role: "button", name: "Send invitation" }],
    };
    // Create a fresh session object pointing to the same DB but with the latch already set
    const session2 = makeMockSession({
      salesDbPath: tmpPath,
      runId,
      connectSentCount: 0,
      maxConnects: 5,
      surface: "profile",
      activeLayer: "page",
      lastContextEntries: session2Context.entries,
      clickAtSpy: clickAtSpy2,
    });
    // Simulate the B-3 latch: the outboundDisabled flag was set on the SAME session object
    // above. For a second test of the latch, we set it manually on the new session object.
    session2.outboundDisabled = true;

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result2 = await makeClickTool!(session2).execute({ ref: "@ov4" });

    assert.ok(result2.ok === false, `T-A17.15: second click must return ok:false (latch fired); got: ${JSON.stringify(result2)}`);
    assert.equal((result2 as AnyObj).reason, "outbound_disabled", "T-A17.15: second click must return reason='outbound_disabled'");
    assert.ok(clickAtSpy2.called === false, "T-A17.15: second click must NOT dispatch clickAt (latch blocks before CDP)");
  });

  // ─── T-A17.16 ─────────────────────────────────────────────────────────────
  it("T-A17.16: type tool substring fallback preserved — type(label='search') on entries=[{ref:'@e1', role:'textbox', name:'Search field'}] → resolves @e1 (T-M51 regression-fence for type path) (G-A17.16)", async () => {
    // Given: session (no salesDb needed, type doesn't write ledger),
    //        lastContext.entries=[{ref:"@e1", role:"textbox", name:"Search field"}]
    // When:  makeTypeTool(session).execute({label:"search", text:"hello"}) called
    // Then:  tool resolves @e1 (substring fallback via resolveByLabel; type-path
    //        doesn't pass activeLayer so overlay narrowing is a no-op)
    //        — NOT ambiguous, NOT no-match; tool either returns ok:true or dispatches keystrokes
    assert.ok(makeTypeTool !== null, "T-A17.16: makeTypeTool must be importable (check build)");

    // Type tool doesn't need salesDb; make a minimal session
    const typeSession: AnyObj = {
      inputMode: "cdp" as const,
      salesDbPath: undefined,
      getOrInitClient: async () => ({
        ok: true as const,
	        client: {
	          currentRefMap: {},
	          type: async (_ref: string, _text: string) => {},
          getBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
          verifyRef: async (_refKey: string, _expected: { role: string; name?: string }) => ({
            matches: true,
            currentRole: "textbox",
            currentName: "Search field",
          }),
          clickAt: async (_ref: string) => {},
          // Some type implementations do inspectAX or navigate — stub broadly
          Runtime: { evaluate: async () => ({ result: { value: "" } }) },
        },
      }),
      getLastContext: () => ({
        surface: "feed",
        activeLayer: "page" as const,
        entries: [{ ref: "@e1", role: "textbox", name: "Search field" }],
      }),
      setLastContext: () => {},
      showAgentTarget: undefined,
      canClickOutbound: undefined,
      connectNoteRequiredForLabel: undefined,
      outboundDisabled: undefined,
      resolvedMode: () => "manual" as const,
      autoRun: undefined,
      dailyOutbound: undefined,
    };

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeTypeTool!(typeSession).execute({ label: "search", text: "hello" });

    // The type tool should resolve @e1 and attempt to type. It may return ok:true or
    // a result shape. The key assertion: it must NOT throw ambiguous_target or no-match.
    // ok:false with error.kind='not_found' would indicate @e1 resolved but typing failed on CDP
    // (acceptable for mock CDP that doesn't implement type()); but ambiguous_target or no-match
    // would indicate resolveByLabel regression.
    const resultKind = (result as AnyObj).error?.kind;
    assert.ok(
      resultKind !== "ambiguous_target",
      `T-A17.16: type path must not throw ambiguous_target; got: ${JSON.stringify(result)}`,
    );
    // Ensure "search" resolved to something (not a no-match error).
    // The resolved message for no-match includes 'no type target matches'
    const resultMsg = ((result as AnyObj).error?.message ?? "") as string;
    assert.ok(
      !resultMsg.toLowerCase().includes("no type target matches"),
      `T-A17.16: type path must find @e1 via substring fallback; got: ${JSON.stringify(result)}`,
    );
  });

  // ─── T-A17.17 (NEW) ──────────────────────────────────────────────────────
  it("T-A17.17: when @ov4 is NOT in lastContext.entries AND recapture STILL cannot resolve it on a LinkedIn outbound surface → fail-closed reject (ok:false, unresolvable_ref_on_outbound_surface); clickAt/verifyRef NEVER called; ZERO ledger rows; outboundDisabled unchanged (G-A17.17)", async () => {
    // Given: lastContext.entries=[{ref:"@pa1",...}] — @ov4 NOT present (targetEntry===undefined, bypass).
    //        surface="profile" (LinkedIn outbound surface per LINKEDIN_OUTBOUND_SURFACES).
    //        _nextCaptureResult = {surface:"profile", entries:[{ref:"@pa2",role:"button",name:"Follow"}]}
    //        — i.e. recapture STILL doesn't find @ov4 after Phase-1.
    //        auto_runs row maxConnects=5; autoRun()={runId, maxConnects:5, connectSentCount:0}.
    //        CDP client clickAt + verifyRef spied — MUST NOT be called.
    // When:  makeClickTool(session).execute({ref:"@ov4"}) called
    // Then:  Phase-1 recapture fires → @ov4 still absent in fresh entries.
    //        Phase-2 fail-closed: surface IS in LINKEDIN_OUTBOUND_SURFACES + ref still unresolvable.
    //        Tool returns ok:false, error.kind='invalid_input',
    //               reason='unresolvable_ref_on_outbound_surface'.
    //        clickAt was NEVER invoked (spy.called === false).
    //        verifyRef was NEVER invoked (D-17 not relied on as backstop).
    //        auto_run_ledger has ZERO rows.
    //        session.outboundDisabled remains false (refused dispatch ≠ ledger-write failure).
    //        countSuccessfulConnects(db, runId) === 0.
    assert.ok(makeClickTool !== null, "T-A17.17: makeClickTool must be importable (check build)");
    assert.ok(openSalesDatabase !== null, "T-A17.17: openSalesDatabase must be importable");
    assert.ok(countSuccessfulConnects !== null, "T-A17.17: countSuccessfulConnects must be importable");

    const tmpPath = makeTmpDbPath();
    const { db, runId } = seedAutoRun(tmpPath, { maxConnects: 5 });

    // Stage the recapture result: @ov4 is STILL absent after recapture.
    _nextCaptureResult = {
      surface: "profile",
      activeLayer: "page",
      entries: [{ ref: "@pa2", role: "button", name: "Follow" }],
    };

    const clickAtSpy = { called: false };
    const verifyRefSpy = { called: false };
    const session = makeMockSession({
      salesDbPath: tmpPath,
      runId,
      connectSentCount: 0,
      maxConnects: 5,
      surface: "profile",
      activeLayer: "page",
      lastContextEntries: [{ ref: "@pa1", role: "link", name: "View profile" }],
      clickAtSpy,
      verifyRefSpy,
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@ov4" });

    assert.ok(result.ok === false, `T-A17.17: expected ok:false (fail-closed reject); got: ${JSON.stringify(result)}`);
    assert.equal((result as AnyObj).error?.kind, "invalid_input", "T-A17.17: error.kind must be 'invalid_input'");
    assert.equal(
      (result as AnyObj).reason,
      "unresolvable_ref_on_outbound_surface",
      `T-A17.17: reason must be 'unresolvable_ref_on_outbound_surface'; got '${(result as AnyObj).reason}'`,
    );
    assert.ok(clickAtSpy.called === false, "T-A17.17: clickAt must NEVER be invoked (fail-closed before dispatch)");
    assert.ok(verifyRefSpy.called === false, "T-A17.17: verifyRef must NEVER be invoked (D-17 not relied on as backstop)");

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const connectCount = countSuccessfulConnects!(db, runId);
    assert.equal(connectCount, 0, `T-A17.17: ZERO ledger rows expected; got ${connectCount}`);

    // B-3 latch must NOT fire (this is a refused dispatch, not a ledger-write failure)
    assert.ok(
      session.outboundDisabled !== true,
      "T-A17.17: session.outboundDisabled must remain false (refused dispatch ≠ ledger-write failure; B-3 latch must NOT be set)",
    );
  });

  // ─── T-A17.18 (NEW) ──────────────────────────────────────────────────────
  it("T-A17.18: when @e9 is NOT in lastContext.entries AND recapture STILL cannot resolve it on surface='unknown' (non-LinkedIn) → reject branch SKIPPED → click dispatches ok:true; ZERO ledger rows (P-33 general-web carve-out, G-A17.18)", async () => {
    // Given: lastContext={surface:"unknown", activeLayer:"page",
    //                      entries:[{ref:"@e1", role:"link", name:"Read more"}]}
    //        — @e9 NOT present (targetEntry===undefined).
    //        _nextCaptureResult = {surface:"unknown", entries:[{ref:"@e1",...}]}
    //        — recapture STILL doesn't find @e9 (same situation on non-LinkedIn surface).
    //        CDP client clickAt(@e9) spy wired; MUST be called (click proceeds).
    // When:  makeClickTool(session).execute({ref:"@e9"}) called
    // Then:  Phase-2 fail-closed reject SKIPPED (surface "unknown" NOT in LINKEDIN_OUTBOUND_SURFACES).
    //        clickAt("@e9") IS invoked on CDP stub (spy.called === true).
    //        Tool returns ok:true.
    //        auto_run_ledger has ZERO rows (no ledger write on non-LinkedIn surface).
    assert.ok(makeClickTool !== null, "T-A17.18: makeClickTool must be importable (check build)");
    assert.ok(openSalesDatabase !== null, "T-A17.18: openSalesDatabase must be importable");
    assert.ok(countSuccessfulConnects !== null, "T-A17.18: countSuccessfulConnects must be importable");

    const tmpPath = makeTmpDbPath();
    const { db, runId } = seedAutoRun(tmpPath, { maxConnects: 5 });

    // Stage the recapture result: @e9 still absent on non-LinkedIn surface.
    _nextCaptureResult = {
      surface: "unknown",
      activeLayer: "page",
      entries: [{ ref: "@e1", role: "link", name: "Read more" }],
    };

    const clickAtSpy = { called: false, calledWith: "" };
    const session = makeMockSession({
      salesDbPath: tmpPath,
      runId,
      connectSentCount: 0,
      maxConnects: 5,
      surface: "unknown",
      activeLayer: "page",
      lastContextEntries: [{ ref: "@e1", role: "link", name: "Read more" }],
      clickAtSpy,
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@e9" });

    assert.ok(result.ok === true, `T-A17.18: P-33 carve-out — reject branch must be SKIPPED on non-LinkedIn surface; got: ${JSON.stringify(result)}`);
    assert.ok(clickAtSpy.called === true, "T-A17.18: clickAt must BE invoked (general-web unresolvable ref still dispatches)");

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const connectCount = countSuccessfulConnects!(db, runId);
    assert.equal(connectCount, 0, `T-A17.18: ZERO ledger rows on non-LinkedIn surface; got ${connectCount}`);
  });
});
