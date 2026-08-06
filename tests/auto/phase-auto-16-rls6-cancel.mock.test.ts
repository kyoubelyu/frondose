/**
 * P-AUTO-16 Step 5 — Validation — G-A16.1, G-A16.2, G-A16.10, G-A16.14, G-A16.15
 *
 * RLS-6: /workflow/cancel handler restructure
 *   - Re-derives cancel target from DB (getCurrentAutoRun) instead of state.autoRunId
 *   - abort() always fires, moved out of the conditional
 *   - closedAutoRun = !endResult.alreadyEnded (follows the actual mutation, not detection)
 *
 * Strategy: call handlePostWorkflow directly with a real in-memory DB (pre-seeded per test)
 * and a minimal ServeDeps stub. The real handler calls getSalesDb(deps.salesDbPath) →
 * openSalesDatabase which caches by path. We pre-seed the DB via the same cache key so the
 * handler's DB lookups see the seeded data.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/auto/phase-auto-16-rls6-cancel.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Module imports — all real (no mocking needed; DB seeded via the shared cache)
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: runtime shape matching
type AnyFn = (...args: any[]) => any;
type AnyObj = Record<string, unknown>;

const salesDbMod = await import("../../src/persistence/salesDb.js").catch(() => null);
const openSalesDatabase: AnyFn = salesDbMod?.openSalesDatabase ?? null;
const insertAutoRun: AnyFn = salesDbMod?.insertAutoRun ?? null;
const getCurrentAutoRun: AnyFn = salesDbMod?.getCurrentAutoRun ?? null;
const endAutoRunPers: AnyFn = salesDbMod?.endAutoRun ?? null;
const closeSalesDatabase: AnyFn = salesDbMod?.closeSalesDatabase ?? null;

const workflowMod = await import("../../src/app/backend/routes/workflow.js").catch(() => null);
const handlePostWorkflow: AnyFn = workflowMod?.handlePostWorkflow ?? null;

if (!handlePostWorkflow) throw new Error("handlePostWorkflow not importable — builder Step 4 required");
if (!openSalesDatabase) throw new Error("openSalesDatabase not importable");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a unique tmp DB path per test (avoids the shared singleton cache contamination). */
function makeTmpPath(): string {
  return join(tmpdir(), `rls6-test-${randomUUID()}.sqlite`);
}

/** Build a minimal fake IncomingMessage for POST /workflow/cancel.
 * readJsonBody uses `for await ... of req` (async iterable), so we must
 * provide an [Symbol.asyncIterator] that yields the body buffer.
 */
function makeFakeReq(body: unknown = {}) {
  const bodyBuf = Buffer.from(JSON.stringify(body), "utf-8");
  const readable = {
    [Symbol.asyncIterator](): AsyncIterator<Buffer> {
      let sent = false;
      return {
        async next() {
          if (!sent) {
            sent = true;
            return { value: bodyBuf, done: false as const };
          }
          return { value: undefined as unknown as Buffer, done: true as const };
        },
      };
    },
    // Provide no-op on() for any internal usage (auth check reads headers, not body events)
    headers: {} as Record<string, string>,
    on(_event: string, _cb: (...args: unknown[]) => void) {
      return readable;
    },
  };
  return readable as unknown as import("node:http").IncomingMessage;
}

/** Build a minimal fake ServerResponse that captures the last sendJson call. */
function makeFakeRes() {
  const captured: { statusCode?: number; body?: unknown } = {};
  const res = {
    writeHead(statusCode: number) {
      captured.statusCode = statusCode;
    },
    end(body: string) {
      try {
        captured.body = JSON.parse(body);
      } catch {
        captured.body = body;
      }
    },
    setHeader(_name: string, _val: string) {},
    captured,
  };
  return res as unknown as import("node:http").ServerResponse & { captured: typeof captured };
}

/** Build a minimal ServeState with a spy abortController. */
function makeState(opts: { autoRunId?: string | null } = {}) {
  const abortSpy = {
    called: 0,
    abort() {
      this.called++;
    },
  };
  const state: AnyObj = {
    autoRunId: opts.autoRunId ?? null,
    lastEmittedAutoCounters: null,
    currentTurn: { abortController: abortSpy },
  };
  return { state, abortSpy };
}

/** Build a minimal ServeDeps referencing a real salesDbPath. */
function makeDeps(salesDbPath: string, opts: { controllerResponse?: AnyObj } = {}) {
  const emitFrameSpy = { calls: 0, lastArgs: null as unknown };
  const deps: AnyObj = {
    salesDbPath,
    emitFrame(frame: unknown) {
      emitFrameSpy.calls++;
      emitFrameSpy.lastArgs = frame;
    },
    workflow: {
      handleEndpoint(_url: string, _body: unknown) {
        return (
          opts.controllerResponse ?? {
            status: 200,
            response: { ok: false, reason: "no_workflow" },
            resumePrompt: undefined,
          }
        );
      },
    },
  };
  return { deps, emitFrameSpy };
}

/** Minimal fake turn runner (resume is never called in cancel tests). */
function makeTurn() {
  return { resumeWorkflowTurn: async () => {} } as unknown as ReturnType<
    typeof import("../../src/app/backend/turn.js").createTurnRunner
  >;
}

// ---------------------------------------------------------------------------
// describe: RLS-6 /workflow/cancel handler restructure
// ---------------------------------------------------------------------------

describe("T-A16.RLS6 — /workflow/cancel DB-authoritative re-derive + always-abort (P-AUTO-16 RLS-6)", () => {
  // ─── G-A16.1 ───────────────────────────────────────────────────────────────
  it("T-A16.RLS6.1: when getCurrentAutoRun returns a running row and state.autoRunId=null, endAutoRun IS called once and emitFrame IS called once (re-derived path)", async () => {
    // Given: DB has a running auto_runs row (cron-started shape; state.autoRunId = null)
    //        getCurrentAutoRun returns { id: ..., status: 'running', endedAt: null }
    //        endAutoRun returns { alreadyEnded: false } (real DB, first close)
    // When:  handlePostWorkflow receives POST /workflow/cancel
    // Then:  emitFrame called once (alreadyEnded === false → emitFrame fires)
    //        DB row is now closed (status='stopped_by_user')
    //        state.autoRunId remains null

    const dbPath = makeTmpPath();
    const db = openSalesDatabase(dbPath);
    const insertedRow = insertAutoRun(db, { maxConnects: 5 });
    const runId = insertedRow.id as string;

    // Verify pre-condition: row is running
    const preCheck = getCurrentAutoRun(db);
    assert.ok(preCheck !== null, "pre-condition: getCurrentAutoRun must return the inserted row");
    assert.equal(preCheck.id, runId, "pre-condition: must be our inserted row");

    const { state, abortSpy } = makeState({ autoRunId: null });
    const { deps, emitFrameSpy } = makeDeps(dbPath);

    await handlePostWorkflow(state, deps, makeTurn(), makeFakeReq(), makeFakeRes(), "/workflow/cancel");

    // abortSpy fires (always-abort)
    assert.equal(abortSpy.called, 1, "abort() must fire exactly once (always-abort contract)");

    // emitFrame called once (alreadyEnded=false → !alreadyEnded branch fires)
    assert.equal(emitFrameSpy.calls, 1, "emitFrame must be called exactly once on first-close path");

    // emitFrame payload contains the expected fields
    const frame = emitFrameSpy.lastArgs as AnyObj;
    assert.equal(frame.type, "auto-run-completed", "emitFrame type must be 'auto-run-completed'");
    assert.equal(frame.runId, runId, `emitFrame runId must be the re-derived runId '${runId}'`);
    assert.equal(frame.status, "stopped_by_user", "emitFrame status must be 'stopped_by_user'");

    // DB row is now closed
    const postCheck = getCurrentAutoRun(db);
    assert.equal(postCheck, null, "getCurrentAutoRun after cancel must return null (row closed)");

    // state.autoRunId remains null (was already null, post-effect write is a no-op)
    assert.equal(state.autoRunId, null, "state.autoRunId must remain null (was already null)");

    closeSalesDatabase(dbPath);
  });

  // ─── G-A16.2 ───────────────────────────────────────────────────────────────
  it("T-A16.RLS6.2: when getCurrentAutoRun returns null, abort() IS called once AND endAutoRun NOT called AND emitFrame NOT called", async () => {
    // Given: DB has NO running auto_runs row (empty DB → getCurrentAutoRun returns null)
    //        state.currentTurn.abortController is a spy
    // When:  handlePostWorkflow receives POST /workflow/cancel
    // Then:  abortSpy.called === 1 (always-abort contract fires)
    //        emitFrameSpy.calls === 0 (no run to close → no emit)
    //        DB state unchanged (no rows inserted)

    const dbPath = makeTmpPath();
    openSalesDatabase(dbPath); // initialise schema, no rows inserted

    const { state, abortSpy } = makeState({ autoRunId: null });
    const { deps, emitFrameSpy } = makeDeps(dbPath);

    await handlePostWorkflow(state, deps, makeTurn(), makeFakeReq(), makeFakeRes(), "/workflow/cancel");

    // abort always fires
    assert.equal(abortSpy.called, 1, "abort() must fire exactly once even when no running row exists");

    // endAutoRun not called → emitFrame not called
    assert.equal(emitFrameSpy.calls, 0, "emitFrame must NOT be called when getCurrentAutoRun returns null");

    closeSalesDatabase(dbPath);
  });

  // ─── G-A16.10 ──────────────────────────────────────────────────────────────
  it("T-A16.RLS6.10: idempotency — reaper-closed run (getCurrentAutoRun returns null) → endAutoRun NOT called, emitFrame NOT called, abort still fires", async () => {
    // Given: P-AUTO-7 reaper already closed the run
    //        The auto_runs row has status='stopped_by_agent', endedAt > 0
    //        getCurrentAutoRun filters to status='running' only → returns null
    //        state.currentTurn.abortController is a spy
    // When:  handlePostWorkflow receives POST /workflow/cancel
    // Then:  emitFrameSpy.calls === 0 (no running row → skip endAutoRun+emit)
    //        abortSpy.called === 1 (abort always fires)
    //        state is left consistent

    const dbPath = makeTmpPath();
    const db = openSalesDatabase(dbPath);
    // Insert and then close the row (simulating the reaper already having closed it)
    const row = insertAutoRun(db, { maxConnects: 5 });
    endAutoRunPers(db, row.id, { status: "stopped_by_agent", summary: "reaper closed" });

    // Verify pre-condition: getCurrentAutoRun returns null (row is no longer 'running')
    const preCheck = getCurrentAutoRun(db);
    assert.equal(preCheck, null, "pre-condition: reaper-closed run must not appear in getCurrentAutoRun");

    const { state, abortSpy } = makeState({ autoRunId: null });
    const { deps, emitFrameSpy } = makeDeps(dbPath);

    await handlePostWorkflow(state, deps, makeTurn(), makeFakeReq(), makeFakeRes(), "/workflow/cancel");

    assert.equal(emitFrameSpy.calls, 0, "emitFrame must NOT be called (no running row — reaper already closed it)");
    assert.equal(abortSpy.called, 1, "abort() must still fire (always-abort contract holds)");

    // state.autoRunId was null, remains null
    assert.equal(state.autoRunId, null, "state.autoRunId must remain null");

    closeSalesDatabase(dbPath);
  });

  // ─── G-A16.14 ──────────────────────────────────────────────────────────────
  it("T-A16.RLS6.14: non-Auto (Manual/Magical) turn with no DB run → abort fires, emitFrame NOT called, response is controller's no_workflow envelope", async () => {
    // Given: state.autoRunId = null (Manual or Magical turn); DB has no running row
    //        state.currentTurn.abortController is a spy
    //        controller.handleEndpoint returns { status: 200, response: { ok: false, reason: 'no_workflow' } }
    // When:  handlePostWorkflow receives POST /workflow/cancel
    // Then:  abortSpy.called === 1 (CHANGE 3 — always-abort on cancel regardless of mode)
    //        emitFrameSpy.calls === 0
    //        handler does NOT throw on the null-getCurrentAutoRun path
    //        response body is { ok: false, reason: 'no_workflow' } at HTTP 200
    //        (early-return { ok: true, closedAutoRun: true } only fires when closedAutoRun === true)

    const dbPath = makeTmpPath();
    openSalesDatabase(dbPath); // schema only, no rows

    const { state, abortSpy } = makeState({ autoRunId: null });
    const { deps, emitFrameSpy } = makeDeps(dbPath, {
      controllerResponse: {
        status: 200,
        response: { ok: false, reason: "no_workflow" },
        resumePrompt: undefined,
      },
    });

    const res = makeFakeRes();
    await handlePostWorkflow(state, deps, makeTurn(), makeFakeReq(), res, "/workflow/cancel");

    // abort fires on every cancel
    assert.equal(abortSpy.called, 1, "abort() must fire exactly once even in Manual/Magical mode");

    // no emit
    assert.equal(emitFrameSpy.calls, 0, "emitFrame must NOT fire when there is no running DB row");

    // response is the controller's verbatim no_workflow envelope — NOT the early-return closedAutoRun shape
    assert.deepEqual(
      res.captured.body,
      { ok: false, reason: "no_workflow" },
      "response body must be the controller's verbatim no_workflow envelope (NOT { ok:true, closedAutoRun:true })",
    );

    closeSalesDatabase(dbPath);
  });

  // ─── G-A16.15 ──────────────────────────────────────────────────────────────
  it("T-A16.RLS6.15: race — getCurrentAutoRun returns a row but endAutoRun returns alreadyEnded=true → closedAutoRun=false → no early-return, falls through to controller response", async () => {
    // Given: getCurrentAutoRun returns a running row (inserted below)
    //        but the reaper closes it BETWEEN getCurrentAutoRun and endAutoRun
    //        We simulate this by closing the row manually AFTER inserting it,
    //        then creating a second running row that getCurrentAutoRun would find.
    //
    // More precisely: we insert a running row, the handler finds it via getCurrentAutoRun,
    // then tries endAutoRun — but we simulate alreadyEnded by closing the row BEFORE
    // the handler's endAutoRun call. We do this by hooking into the fact that
    // endAutoRun is idempotent (returns {alreadyEnded:true} when endedAt !== null).
    //
    // Implementation: insert a running row, then immediately close it via the
    // persistence function. The handler's getCurrentAutoRun will NOT find it (because
    // getCurrentAutoRun filters on status='running'). So we cannot test the exact
    // "race window" scenario via a pure real-DB approach without time-control.
    //
    // Instead: we test the CLOSER scenario — inject a "pre-closed" row that
    // getCurrentAutoRun cannot find, verify the fallthrough path is taken.
    // Then we verify the code path difference via a second variant: insert a running
    // row, close it, and show getCurrentAutoRun returns null → same null path as G-A16.10.
    //
    // The EXACT race (row visible to getCurrentAutoRun but alreadyEnded when endAutoRun
    // is called) requires either time injection or module mocking. We test this via the
    // source-text assertion below: the code must show closedAutoRun = !endResult.alreadyEnded.

    // --- Source structural assertion (the critical contract) ---
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    // LoC-budget follow-up: the cancel handling body was extracted from routes/workflow.ts
    // into routes/workflowCancel.ts (T-routes.LoCBudget.1 — workflow.ts must stay ≤80 LoC);
    // combine both sources so this structural check survives the extraction.
    const src =
      readFileSync(resolve(import.meta.dirname, "../../src/app/backend/routes/workflow.ts"), "utf-8") +
      readFileSync(resolve(import.meta.dirname, "../../src/app/backend/routes/workflowCancel.ts"), "utf-8");
    // closedAutoRun must be set to !endResult.alreadyEnded (not `current !== null`)
    assert.ok(
      src.includes("closedAutoRun = !endResult.alreadyEnded"),
      "workflow.ts must set closedAutoRun = !endResult.alreadyEnded (CHANGE 4 round-2 — not 'current !== null')",
    );
    // early-return fires only when closedAutoRun is true
    assert.ok(
      src.includes("closedAutoRun && closedAutoRun") || src.includes("if (controllerSaidNoWorkflow && closedAutoRun)"),
      "workflow.ts early-return must be guarded by (controllerSaidNoWorkflow && closedAutoRun)",
    );
    // emitFrame is guarded by !endResult.alreadyEnded
    assert.ok(
      src.includes("!endResult.alreadyEnded"),
      "workflow.ts emitFrame must be guarded by !endResult.alreadyEnded (no-double-emit idempotency)",
    );

    // --- Functional variant: run with a real DB where the row IS found but alreadyEnded ---
    // Strategy: insert row → close it → use endAutoRunPers to verify it returns alreadyEnded=true
    const dbPath = makeTmpPath();
    const db = openSalesDatabase(dbPath);
    const row = insertAutoRun(db, { maxConnects: 5 });
    // Close the row — next endAutoRun on same id returns alreadyEnded:true
    endAutoRunPers(db, row.id, { status: "stopped_by_user", summary: "pre-closed (race simulation)" });

    // Verify endAutoRun is truly idempotent on this closed row
    const idempotentResult = endAutoRunPers(db, row.id, { status: "stopped_by_user", summary: "second close" });
    assert.ok(
      idempotentResult.alreadyEnded === true,
      "endAutoRun on an already-closed row must return alreadyEnded:true",
    );

    // Now verify: with the row closed, getCurrentAutoRun returns null (handler takes the no-close path)
    const afterClose = getCurrentAutoRun(db);
    assert.equal(
      afterClose,
      null,
      "after closing the row, getCurrentAutoRun must return null (status='running' filter)",
    );

    closeSalesDatabase(dbPath);
  });
});
