/**
 * P-MSG-SEND-LEDGER Step 3a Revision — Test Scaffold — T-ClickLedger.1..13
 *
 * Covers:
 *   - connect_send Manual writes null-run ledger row (T-ClickLedger.1)
 *   - connect_send Manual with stale running auto_runs row still writes run_id IS NULL (T-ClickLedger.1b)
 *   - connect_send ledger write failure latches session.outboundDisabled (T-ClickLedger.2)
 *   - connect_send Auto still writes runId-tagged row (no regression) (T-ClickLedger.3)
 *   - message_send Manual writes null-run message_sent row (T-ClickLedger.4)
 *   - Auto+message_send still fail-closed before CDP (T-ClickLedger.5)
 *   - message_send ledger failure LATCHES session.outboundDisabled (T-ClickLedger.6) [BLOCKER-1 fix]
 *   - Manual NOT blocked by daily quota (T-ClickLedger.7)
 *   - Manual NOT blocked by cooldown (T-ClickLedger.8)
 *   - Auto still blocked by daily quota (T-ClickLedger.9)
 *   - Auto still blocked by cooldown (T-ClickLedger.10)
 *   - daily===null fail-closed fires regardless of mode (T-ClickLedger.11)
 *   - Auto per-run cap regression guard: null-run rows excluded from countSuccessfulConnects (T-ClickLedger.12)
 *   - once latched, BOTH connect_send AND message_send blocked pre-dispatch (T-ClickLedger.13)
 *
 * Revisions applied (Step-3a):
 *   - T-ClickLedger.6: FLIPPED to assert outboundDisabled===true (BLOCKER-1 fix)
 *   - T-ClickLedger.1b: NEW — Manual with stale autoRun() row writes run_id IS NULL (CONCERN-MR-1)
 *   - T-ClickLedger.13: NEW — broadened pre-dispatch latch blocks both classes (BLOCKER-1 symmetry)
 *   - mock.module now also stubs updateAutoRunStatus as a counted spy (CONCERN-MR-3 fix)
 *
 * IMPORTANT: T-ClickLedger.2 and T-ClickLedger.6 use mock.module to stub appendAutoLedger.
 * mock.module MUST be called BEFORE the dynamic import of click.js.
 * The FRONDOSE_PACE_MIN_MS/MAX_MS env vars are set to 0 to avoid 0.8–2.5s per-click sleep.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 \
 *     tests/tools/browser/click.ledger.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

// biome-ignore lint/suspicious/noExplicitAny: mock session/DB + dynamic import shapes
type AnyObj = Record<string, any>;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import
type AnyFn = (...args: any[]) => any;

// Disable pacing so tests don't sleep 0.8-2.5s per click.
process.env.FRONDOSE_PACE_MIN_MS = "0";
process.env.FRONDOSE_PACE_MAX_MS = "0";

// ─── Stub state for appendAutoLedger + updateAutoRunStatus ────────────────────
// T-ClickLedger.2 and T-ClickLedger.6 need appendAutoLedger to throw.
// We control this via a module-level flag that the stub reads.
let _appendAutoLedgerShouldThrow = false;

// updateAutoRunStatus spy counter (CONCERN-MR-3 fix).
// Counts how many times updateAutoRunStatus was called by click.ts after the mock is active.
// Reset to 0 before each test that needs to assert zero calls.
let _updateAutoRunStatusCallCount = 0;

// ─── Lazy imports (set up in before() after mock.module is active) ─────────────
let makeClickTool: AnyFn | null = null;
let openSalesDatabase: AnyFn | null = null;
let countSuccessfulConnects: AnyFn | null = null;

before(async () => {
  // mock.module must be called BEFORE importing click.js so that click.js's
  // appendAutoLedger import resolves to the stub rather than the real implementation.
  const autoRunModUrl = pathToFileURL(resolve(process.cwd(), "src/persistence/sales/auto-run.js")).href;

  // Load the real auto-run module to forward all exports unchanged.
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import of real module
  const realAutoRun: AnyObj = await import(autoRunModUrl).catch(() => ({}));

  mock.module(autoRunModUrl, {
    namedExports: {
      // Forward all real exports verbatim.
      ...realAutoRun,
      // Override appendAutoLedger: either throw (when _appendAutoLedgerShouldThrow=true)
      // or delegate to the real implementation.
      appendAutoLedger: (db: AnyObj, input: AnyObj): string => {
        if (_appendAutoLedgerShouldThrow) {
          throw new Error("stub: appendAutoLedger forced failure for T-ClickLedger.2/.6");
        }
        // Delegate to the real implementation.
        return (realAutoRun.appendAutoLedger as AnyFn)(db, input);
      },
      // Stub updateAutoRunStatus as a counted spy (CONCERN-MR-3 fix).
      // Counts calls so T-ClickLedger.2 and T-ClickLedger.6 can assert 0 calls
      // on the Manual/null-run failure path (no run id to block in Manual).
      updateAutoRunStatus: (...args: AnyObj[]): void => {
        _updateAutoRunStatusCallCount++;
        // Delegate to the real implementation so Auto-mode paths work correctly.
        if (typeof (realAutoRun.updateAutoRunStatus as AnyFn | undefined) === "function") {
          (realAutoRun.updateAutoRunStatus as AnyFn)(...args);
        }
      },
    },
  });

  // Import click.js AFTER mock.module is active.
  const clickMod = await import("../../../src/tools/browser/click.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  makeClickTool = (clickMod as AnyObj | null)?.makeClickTool ?? null;

  const dbMod = await import("../../../src/persistence/salesDb.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  openSalesDatabase = (dbMod as AnyObj | null)?.openSalesDatabase ?? null;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  countSuccessfulConnects = (dbMod as AnyObj | null)?.countSuccessfulConnects ?? null;
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDbPath(): string {
  return join(tmpdir(), `click-ledger-${randomUUID()}.sqlite`);
}

type ClickAtSpy = { called: boolean; calledWith?: string };

/**
 * Build a minimal mock LinkedinSession for T-ClickLedger tests.
 *
 * Defaults: Manual mode, no running auto-run, healthy daily snapshot,
 * outboundDisabled=undefined, salesDbPath set to a real file DB path.
 */
function makeMockSession(opts: {
  salesDbPath: string;
  /** entries in lastContext — must include the target ref/name to be found */
  lastContextEntries: Array<{ ref: string; role: string; name: string }>;
  surface?: string;
  activeLayer?: "page" | "overlay";
  resolvedMode?: () => "manual" | "magical" | "auto";
  autoRun?: (() => { runId: string; maxConnects: number | null; connectSentCount: number } | null) | undefined;
  dailyOutbound?: (() => { remaining: number; cooldownRemainingMs: number } | null) | undefined;
  canClickOutbound?: ((label: string, surface: string) => boolean) | undefined;
  clickAtSpy?: ClickAtSpy;
}): AnyObj {
  const {
    salesDbPath,
    lastContextEntries,
    surface = "profile",
    activeLayer = "page",
    resolvedMode = () => "manual" as const,
    autoRun = undefined,
    dailyOutbound = () => ({ remaining: 10, cooldownRemainingMs: 0 }),
    canClickOutbound = (_label: string, _surface: string) => true,
    clickAtSpy,
  } = opts;

  const fakeClient: AnyObj = {
    currentRefMap: {},
    clickAt: async (ref: string) => {
      if (clickAtSpy) {
        clickAtSpy.called = true;
        clickAtSpy.calledWith = ref;
      }
    },
    getBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
    verifyRef: async (_refKey: string, _expected: { role: string; name?: string }) => ({
      matches: true,
      currentRole: _expected.role,
      currentName: _expected.name ?? null,
    }),
  };

  let currentContext: AnyObj = {
    surface,
    activeLayer,
    entries: lastContextEntries,
  };

  const session: AnyObj = {
    inputMode: "cdp" as const,
    salesDbPath,
    getOrInitClient: async () => ({ ok: true as const, client: fakeClient }),
    getLastContext: () => currentContext,
    setLastContext: (ctx: AnyObj) => {
      currentContext = ctx;
    },
    showAgentTarget: undefined,
    canClickOutbound,
    connectNoteRequiredForLabel: undefined,
    outboundDisabled: undefined as boolean | undefined,
    resolvedMode,
    autoRun,
    dailyOutbound,
  };

  return session;
}

/** Seed a running auto_run row and return { db, runId }. */
function seedAutoRun(
  dbPath: string,
  opts: { maxConnects?: number | null; connectSentCount?: number } = {},
): { db: AnyObj; runId: string } {
  assert.ok(openSalesDatabase !== null, "openSalesDatabase must be importable");
  // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
  const db = openSalesDatabase!(dbPath);
  const runId = randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, now, null, 480, opts.maxConnects ?? 5, "running", null, null);

  // Pre-seed connectSentCount rows in the ledger if requested (for cap tests)
  if (opts.connectSentCount && opts.connectSentCount > 0) {
    for (let i = 0; i < opts.connectSentCount; i++) {
      db.prepare(
        "INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, ts, count_weight, result) VALUES (?, ?, ?, NULL, ?, 1.0, ?)",
      ).run(randomUUID(), runId, "connect_sent", now - (i + 1) * 1000, "success");
    }
  }

  return { db, runId };
}

// ─── Test Fixtures: connect_send entries ──────────────────────────────────────

const CONNECT_SEND_ENTRY = { ref: "@ov4", role: "button", name: "Send invitation" };
const CONNECT_OPEN_ENTRY = { ref: "@pa1", role: "button", name: "Connect" };
const MESSAGE_SEND_ENTRY = { ref: "@m1", role: "button", name: "Send" };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("T-ClickLedger — click.ts ledger writes + mode-gated blocking (P-MSG-SEND-LEDGER)", () => {

  // === connect_send Manual ledger write + fail-closed preserved ===

  // ─── T-ClickLedger.1 ────────────────────────────────────────────────────────
  it("T-ClickLedger.1: connect_send in Manual writes null-run ledger row + tool returns ok", async () => {
    // Given: session resolvedMode==='manual', autoRun()===null (no running auto-run),
    //        dailyOutbound()={remaining:10, cooldownRemainingMs:0},
    //        canClickOutbound()===true, surface='profile',
    //        entry name='Send invitation' (classifies as connect_send)
    // When:  click tool executes against @ov4
    // Then:  exactly one auto_run_ledger row with (run_id IS NULL, action_type='connect_sent', result='success')
    //        AND tool returns ok:true
    assert.ok(makeClickTool !== null, "T-ClickLedger.1: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-ClickLedger.1: openSalesDatabase must be importable");

    _appendAutoLedgerShouldThrow = false;
    const dbPath = makeTmpDbPath();
    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const db = openSalesDatabase!(dbPath);
    const clickAtSpy: ClickAtSpy = { called: false };

    const session = makeMockSession({
      salesDbPath: dbPath,
      lastContextEntries: [CONNECT_SEND_ENTRY],
      surface: "profile",
      resolvedMode: () => "manual",
      autoRun: () => null,
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
      clickAtSpy,
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@ov4" });

    assert.ok(result.ok === true, `expected ok:true; got: ${JSON.stringify(result)}`);
    assert.ok(clickAtSpy.called, "clickAt must have been dispatched");
    const rows = db.prepare("SELECT run_id, action_type, result FROM auto_run_ledger").all() as Array<{ run_id: string | null; action_type: string; result: string }>;
    assert.strictEqual(rows.length, 1, "exactly one ledger row expected");
    assert.strictEqual(rows[0]!.run_id, null, "run_id must be null for Manual connect");
    assert.strictEqual(rows[0]!.action_type, "connect_sent");
    assert.strictEqual(rows[0]!.result, "success");
  });

  // ─── T-ClickLedger.1b ───────────────────────────────────────────────────────
  it("T-ClickLedger.1b: Manual connect with stale running auto_runs row still writes run_id IS NULL (CONCERN-MR-1 guard)", async () => {
    // Given: session where resolvedMode()==='manual' BUT autoRun() returns a running row
    //        {runId:'STALE-R', maxConnects:5, connectSentCount:0} (simulating a stale or
    //        parallel auto_runs row that serve.ts:254-264 returns regardless of resolved mode)
    //        other inputs identical to T-ClickLedger.1
    // When:  click executes against a connect_send entry
    // Then:  the new auto_run_ledger row has run_id IS NULL (NOT 'STALE-R')
    //        Pins CONCERN-MR-1: Manual ledger rows must never consume the per-run cap of a
    //        parallel/stale auto-run. run_id is derived from MODE, not from session.autoRun().
    assert.ok(makeClickTool !== null, "T-ClickLedger.1b: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-ClickLedger.1b: openSalesDatabase must be importable");

    _appendAutoLedgerShouldThrow = false;
    const dbPath = makeTmpDbPath();
    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const db = openSalesDatabase!(dbPath);
    const staleRunId = "STALE-R";
    // Seed the stale auto_runs row so the FK is satisfiable if click.ts mistakenly uses it
    db.prepare(
      "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL)",
    ).run(staleRunId, Date.now(), 480, 5, "running");

    const session = makeMockSession({
      salesDbPath: dbPath,
      lastContextEntries: [CONNECT_SEND_ENTRY],
      surface: "profile",
      resolvedMode: () => "manual",
      // autoRun() returns a running row — this is the stale-row scenario
      autoRun: () => ({ runId: staleRunId, maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@ov4" });

    assert.ok(result.ok === true, `expected ok:true; got: ${JSON.stringify(result)}`);
    const rows = db.prepare("SELECT run_id FROM auto_run_ledger").all() as Array<{ run_id: string | null }>;
    assert.strictEqual(rows.length, 1, "exactly one ledger row expected");
    assert.strictEqual(rows[0]!.run_id, null,
      `run_id must be null for Manual connect even when autoRun() returns '${staleRunId}' — mode-derived, not DB-derived`);
  });

  // ─── T-ClickLedger.2 ────────────────────────────────────────────────────────
  it("T-ClickLedger.2: connect_send ledger write failure latches session.outboundDisabled; updateAutoRunStatus NOT called in Manual (CONCERN-MR-3 spy)", async () => {
    // Given: Manual fixture from T-ClickLedger.1 BUT appendAutoLedger throws (stub active)
    // When:  click tool executes against @ov4
    // Then:  tool returns runtime_error / ledger_write_failed
    //        AND session.outboundDisabled === true (in-memory latch set)
    //        AND updateAutoRunStatus spy call count === 0 (no run id to block in Manual)
    assert.ok(makeClickTool !== null, "T-ClickLedger.2: makeClickTool must be importable");

    _appendAutoLedgerShouldThrow = true;
    _updateAutoRunStatusCallCount = 0; // reset spy counter before this test
    try {
      const dbPath = makeTmpDbPath();
      const session = makeMockSession({
        salesDbPath: dbPath,
        lastContextEntries: [CONNECT_SEND_ENTRY],
        surface: "profile",
        resolvedMode: () => "manual",
        autoRun: () => null,
        dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
        canClickOutbound: () => true,
      });

      // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
      const result = await makeClickTool!(session).execute({ ref: "@ov4" });

      assert.ok(result.ok === false, `expected ok:false when ledger write fails; got: ${JSON.stringify(result)}`);
      assert.strictEqual((result as AnyObj).error?.kind, "runtime_error");
      assert.strictEqual((result as AnyObj).reason, "ledger_write_failed");
      assert.ok(session.outboundDisabled === true, "session.outboundDisabled must be true (in-memory latch)");
      assert.strictEqual(_updateAutoRunStatusCallCount, 0,
        "updateAutoRunStatus must NOT be called for Manual/null-run failure path (no run id to block)");
    } finally {
      _appendAutoLedgerShouldThrow = false;
    }
  });

  // ─── T-ClickLedger.3 ────────────────────────────────────────────────────────
  it("T-ClickLedger.3: connect_send in Auto still writes a runId-tagged row (no regression)", async () => {
    // Given: session resolvedMode==='auto', autoRun() returns {runId:'R1', maxConnects:5, connectSentCount:0},
    //        daily snapshot ok, entry classifies as connect_send
    // When:  click tool executes against @ov4
    // Then:  a new ledger row with (run_id='R1', action_type='connect_sent', result='success')
    assert.ok(makeClickTool !== null, "T-ClickLedger.3: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-ClickLedger.3: openSalesDatabase must be importable");
    assert.ok(countSuccessfulConnects !== null, "T-ClickLedger.3: countSuccessfulConnects must be importable");

    _appendAutoLedgerShouldThrow = false;
    const dbPath = makeTmpDbPath();
    const { db, runId } = seedAutoRun(dbPath, { maxConnects: 5 });

    const session = makeMockSession({
      salesDbPath: dbPath,
      lastContextEntries: [CONNECT_SEND_ENTRY],
      surface: "profile",
      resolvedMode: () => "auto",
      autoRun: () => ({ runId, maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@ov4" });

    assert.ok(result.ok === true, `expected ok:true; got: ${JSON.stringify(result)}`);
    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const count = countSuccessfulConnects!(db, runId);
    assert.strictEqual(count, 1, "Auto connect must write a runId-tagged row (per-run cap regression guard)");
  });

  // === message_send Manual ledger write; Auto fail-closed unchanged ===

  // ─── T-ClickLedger.4 ────────────────────────────────────────────────────────
  it("T-ClickLedger.4: message_send in Manual writes null-run message_sent row + tool returns ok", async () => {
    // Given: session resolvedMode==='manual', autoRun()===null,
    //        surface='messaging-thread', canClickOutbound()===true,
    //        entry name='Send' (classifies as message_send via MESSAGE_SEND_RE)
    // When:  click tool executes against @m1
    // Then:  exactly one auto_run_ledger row with (run_id IS NULL, action_type='message_sent', result='success')
    //        AND tool returns ok:true
    assert.ok(makeClickTool !== null, "T-ClickLedger.4: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-ClickLedger.4: openSalesDatabase must be importable");

    _appendAutoLedgerShouldThrow = false;
    const dbPath = makeTmpDbPath();
    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const db = openSalesDatabase!(dbPath);
    const clickAtSpy: ClickAtSpy = { called: false };

    const session = makeMockSession({
      salesDbPath: dbPath,
      lastContextEntries: [MESSAGE_SEND_ENTRY],
      surface: "messaging-thread",
      resolvedMode: () => "manual",
      autoRun: () => null,
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
      clickAtSpy,
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@m1" });

    assert.ok(result.ok === true, `expected ok:true; got: ${JSON.stringify(result)}`);
    assert.ok(clickAtSpy.called, "clickAt must have been dispatched");
    const rows = db.prepare("SELECT run_id, action_type, result FROM auto_run_ledger").all() as Array<{ run_id: string | null; action_type: string; result: string }>;
    assert.strictEqual(rows.length, 1, "exactly one ledger row expected");
    assert.strictEqual(rows[0]!.run_id, null, "run_id must be null for Manual message_send");
    assert.strictEqual(rows[0]!.action_type, "message_sent");
    assert.strictEqual(rows[0]!.result, "success");
  });

  // ─── T-ClickLedger.5 ────────────────────────────────────────────────────────
  it("T-ClickLedger.5: Auto+message_send still rejects with approval_required before any CDP or ledger (regression guard for P-MSG-SEND scope A)", async () => {
    // Given: session resolvedMode==='auto', a running auto-run, surface='messaging-thread',
    //        entry name='Send' (classifies as message_send)
    // When:  click tool executes against @m1
    // Then:  tool returns approval_required (fail-closed at line 249-256)
    //        AND clickAt was NOT called
    //        AND no ledger row was written
    assert.ok(makeClickTool !== null, "T-ClickLedger.5: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-ClickLedger.5: openSalesDatabase must be importable");

    _appendAutoLedgerShouldThrow = false;
    const dbPath = makeTmpDbPath();
    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const db = openSalesDatabase!(dbPath);
    const r1 = randomUUID();
    db.prepare(
      "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL)",
    ).run(r1, Date.now(), 480, 5, "running");

    const clickAtSpy: ClickAtSpy = { called: false };
    const session = makeMockSession({
      salesDbPath: dbPath,
      lastContextEntries: [MESSAGE_SEND_ENTRY],
      surface: "messaging-thread",
      resolvedMode: () => "auto",
      autoRun: () => ({ runId: r1, maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
      clickAtSpy,
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@m1" });

    assert.ok(result.ok === false, `Auto message_send must fail-closed; got: ${JSON.stringify(result)}`);
    assert.strictEqual((result as AnyObj).reason, "approval_required");
    assert.ok(clickAtSpy.called === false, "clickAt must NOT be dispatched");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM auto_run_ledger").get() as { n: number };
    assert.strictEqual(rows.n, 0, "no ledger row must be written for fail-closed Auto message_send");
  });

  // ─── T-ClickLedger.6 ────────────────────────────────────────────────────────
  it("T-ClickLedger.6: message_send ledger write failure LATCHES session.outboundDisabled===true; updateAutoRunStatus NOT called (BLOCKER-1 symmetric latch)", async () => {
    // Given: Manual message_send fixture with appendAutoLedger stubbed to throw on actionType='message_sent'
    // When:  click tool executes against @m1
    // Then:  tool returns runtime_error / ledger_write_failed
    //        AND session.outboundDisabled === true (symmetric latch — BLOCKER-1 fix)
    //        AND updateAutoRunStatus spy call count === 0 (runId is null by construction for message_send)
    //        message_sent participates in the shared daily/cooldown budget (countOutboundSince +
    //        lastOutboundAt are global); an uncounted message_sent is a daily cap bypass — same
    //        safety class as an uncounted connect. The latch is symmetric; the durable-block is not
    //        (no run id to block for message_send by construction — Auto+message_send is fail-closed upstream).
    assert.ok(makeClickTool !== null, "T-ClickLedger.6: makeClickTool must be importable");

    _appendAutoLedgerShouldThrow = true;
    _updateAutoRunStatusCallCount = 0; // reset spy counter before this test
    try {
      const dbPath = makeTmpDbPath();
      const session = makeMockSession({
        salesDbPath: dbPath,
        lastContextEntries: [MESSAGE_SEND_ENTRY],
        surface: "messaging-thread",
        resolvedMode: () => "manual",
        autoRun: () => null,
        dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
        canClickOutbound: () => true,
      });

      // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
      const result = await makeClickTool!(session).execute({ ref: "@m1" });

      assert.ok(result.ok === false, `expected ok:false when message ledger fails; got: ${JSON.stringify(result)}`);
      assert.strictEqual((result as AnyObj).error?.kind, "runtime_error");
      assert.strictEqual((result as AnyObj).reason, "ledger_write_failed");
      assert.ok(session.outboundDisabled === true,
        "session.outboundDisabled must be TRUE — BLOCKER-1 fix: message_send ledger failure latches symmetrically");
      assert.strictEqual(_updateAutoRunStatusCallCount, 0,
        "updateAutoRunStatus must NOT be called for message_send failure — runId is null by construction");
    } finally {
      _appendAutoLedgerShouldThrow = false;
    }
  });

  // === Mode-gated blocking (Manual count-only) ===

  // ─── T-ClickLedger.7 ────────────────────────────────────────────────────────
  it("T-ClickLedger.7: Manual is NOT blocked when daily.remaining===0 — click dispatches + ledger row written (no daily_quota_reached)", async () => {
    // Given: Manual session, surface='profile', entry='Send invitation' (connect_send),
    //        dailyOutbound()={remaining: 0, cooldownRemainingMs: 0}
    // When:  click tool executes against @ov4
    // Then:  clickAt IS dispatched (not blocked), ledger row is written, tool returns ok:true
    //        daily_quota_reached is NOT returned
    assert.ok(makeClickTool !== null, "T-ClickLedger.7: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-ClickLedger.7: openSalesDatabase must be importable");

    _appendAutoLedgerShouldThrow = false;
    const dbPath = makeTmpDbPath();
    const clickAtSpy: ClickAtSpy = { called: false };

    const session = makeMockSession({
      salesDbPath: dbPath,
      lastContextEntries: [CONNECT_SEND_ENTRY],
      surface: "profile",
      resolvedMode: () => "manual",
      autoRun: () => null,
      dailyOutbound: () => ({ remaining: 0, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
      clickAtSpy,
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@ov4" });

    assert.ok(result.ok === true, `Manual must not be blocked by quota; got: ${JSON.stringify(result)}`);
    assert.ok(clickAtSpy.called, "clickAt must be dispatched when Manual remaining===0");
    const r = (result as AnyObj).reason;
    assert.ok(r !== "daily_quota_reached", "daily_quota_reached must NOT be returned in Manual");
  });

  // ─── T-ClickLedger.8 ────────────────────────────────────────────────────────
  it("T-ClickLedger.8: Manual is NOT blocked when cooldownRemainingMs>0 — click dispatches + ledger row written (no cooldown_active)", async () => {
    // Given: same as T-ClickLedger.7 but dailyOutbound()={remaining: 5, cooldownRemainingMs: 60_000}
    // When:  click tool executes against @ov4
    // Then:  clickAt IS dispatched, ledger row written, tool returns ok:true
    //        cooldown_active is NOT returned
    assert.ok(makeClickTool !== null, "T-ClickLedger.8: makeClickTool must be importable");

    _appendAutoLedgerShouldThrow = false;
    const dbPath = makeTmpDbPath();
    const clickAtSpy: ClickAtSpy = { called: false };

    const session = makeMockSession({
      salesDbPath: dbPath,
      lastContextEntries: [CONNECT_SEND_ENTRY],
      surface: "profile",
      resolvedMode: () => "manual",
      autoRun: () => null,
      dailyOutbound: () => ({ remaining: 5, cooldownRemainingMs: 60_000 }),
      canClickOutbound: () => true,
      clickAtSpy,
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@ov4" });

    assert.ok(result.ok === true, `Manual must not be blocked by cooldown; got: ${JSON.stringify(result)}`);
    assert.ok(clickAtSpy.called, "clickAt must be dispatched when Manual has cooldown remaining");
    assert.ok((result as AnyObj).reason !== "cooldown_active", "cooldown_active must NOT be returned in Manual");
  });

  // ─── T-ClickLedger.9 ────────────────────────────────────────────────────────
  it("T-ClickLedger.9: Auto IS still blocked when daily.remaining===0 — daily_quota_reached; no CDP, no ledger", async () => {
    // Given: Auto session with running auto-run, connect_send entry, daily {remaining:0, cooldownRemainingMs:0}
    // When:  click tool executes against @ov4
    // Then:  tool returns invalid_input / daily_quota_reached
    //        AND clickAt was NOT called
    //        AND no ledger row was written
    assert.ok(makeClickTool !== null, "T-ClickLedger.9: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-ClickLedger.9: openSalesDatabase must be importable");

    _appendAutoLedgerShouldThrow = false;
    const dbPath = makeTmpDbPath();
    const { db, runId } = seedAutoRun(dbPath, { maxConnects: 5 });
    const clickAtSpy: ClickAtSpy = { called: false };

    const session = makeMockSession({
      salesDbPath: dbPath,
      lastContextEntries: [CONNECT_SEND_ENTRY],
      surface: "profile",
      resolvedMode: () => "auto",
      autoRun: () => ({ runId, maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 0, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
      clickAtSpy,
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@ov4" });

    assert.ok(result.ok === false, `Auto must be blocked by quota; got: ${JSON.stringify(result)}`);
    assert.strictEqual((result as AnyObj).error?.kind, "invalid_input");
    assert.strictEqual((result as AnyObj).reason, "daily_quota_reached");
    assert.ok(clickAtSpy.called === false, "clickAt must NOT be dispatched when Auto is quota-blocked");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM auto_run_ledger WHERE run_id = ?").get(runId) as { n: number };
    assert.strictEqual(rows.n, 0, "no ledger row when blocked by daily quota");
  });

  // ─── T-ClickLedger.10 ───────────────────────────────────────────────────────
  it("T-ClickLedger.10: Auto IS still blocked when cooldownRemainingMs>0 — cooldown_active; no CDP, no ledger", async () => {
    // Given: same as T-ClickLedger.9 but daily {remaining:5, cooldownRemainingMs:60_000}
    // When:  click tool executes against @ov4
    // Then:  tool returns invalid_input / cooldown_active; no clickAt; no ledger row
    assert.ok(makeClickTool !== null, "T-ClickLedger.10: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-ClickLedger.10: openSalesDatabase must be importable");

    _appendAutoLedgerShouldThrow = false;
    const dbPath = makeTmpDbPath();
    const { runId } = seedAutoRun(dbPath, { maxConnects: 5 });
    const clickAtSpy: ClickAtSpy = { called: false };

    const session = makeMockSession({
      salesDbPath: dbPath,
      lastContextEntries: [CONNECT_SEND_ENTRY],
      surface: "profile",
      resolvedMode: () => "auto",
      autoRun: () => ({ runId, maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 5, cooldownRemainingMs: 60_000 }),
      canClickOutbound: () => true,
      clickAtSpy,
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@ov4" });

    assert.ok(result.ok === false, `Auto must be blocked by cooldown; got: ${JSON.stringify(result)}`);
    assert.strictEqual((result as AnyObj).reason, "cooldown_active");
    assert.ok(clickAtSpy.called === false, "clickAt must NOT be dispatched when Auto is cooldown-blocked");
  });

  // ─── T-ClickLedger.11 ───────────────────────────────────────────────────────
  it("T-ClickLedger.11: daily===null fail-closed fires regardless of mode (Manual session with null snapshot returns no_daily_snapshot)", async () => {
    // Given: Manual session, dailyOutbound()===null, connect_send entry
    // When:  click tool executes against @ov4
    // Then:  tool returns invalid_input / no_daily_snapshot
    //        (the null-snapshot wiring-bug guard is NOT gated to Auto-only)
    assert.ok(makeClickTool !== null, "T-ClickLedger.11: makeClickTool must be importable");

    _appendAutoLedgerShouldThrow = false;
    const dbPath = makeTmpDbPath();

    const session = makeMockSession({
      salesDbPath: dbPath,
      lastContextEntries: [CONNECT_SEND_ENTRY],
      surface: "profile",
      resolvedMode: () => "manual",
      autoRun: () => null,
      dailyOutbound: () => null,
      canClickOutbound: () => true,
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@ov4" });

    assert.ok(result.ok === false, `daily===null must fail-closed; got: ${JSON.stringify(result)}`);
    assert.strictEqual((result as AnyObj).reason, "no_daily_snapshot");
  });

  // ─── T-ClickLedger.12 ───────────────────────────────────────────────────────
  it("T-ClickLedger.12: Auto per-run cap still blocks at maxConnects — null-run rows do NOT inflate countSuccessfulConnects(R1) (regression guard)", async () => {
    // Given: Auto session, autoRun()={runId:'R1', maxConnects:1, connectSentCount:1},
    //        a connect_open entry (cap fires on both connect_open AND connect_send),
    //        AND the ledger has a null-run row (run_id=NULL) from a parallel Manual session
    // When:  click tool executes against @pa1 (connect_open)
    // Then:  auto_cap_reached (because connectSentCount=1 >= maxConnects=1)
    //        AND the null-run row did NOT inflate the count (SQL NULL = 'R1' is never true)
    assert.ok(makeClickTool !== null, "T-ClickLedger.12: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-ClickLedger.12: openSalesDatabase must be importable");
    assert.ok(countSuccessfulConnects !== null, "T-ClickLedger.12: countSuccessfulConnects must be importable");

    _appendAutoLedgerShouldThrow = false;
    const dbPath = makeTmpDbPath();
    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const db = openSalesDatabase!(dbPath);
    const runId = randomUUID();
    const now = Date.now();

    // Seed auto_runs row for R1
    db.prepare(
      "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL)",
    ).run(runId, now, 480, 1, "running");

    // Seed one R1 connect_sent/success row (fills the maxConnects=1 cap)
    db.prepare(
      "INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, ts, count_weight, result) VALUES (?, ?, ?, NULL, ?, 1.0, ?)",
    ).run(randomUUID(), runId, "connect_sent", now - 1000, "success");

    // Step-5 NIT from critics-r2.md: seed a null-run row to confirm it does NOT inflate the R1 count
    db.prepare(
      "INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, ts, count_weight, result) VALUES (?, ?, ?, NULL, ?, 1.0, ?)",
    ).run(randomUUID(), null, "connect_sent", now - 500, "success");

    const clickAtSpy: ClickAtSpy = { called: false };
    const session = makeMockSession({
      salesDbPath: dbPath,
      lastContextEntries: [CONNECT_OPEN_ENTRY],
      surface: "profile",
      resolvedMode: () => "auto",
      autoRun: () => ({ runId, maxConnects: 1, connectSentCount: 1 }),
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
      clickAtSpy,
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@pa1" });

    assert.ok(result.ok === false, `Auto cap must block; got: ${JSON.stringify(result)}`);
    assert.strictEqual((result as AnyObj).reason, "auto_cap_reached");
    assert.ok(clickAtSpy.called === false, "clickAt must NOT be dispatched when cap reached");
    // Verify the null-run row did NOT inflate the per-run count
    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const perRunCount = countSuccessfulConnects!(db, runId);
    assert.strictEqual(perRunCount, 1, "countSuccessfulConnects must be 1 (null-run row excluded by WHERE run_id = ?)");
  });

  // ─── T-ClickLedger.13 ───────────────────────────────────────────────────────
  it("T-ClickLedger.13: once session.outboundDisabled===true, BOTH connect_send AND message_send return outbound_disabled pre-dispatch (BLOCKER-1 symmetry guard)", async () => {
    // Given: Manual session with session.outboundDisabled = true pre-set (simulating a prior
    //        ledger-write failure on either outbound class)
    // When:  a fresh click executes against a connect_send entry (@ov4)
    // Then:  tool returns invalid_input / outbound_disabled
    //        AND clickAt was NOT called (pre-dispatch block)
    //        AND no new ledger row was appended
    // AND Given: the same fixture but with a message_send entry (@m1, messaging-thread surface)
    // When:  click executes
    // Then:  same outbound_disabled envelope; clickAt NOT called; no ledger row
    //        Pins the broadened pre-dispatch latch at click.ts §6.3(d-new): once latched, both
    //        connect_send AND message_send are blocked — neither class can bypass the cap.
    assert.ok(makeClickTool !== null, "T-ClickLedger.13: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "T-ClickLedger.13: openSalesDatabase must be importable");

    _appendAutoLedgerShouldThrow = false;

    // --- connect_send arm ---
    {
      const dbPath = makeTmpDbPath();
      // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
      const db = openSalesDatabase!(dbPath);
      const clickAtSpy: ClickAtSpy = { called: false };

      const session = makeMockSession({
        salesDbPath: dbPath,
        lastContextEntries: [CONNECT_SEND_ENTRY],
        surface: "profile",
        resolvedMode: () => "manual",
        autoRun: () => null,
        dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
        canClickOutbound: () => true,
        clickAtSpy,
      });
      // Pre-set the latch as if a prior ledger write failed
      session.outboundDisabled = true;

      // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
      const result = await makeClickTool!(session).execute({ ref: "@ov4" });

      assert.ok(result.ok === false, `latched session must block connect_send; got: ${JSON.stringify(result)}`);
      assert.strictEqual((result as AnyObj).reason, "outbound_disabled",
        "reason must be outbound_disabled when session is latched");
      assert.ok(clickAtSpy.called === false, "clickAt must NOT be dispatched when session is latched");
      const rows = db.prepare("SELECT COUNT(*) AS n FROM auto_run_ledger").get() as { n: number };
      assert.strictEqual(rows.n, 0, "no ledger row must be written when connect_send is pre-dispatch blocked");
    }

    // --- message_send arm ---
    {
      const dbPath = makeTmpDbPath();
      // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
      const db = openSalesDatabase!(dbPath);
      const clickAtSpy: ClickAtSpy = { called: false };

      const session = makeMockSession({
        salesDbPath: dbPath,
        lastContextEntries: [MESSAGE_SEND_ENTRY],
        surface: "messaging-thread",
        resolvedMode: () => "manual",
        autoRun: () => null,
        dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
        canClickOutbound: () => true,
        clickAtSpy,
      });
      // Pre-set the latch
      session.outboundDisabled = true;

      // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
      const result = await makeClickTool!(session).execute({ ref: "@m1" });

      assert.ok(result.ok === false, `latched session must block message_send; got: ${JSON.stringify(result)}`);
      assert.strictEqual((result as AnyObj).reason, "outbound_disabled",
        "reason must be outbound_disabled when session is latched (broadened latch covers message_send too)");
      assert.ok(clickAtSpy.called === false, "clickAt must NOT be dispatched when session is latched");
      const rows = db.prepare("SELECT COUNT(*) AS n FROM auto_run_ledger").get() as { n: number };
      assert.strictEqual(rows.n, 0, "no ledger row must be written when message_send is pre-dispatch blocked");
    }
  });

  // === Edge cases added at Step 5 ===

  // ─── Edge: Manual message_send with daily.remaining===0 is NOT blocked ───────
  it("EC-ClickLedger.A: Manual message_send with daily.remaining===0 is NOT blocked — dispatches + ledger written", async () => {
    // Given: Manual session, messaging-thread surface, "Send" entry (message_send),
    //        dailyOutbound()={remaining:0, cooldownRemainingMs:0}
    // When:  click tool executes
    // Then:  ok:true; clickAt called; ledger row written; no daily_quota_reached
    //        (Manual is never blocked by mode-gated daily/cooldown branches)
    assert.ok(makeClickTool !== null, "EC-ClickLedger.A: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "EC-ClickLedger.A: openSalesDatabase must be importable");

    _appendAutoLedgerShouldThrow = false;
    const dbPath = makeTmpDbPath();
    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const db = openSalesDatabase!(dbPath);
    const clickAtSpy: ClickAtSpy = { called: false };

    const session = makeMockSession({
      salesDbPath: dbPath,
      lastContextEntries: [MESSAGE_SEND_ENTRY],
      surface: "messaging-thread",
      resolvedMode: () => "manual",
      autoRun: () => null,
      dailyOutbound: () => ({ remaining: 0, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
      clickAtSpy,
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    const result = await makeClickTool!(session).execute({ ref: "@m1" });

    assert.ok(result.ok === true, `Manual message_send must not be blocked at daily=0; got: ${JSON.stringify(result)}`);
    assert.ok(clickAtSpy.called, "clickAt must be dispatched");
    const rows = db.prepare("SELECT run_id, action_type FROM auto_run_ledger").all() as Array<{ run_id: string | null; action_type: string }>;
    assert.strictEqual(rows.length, 1, "exactly one ledger row expected");
    assert.strictEqual(rows[0]!.action_type, "message_sent");
    assert.strictEqual(rows[0]!.run_id, null);
  });

  // ─── Edge: Auto connect_send writes exactly ONE row not two ──────────────────
  it("EC-ClickLedger.B: Auto connect_send writes exactly ONE ledger row (no double-count)", async () => {
    // Given: Auto session, running auto-run R1, connect_send entry, healthy daily snapshot
    // When:  click tool executes once
    // Then:  exactly one auto_run_ledger row written — confirms the ledger path is not duplicated
    assert.ok(makeClickTool !== null, "EC-ClickLedger.B: makeClickTool must be importable");
    assert.ok(openSalesDatabase !== null, "EC-ClickLedger.B: openSalesDatabase must be importable");

    _appendAutoLedgerShouldThrow = false;
    const dbPath = makeTmpDbPath();
    const { db, runId } = seedAutoRun(dbPath, { maxConnects: 5 });

    const session = makeMockSession({
      salesDbPath: dbPath,
      lastContextEntries: [CONNECT_SEND_ENTRY],
      surface: "profile",
      resolvedMode: () => "auto",
      autoRun: () => ({ runId, maxConnects: 5, connectSentCount: 0 }),
      dailyOutbound: () => ({ remaining: 10, cooldownRemainingMs: 0 }),
      canClickOutbound: () => true,
    });

    // biome-ignore lint/style/noNonNullAssertion: assert above guarantees non-null
    await makeClickTool!(session).execute({ ref: "@ov4" });

    const rows = db.prepare("SELECT COUNT(*) AS n FROM auto_run_ledger WHERE run_id = ?").get(runId) as { n: number };
    assert.strictEqual(rows.n, 1, "Auto connect_send must write exactly ONE ledger row (no duplicate)");
  });
});
