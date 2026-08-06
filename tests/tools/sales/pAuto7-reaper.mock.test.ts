/**
 * P-AUTO-7 Step 3 — Test Scaffold (outside-in TDD, all assertions TODO/failing)
 *
 * T-A7.Reap.1   — operator path: past-cap, state.autoRunId=null, non-cron → reaper emits once + closes row
 * T-A7.Reap.2   — cron-matched path: past-cap, isCronTurn=true, state.autoRunId=run.id → reaper silent
 * T-A7.Reap.2b  — stale-id operator: past-cap, isCronTurn=false, state.autoRunId≠run.id → reaper emits once
 * T-A7.Reap.2c  — non-cron/matched: past-cap, isCronTurn=false, state.autoRunId=run.id → reaper emits once + clears state
 * T-A7.Reap.3   — no running row (Manual/Magical) → reaper no-ops
 * T-A7.Reap.4   — within-budget abort → reaper no-ops (independent cap recompute)
 * T-A7.Reap.5   — already-closed row (stopped_by_user) → getCurrentAutoRun→null → 0 emits
 * T-A7.Reap.6   — DB throws inside reaper → swallowed, no rethrow
 * T-A7.Resume.1 — start_auto_run: past-cap orphan force-closed + fresh row inserted
 * T-A7.Resume.2 — start_auto_run: within-budget run → passthrough (resumed:true, same id)
 *
 * Gates covered:
 *   G-A7.1 (Reap.1, Reap.2, Reap.2b, Reap.2c) — exactly-one emit across all reachable cells
 *   G-A7.2 (Reap.3, Reap.4, Reap.5)           — no false reaps
 *   G-A7.3 (Reap.6)                            — finally never throws
 *   G-A7.4 (Resume.1, Resume.2)                — start_auto_run force-close + passthrough
 *
 * Builder seam required:
 *   export function reapExpiredAutoRun(
 *     db: DB,
 *     state: { autoRunId: string | null; lastEmittedAutoCounters: Record<string, number> | null },
 *     isCronTurn: boolean,
 *     emitFrame: (frame: unknown) => void,
 *   ): void
 *   — exported from src/app/backend/turn/runOne.ts (preferred) or a new helper module.
 *   If the builder inlines the reaper into runOne's finally instead of extracting, Step 5
 *   validator will drive runOneTurn via a full harness — but extraction is strongly preferred.
 *
 * Run (mock only):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/tools/sales/pAuto7-reaper.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution + raw DB access
type AnyFn = (...args: any[]) => any;
// biome-ignore lint/suspicious/noExplicitAny: raw DB access
type AnyDb = any;

// ─── Harness helpers ──────────────────────────────────────────────────────────

/** Unique temp DB path per test. */
function makeTmpPath(): string {
  return join(tmpdir(), `auto7-reaper-${randomUUID()}.sqlite`);
}

/**
 * Open a fresh sales DB using the barrel's openSalesDatabase (applies migrations).
 * Returns the DB handle directly (openSalesDatabase returns better-sqlite3 DB).
 */
async function openFreshDb(path: string): Promise<AnyDb> {
  const mod = await import("../../../src/persistence/salesDb.js");
  return mod.openSalesDatabase(path);
}

/**
 * Insert a raw auto_runs row with a controllable started_at.
 * We bypass insertAutoRun() so we can control the started_at timestamp directly.
 */
function insertRawAutoRun(
  db: AnyDb,
  opts: {
    id?: string;
    startedAt: number;
    maxDurationMinutes: number;
    maxConnects?: number;
    status?: string;
  },
): string {
  const id = opts.id ?? randomUUID();
  db.prepare(`
    INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters)
    VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL)
  `).run(id, opts.startedAt, opts.maxDurationMinutes, opts.maxConnects ?? 5, opts.status ?? "running");
  return id;
}

/** Read raw auto_runs row by id. */
function readAutoRunRow(db: AnyDb, id: string): AnyDb {
  return db.prepare("SELECT * FROM auto_runs WHERE id = ?").get(id) ?? null;
}

/** Build a minimal ServeState-compatible state object for the reaper. */
function makeState(opts: { autoRunId?: string | null; lastEmittedAutoCounters?: Record<string, number> | null }): {
  autoRunId: string | null;
  lastEmittedAutoCounters: Record<string, number> | null;
} {
  return {
    autoRunId: opts.autoRunId ?? null,
    lastEmittedAutoCounters: opts.lastEmittedAutoCounters ?? null,
  };
}

// ─── Reaper helper import (attempted at test time) ───────────────────────────
// Builder must export `reapExpiredAutoRun` from runOne.ts (or a helper module).
// If not yet exported, each test calls assert.fail with a clear seam message.

async function importReaper(): Promise<AnyFn | null> {
  try {
    const mod = await import("../../../src/app/backend/turn/reaper.js");
    // biome-ignore lint/suspicious/noExplicitAny: runtime probe
    return (mod as any).reapExpiredAutoRun ?? null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// G-A7.1 — Exactly-one emit: reaper emits on non-cron paths, silent on cron-matched
// ─────────────────────────────────────────────────────────────────────────────

describe("T-A7.Reap — auto-run reaper exactly-one-emit (P-AUTO-7)", () => {
  // ─── T-A7.Reap.1 ─────────────────────────────────────────────────────────

  it("T-A7.Reap.1: when past-cap running row + state.autoRunId=null + isCronTurn=false, reapExpiredAutoRun closes row + emits exactly one auto-run-completed frame", async () => {
    // Given: DB has a running auto_runs row whose started_at is (maxDurationMinutes*60000 + 1) ms in the past
    //        state.autoRunId=null (operator-started, no cron tracking)
    //        isCronTurn=false
    // When:  reapExpiredAutoRun(db, state, false, emitSpy) called
    // Then:  row is status='stopped_by_agent' + endedAt≠null + summary='Duration cap reached (auto-closed)'
    //        emitSpy called exactly once; frame.type='auto-run-completed'; frame.runId=run.id; frame.status='stopped_by_agent'
    //        state.autoRunId===null (was already null)

    const reapExpiredAutoRun = await importReaper();
    if (!reapExpiredAutoRun) {
      assert.fail("T-A7.Reap.1: reapExpiredAutoRun not exported from runOne.ts — builder seam missing");
    }

    const MAX_DUR = 30; // minutes
    const dbPath = makeTmpPath();
    const db = await openFreshDb(dbPath);
    const runId = insertRawAutoRun(db, {
      startedAt: Date.now() - (MAX_DUR * 60_000 + 1),
      maxDurationMinutes: MAX_DUR,
    });

    const state = makeState({ autoRunId: null });
    const emits: unknown[] = [];
    const emitSpy = (frame: unknown): void => {
      emits.push(frame);
    };

    // TODO: fill assertion body — currently placeholder to keep test red
    reapExpiredAutoRun(db, state, false, emitSpy);

    // Assert: row closed
    const row = readAutoRunRow(db, runId);
    assert.equal(row?.status, "stopped_by_agent", "T-A7.Reap.1: row.status must be stopped_by_agent");
    assert.ok(row?.ended_at !== null && row?.ended_at !== undefined, "T-A7.Reap.1: row.ended_at must be set");
    assert.equal(row?.summary, "Duration cap reached (auto-closed)", "T-A7.Reap.1: summary must match");

    // Assert: exactly one emit
    assert.equal(emits.length, 1, "T-A7.Reap.1: exactly one frame emitted");

    // Assert: frame shape
    const frame = emits[0] as Record<string, unknown>;
    assert.equal(frame.type, "auto-run-completed", "T-A7.Reap.1: frame.type must be auto-run-completed");
    assert.equal(frame.runId, runId, "T-A7.Reap.1: frame.runId must match the reaped row");
    assert.equal(frame.status, "stopped_by_agent", "T-A7.Reap.1: frame.status must be stopped_by_agent");

    // Assert: state.autoRunId still null (was null — reaper sets null on self-emit path but it was already null)
    assert.equal(state.autoRunId, null, "T-A7.Reap.1: state.autoRunId must remain null");
  });

  // ─── T-A7.Reap.2 ─────────────────────────────────────────────────────────

  it("T-A7.Reap.2: when past-cap running row + isCronTurn=true + state.autoRunId=run.id, reapExpiredAutoRun closes DB row + emits ZERO frames (cron post-handler will emit)", async () => {
    // Given: DB has a running past-cap auto_runs row
    //        isCronTurn=true, state.autoRunId=run.id (cron-matched path)
    // When:  reapExpiredAutoRun(db, state, true, emitSpy) called
    // Then:  row is closed (status='stopped_by_agent', endedAt≠null)
    //        emitSpy.length === 0 (cron's post-handler will emit — NOT the reaper)
    //        state.autoRunId === run.id (NOT cleared by reaper — cron will clear it)

    const reapExpiredAutoRun = await importReaper();
    if (!reapExpiredAutoRun) {
      assert.fail("T-A7.Reap.2: reapExpiredAutoRun not exported from runOne.ts — builder seam missing");
    }

    const MAX_DUR = 30;
    const dbPath = makeTmpPath();
    const db = await openFreshDb(dbPath);
    const runId = insertRawAutoRun(db, {
      startedAt: Date.now() - (MAX_DUR * 60_000 + 1),
      maxDurationMinutes: MAX_DUR,
    });

    const state = makeState({ autoRunId: runId });
    const emits: unknown[] = [];
    const emitSpy = (frame: unknown): void => {
      emits.push(frame);
    };

    // TODO: fill assertion body
    reapExpiredAutoRun(db, state, true, emitSpy);

    // Assert: row is closed
    const row = readAutoRunRow(db, runId);
    assert.equal(row?.status, "stopped_by_agent", "T-A7.Reap.2: row must be closed by reaper");
    assert.ok(row?.ended_at !== null && row?.ended_at !== undefined, "T-A7.Reap.2: row.ended_at must be set");

    // Assert: NO emit from reaper (cron's post-handler will emit)
    assert.equal(emits.length, 0, "T-A7.Reap.2: reaper must emit ZERO frames on cron-matched path");

    // Assert: state.autoRunId preserved (cron's post-handler needs it)
    assert.equal(
      state.autoRunId,
      runId,
      "T-A7.Reap.2: state.autoRunId must NOT be cleared by reaper on cron-matched path",
    );
  });

  // ─── T-A7.Reap.2b ────────────────────────────────────────────────────────

  it("T-A7.Reap.2b: when past-cap running row + isCronTurn=false + state.autoRunId=stale-id (≠run.id), reapExpiredAutoRun emits exactly ONE auto-run-completed for the reaped run", async () => {
    // Given: DB has a running past-cap row; state.autoRunId carries a DIFFERENT stale id; isCronTurn=false
    //        (non-cron turn — no cron post-handler will run)
    // When:  reapExpiredAutoRun(db, state, false, emitSpy) called
    // Then:  emitSpy called once; frame.runId === reaped run.id (NOT the stale id)
    //        state.autoRunId===null after (clear-on-self-emit prevents deferred cron re-emit)

    const reapExpiredAutoRun = await importReaper();
    if (!reapExpiredAutoRun) {
      assert.fail("T-A7.Reap.2b: reapExpiredAutoRun not exported — builder seam missing");
    }

    const MAX_DUR = 30;
    const dbPath = makeTmpPath();
    const db = await openFreshDb(dbPath);
    const runId = insertRawAutoRun(db, {
      startedAt: Date.now() - (MAX_DUR * 60_000 + 1),
      maxDurationMinutes: MAX_DUR,
    });

    const staleId = "stale-" + randomUUID();
    const state = makeState({ autoRunId: staleId });
    const emits: unknown[] = [];
    const emitSpy = (frame: unknown): void => {
      emits.push(frame);
    };

    // TODO: fill assertion body
    reapExpiredAutoRun(db, state, false, emitSpy);

    // Assert: exactly one emit
    assert.equal(emits.length, 1, "T-A7.Reap.2b: reaper must emit exactly ONE frame for the reaped run");

    // Assert: frame targets the reaped run (not the stale id)
    const frame = emits[0] as Record<string, unknown>;
    assert.equal(frame.type, "auto-run-completed", "T-A7.Reap.2b: frame.type must be auto-run-completed");
    assert.equal(frame.runId, runId, "T-A7.Reap.2b: frame.runId must be the reaped run id, not the stale id");

    // Assert: state.autoRunId cleared (non-cron self-emit always clears to prevent deferred re-emit)
    assert.equal(state.autoRunId, null, "T-A7.Reap.2b: state.autoRunId must be null after self-emit");
  });

  // ─── T-A7.Reap.2c ────────────────────────────────────────────────────────

  it("T-A7.Reap.2c: when past-cap running row + isCronTurn=false + state.autoRunId=run.id (matched but non-cron), reapExpiredAutoRun emits once AND clears state.autoRunId + lastEmittedAutoCounters", async () => {
    // Given: DB has a past-cap running row; state.autoRunId === run.id (prior cron run left this set)
    //        isCronTurn=false (operator-turn, no cron post-handler will run)
    // When:  reapExpiredAutoRun(db, state, false, emitSpy) called
    // Then:  emitSpy called exactly once (the reaper self-emits — cronWillEmit=false because isCronTurn=false)
    //        state.autoRunId === null AND state.lastEmittedAutoCounters === null after
    //        (so a future cron tick does NOT re-emit for this now-closed run)

    const reapExpiredAutoRun = await importReaper();
    if (!reapExpiredAutoRun) {
      assert.fail("T-A7.Reap.2c: reapExpiredAutoRun not exported — builder seam missing");
    }

    const MAX_DUR = 30;
    const dbPath = makeTmpPath();
    const db = await openFreshDb(dbPath);
    const runId = insertRawAutoRun(db, {
      startedAt: Date.now() - (MAX_DUR * 60_000 + 1),
      maxDurationMinutes: MAX_DUR,
    });

    const state = makeState({ autoRunId: runId, lastEmittedAutoCounters: { connect_sent: 3 } });
    const emits: unknown[] = [];
    const emitSpy = (frame: unknown): void => {
      emits.push(frame);
    };

    // TODO: fill assertion body
    reapExpiredAutoRun(db, state, false, emitSpy);

    // Assert: exactly one emit
    assert.equal(emits.length, 1, "T-A7.Reap.2c: reaper must emit exactly once on non-cron/matched path");

    // Assert: state fully cleared (deferred-dup fix)
    assert.equal(state.autoRunId, null, "T-A7.Reap.2c: state.autoRunId must be null after self-emit");
    assert.equal(
      state.lastEmittedAutoCounters,
      null,
      "T-A7.Reap.2c: state.lastEmittedAutoCounters must be null after self-emit",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G-A7.2 — No false reaps (within-budget, no row, already-closed)
// ─────────────────────────────────────────────────────────────────────────────

describe("T-A7.Reap — no false reaps (P-AUTO-7)", () => {
  // ─── T-A7.Reap.3 ─────────────────────────────────────────────────────────

  it("T-A7.Reap.3: when no running auto_runs row (Manual/Magical turn), reapExpiredAutoRun emits 0 frames and mutates nothing", async () => {
    // Given: DB has NO row with status='running' (Manual or Magical mode — getCurrentAutoRun returns null)
    //        state.autoRunId=null; isCronTurn=false
    // When:  reapExpiredAutoRun(db, state, false, emitSpy) called
    // Then:  emitSpy.length === 0; auto_runs table unchanged; state unchanged

    const reapExpiredAutoRun = await importReaper();
    if (!reapExpiredAutoRun) {
      assert.fail("T-A7.Reap.3: reapExpiredAutoRun not exported — builder seam missing");
    }

    const dbPath = makeTmpPath();
    const db = await openFreshDb(dbPath);
    // No row inserted — empty auto_runs table

    const state = makeState({ autoRunId: null });
    const emits: unknown[] = [];
    const emitSpy = (frame: unknown): void => {
      emits.push(frame);
    };

    // TODO: fill assertion body
    reapExpiredAutoRun(db, state, false, emitSpy);

    // Assert: no emits
    assert.equal(emits.length, 0, "T-A7.Reap.3: reaper must emit 0 frames when no running row");

    // Assert: DB untouched
    const rows = db.prepare("SELECT * FROM auto_runs").all();
    assert.equal(rows.length, 0, "T-A7.Reap.3: auto_runs must still be empty");

    // Assert: state unchanged
    assert.equal(state.autoRunId, null, "T-A7.Reap.3: state.autoRunId must remain null");
  });

  // ─── T-A7.Reap.4 ─────────────────────────────────────────────────────────

  it("T-A7.Reap.4: when running row started 10s ago (under cap), reapExpiredAutoRun does nothing — row stays running, 0 emits", async () => {
    // Given: DB has a running auto_runs row with started_at = now - 10_000ms (well under any cap)
    //        isCronTurn=false (e.g. D-27 silent-hang abort that didn't hit the duration cap)
    // When:  reapExpiredAutoRun(db, state, false, emitSpy) called
    // Then:  row.status still 'running'; row.ended_at still null; emitSpy.length === 0
    //        (proves reaper independently recomputes the cap, not just "turn was aborted")

    const reapExpiredAutoRun = await importReaper();
    if (!reapExpiredAutoRun) {
      assert.fail("T-A7.Reap.4: reapExpiredAutoRun not exported — builder seam missing");
    }

    const MAX_DUR = 30;
    const dbPath = makeTmpPath();
    const db = await openFreshDb(dbPath);
    const runId = insertRawAutoRun(db, {
      startedAt: Date.now() - 10_000, // 10s ago — well under 30min cap
      maxDurationMinutes: MAX_DUR,
    });

    const state = makeState({ autoRunId: null });
    const emits: unknown[] = [];
    const emitSpy = (frame: unknown): void => {
      emits.push(frame);
    };

    // TODO: fill assertion body
    reapExpiredAutoRun(db, state, false, emitSpy);

    // Assert: row untouched
    const row = readAutoRunRow(db, runId);
    assert.equal(row?.status, "running", "T-A7.Reap.4: row.status must still be 'running'");
    assert.equal(row?.ended_at, null, "T-A7.Reap.4: row.ended_at must still be null");

    // Assert: no emits
    assert.equal(emits.length, 0, "T-A7.Reap.4: reaper must emit 0 frames for within-budget row");
  });

  // ─── T-A7.Reap.5 ─────────────────────────────────────────────────────────

  it("T-A7.Reap.5: when prior closer (stopped_by_user) already ended the row, getCurrentAutoRun returns null, reapExpiredAutoRun emits 0 frames and does not overwrite the row", async () => {
    // Given: DB has a row with status='stopped_by_user' (cancelled via /workflow/cancel)
    //        getCurrentAutoRun filters on status='running' → returns null
    //        isCronTurn=false
    // When:  reapExpiredAutoRun(db, state, false, emitSpy) called
    // Then:  emitSpy.length === 0; row.status still 'stopped_by_user' (not overwritten)

    const reapExpiredAutoRun = await importReaper();
    if (!reapExpiredAutoRun) {
      assert.fail("T-A7.Reap.5: reapExpiredAutoRun not exported — builder seam missing");
    }

    const MAX_DUR = 30;
    const dbPath = makeTmpPath();
    const db = await openFreshDb(dbPath);
    const runId = insertRawAutoRun(db, {
      startedAt: Date.now() - (MAX_DUR * 60_000 + 1), // past-cap timestamp
      maxDurationMinutes: MAX_DUR,
      status: "stopped_by_user", // already ended by /workflow/cancel
    });
    // Manually set ended_at (raw insert left it NULL — set it to simulate the cancel)
    db.prepare("UPDATE auto_runs SET ended_at = ? WHERE id = ?").run(Date.now() - 1000, runId);

    const state = makeState({ autoRunId: null });
    const emits: unknown[] = [];
    const emitSpy = (frame: unknown): void => {
      emits.push(frame);
    };

    // TODO: fill assertion body
    reapExpiredAutoRun(db, state, false, emitSpy);

    // Assert: no emits (getCurrentAutoRun→null, reaper skips entirely)
    assert.equal(emits.length, 0, "T-A7.Reap.5: reaper must emit 0 frames when no running row exists");

    // Assert: row not overwritten
    const row = readAutoRunRow(db, runId);
    assert.equal(row?.status, "stopped_by_user", "T-A7.Reap.5: row.status must remain stopped_by_user");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G-A7.3 — finally never throws
// ─────────────────────────────────────────────────────────────────────────────

describe("T-A7.Reap.6 — reaper swallows internal errors (P-AUTO-7)", () => {
  it("T-A7.Reap.6: when the DB handle throws on getCurrentAutoRun, reapExpiredAutoRun does NOT rethrow", async () => {
    // Given: a DB handle that throws on any prepare() call (simulates closed handle or corrupt state)
    //        state.autoRunId=null; isCronTurn=false
    // When:  reapExpiredAutoRun(throwingDb, state, false, emitSpy) called
    // Then:  no exception propagates (turn teardown must complete)
    //        (if the reaper itself has try/catch; if runOne's finally wraps it, note that instead)

    const reapExpiredAutoRun = await importReaper();
    if (!reapExpiredAutoRun) {
      assert.fail("T-A7.Reap.6: reapExpiredAutoRun not exported — builder seam missing");
    }

    // Build a proxy DB that always throws
    const throwingDb = new Proxy(
      {},
      {
        get() {
          throw new Error("simulated DB failure");
        },
      },
    );

    const state = makeState({ autoRunId: null });
    const emits: unknown[] = [];
    const emitSpy = (frame: unknown): void => {
      emits.push(frame);
    };

    // TODO: fill assertion body — must not throw
    assert.doesNotThrow(
      () => reapExpiredAutoRun(throwingDb, state, false, emitSpy),
      "T-A7.Reap.6: reapExpiredAutoRun must swallow DB errors and not throw",
    );

    // Assert: no emits (error was swallowed before emit)
    assert.equal(emits.length, 0, "T-A7.Reap.6: no frames must be emitted when reaper errors internally");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G-A7.4 — start_auto_run force-close + passthrough
// ─────────────────────────────────────────────────────────────────────────────

describe("T-A7.Resume — start_auto_run force-close (P-AUTO-7)", () => {
  // ─── T-A7.Resume.1 ───────────────────────────────────────────────────────

  it("T-A7.Resume.1: when past-cap orphan row exists, start_auto_run force-closes stale row + inserts fresh row (resumed:false, new runId)", async () => {
    // Given: DB has a running auto_runs row whose started_at is past its maxDurationMinutes cap
    //        (the reaper hasn't run yet — simulates a fresh process start with a stale orphan)
    // When:  makeStartAutoRunTool(path).execute({}) called
    // Then:  stale row.status='stopped_by_agent', stale row.ended_at≠null
    //        a NEW row is inserted (auto_runs has 2 rows total)
    //        returned envelope: ok=true, output.runId≠stale runId, output.resumed=false

    const mod = await import("../../../src/tools/sales/startAutoRun.js");
    // biome-ignore lint/suspicious/noExplicitAny: runtime probe
    const makeStartAutoRunTool: AnyFn = (mod as any).makeStartAutoRunTool ?? null;
    if (!makeStartAutoRunTool) {
      assert.fail("T-A7.Resume.1: makeStartAutoRunTool not exported — builder seam missing");
    }

    const MAX_DUR = 30;
    const dbPath = makeTmpPath();
    const db = await openFreshDb(dbPath);
    const staleId = insertRawAutoRun(db, {
      startedAt: Date.now() - (MAX_DUR * 60_000 + 1),
      maxDurationMinutes: MAX_DUR,
    });

    // TODO: fill assertion body
    const tool = makeStartAutoRunTool(dbPath);
    const result = await tool.execute({ maxDurationMinutes: MAX_DUR, maxConnects: 5 });

    // Assert: ok envelope
    assert.ok(result.ok === true, `T-A7.Resume.1: envelope must be ok=true; got: ${JSON.stringify(result)}`);

    // Assert: stale row closed
    const staleRow = readAutoRunRow(db, staleId);
    assert.equal(staleRow?.status, "stopped_by_agent", "T-A7.Resume.1: stale row must be stopped_by_agent");
    assert.ok(
      staleRow?.ended_at !== null && staleRow?.ended_at !== undefined,
      "T-A7.Resume.1: stale row.ended_at must be set",
    );

    // Assert: a FRESH row inserted
    const newRunId = result.data?.runId;
    assert.ok(newRunId !== staleId, "T-A7.Resume.1: returned runId must differ from stale runId");
    assert.equal(result.data?.resumed, false, "T-A7.Resume.1: resumed must be false for a fresh row");

    // Assert: 2 rows in DB (stale + fresh)
    const allRows = db.prepare("SELECT * FROM auto_runs").all() as AnyDb[];
    assert.equal(allRows.length, 2, "T-A7.Resume.1: auto_runs must have 2 rows (stale closed + fresh running)");

    const freshRow = allRows.find((r: AnyDb) => r.id === newRunId);
    assert.ok(freshRow, "T-A7.Resume.1: fresh row must exist in auto_runs");
    assert.equal(freshRow?.status, "running", "T-A7.Resume.1: fresh row.status must be 'running'");
  });

  // ─── T-A7.Resume.2 ───────────────────────────────────────────────────────

  it("T-A7.Resume.2: when within-budget running row exists, start_auto_run returns same runId (resumed:true) + no new row + no endAutoRun", async () => {
    // Given: DB has a running auto_runs row started 10s ago (well under cap)
    // When:  makeStartAutoRunTool(path).execute({}) called
    // Then:  returned runId === original runId; resumed=true; auto_runs still has 1 row;
    //        the within-budget row's status is still 'running' (endAutoRun NOT called)

    const mod = await import("../../../src/tools/sales/startAutoRun.js");
    // biome-ignore lint/suspicious/noExplicitAny: runtime probe
    const makeStartAutoRunTool: AnyFn = (mod as any).makeStartAutoRunTool ?? null;
    if (!makeStartAutoRunTool) {
      assert.fail("T-A7.Resume.2: makeStartAutoRunTool not exported — builder seam missing");
    }

    const MAX_DUR = 30;
    const dbPath = makeTmpPath();
    const db = await openFreshDb(dbPath);
    const existingId = insertRawAutoRun(db, {
      startedAt: Date.now() - 10_000, // 10s ago — within 30min cap
      maxDurationMinutes: MAX_DUR,
    });

    // TODO: fill assertion body
    const tool = makeStartAutoRunTool(dbPath);
    const result = await tool.execute({ maxDurationMinutes: MAX_DUR, maxConnects: 5 });

    // Assert: ok envelope
    assert.ok(result.ok === true, `T-A7.Resume.2: envelope must be ok=true; got: ${JSON.stringify(result)}`);

    // Assert: same runId returned (passthrough)
    assert.equal(result.data?.runId, existingId, "T-A7.Resume.2: runId must be the existing within-budget run");
    assert.equal(result.data?.resumed, true, "T-A7.Resume.2: resumed must be true");

    // Assert: still only 1 row; row untouched
    const allRows = db.prepare("SELECT * FROM auto_runs").all() as AnyDb[];
    assert.equal(allRows.length, 1, "T-A7.Resume.2: auto_runs must still have exactly 1 row");
    assert.equal(allRows[0].status, "running", "T-A7.Resume.2: row.status must remain 'running'");
    assert.equal(allRows[0].ended_at, null, "T-A7.Resume.2: row.ended_at must remain null (not closed)");
  });
});
