/**
 * P-AUTO-L3FIX-5 — orphan-run reaper (audit-idleness gated). Mock tests for the
 * injected-idle helper `reapOrphanIfIdle(db, state, isCronTurn, emit, auditIdleMs, reapIdleMs)`.
 *
 * T-L3F5.1 — audit RECENT (< reapIdleMs, models an in-flight tool incl. the 45s CDP click) → NO close, NO emit
 * T-L3F5.2 — sleep window (auditIdleMs=305s < 360s) → NO close (legit long sleep not false-closed)
 * T-L3F5.3 — orphan: past-cap + audit idle > reapIdleMs + autoRunId=null + non-cron → close + exactly-one emit + state cleared
 * T-L3F5.4 — within-cap: audit idle > reapIdleMs BUT run younger than cap → reapExpiredAutoRun's own guard keeps it open
 * T-L3F5.5 — no running row → no-op
 * T-L3F5.6 — boot/missing-audit: auditIdleMs=Infinity + no running row → no-op (no throw)
 *
 * Run (mock only):
 *   node --import tsx --test --test-force-exit tests/cli/subcommands/serve/reapOrphanIfIdle-pAutoL3fix5.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: raw DB access
type AnyDb = any;

const REAP_IDLE_MS = 360_000;

function makeTmpPath(): string {
  return join(tmpdir(), `l3f5-reaper-${randomUUID()}.sqlite`);
}

async function openFreshDb(path: string): Promise<AnyDb> {
  const mod = await import("../../../../src/persistence/salesDb.js");
  return mod.openSalesDatabase(path);
}

function insertRawAutoRun(
  db: AnyDb,
  opts: { id?: string; startedAt: number; maxDurationMinutes: number; status?: string },
): string {
  const id = opts.id ?? randomUUID();
  db.prepare(`
    INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters)
    VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL)
  `).run(id, opts.startedAt, opts.maxDurationMinutes, 5, opts.status ?? "running");
  return id;
}

function readAutoRunRow(db: AnyDb, id: string): AnyDb {
  return db.prepare("SELECT * FROM auto_runs WHERE id = ?").get(id) ?? null;
}

function makeState(autoRunId: string | null): {
  autoRunId: string | null;
  lastEmittedAutoCounters: Record<string, number> | null;
} {
  return { autoRunId, lastEmittedAutoCounters: null };
}

async function importReaper() {
  const mod = await import("../../../../src/app/backend/turn/reaper.js");
  return mod.reapOrphanIfIdle;
}

const PAST_CAP_DUR = 30; // minutes
function pastCapStartedAt(): number {
  return Date.now() - (PAST_CAP_DUR * 60_000 + 1);
}

describe("P-AUTO-L3FIX-5 reapOrphanIfIdle — audit-idleness gated orphan close", () => {
  // Given a past-cap running run but the audit log was touched recently (a tool is in-flight, incl. the
  // 45s-bounded CDP connect click), When the reaper runs, Then it must NOT close (no dropped ledger).
  it("T-L3F5.1: audit RECENT (< reapIdleMs) → no close, no emit", async () => {
    const reapOrphanIfIdle = await importReaper();
    const db = await openFreshDb(makeTmpPath());
    const runId = insertRawAutoRun(db, { startedAt: pastCapStartedAt(), maxDurationMinutes: PAST_CAP_DUR });
    const state = makeState(null);
    const emits: unknown[] = [];
    reapOrphanIfIdle(db, state, false, (f: unknown) => emits.push(f), 30_000, REAP_IDLE_MS);
    assert.equal(readAutoRunRow(db, runId)?.status, "running", "must stay running while audit is recent");
    assert.equal(emits.length, 0, "no emit while audit recent");
  });

  // Given a legit long sleep (audit idle 305s < 360s), Then the reaper must not mistake it for a dead turn.
  it("T-L3F5.2: sleep window (auditIdleMs=305s < 360s) → no close", async () => {
    const reapOrphanIfIdle = await importReaper();
    const db = await openFreshDb(makeTmpPath());
    const runId = insertRawAutoRun(db, { startedAt: pastCapStartedAt(), maxDurationMinutes: PAST_CAP_DUR });
    const state = makeState(null);
    const emits: unknown[] = [];
    reapOrphanIfIdle(db, state, false, (f: unknown) => emits.push(f), 305_000, REAP_IDLE_MS);
    assert.equal(readAutoRunRow(db, runId)?.status, "running", "sleep within 360s must not be reaped");
    assert.equal(emits.length, 0);
  });

  // Given the capstone orphan (past-cap, audit idle > 360s, no active turn), Then close + emit once + clear state.
  it("T-L3F5.3: orphan (past-cap + audit idle > reapIdleMs) → close + one emit + state cleared", async () => {
    const reapOrphanIfIdle = await importReaper();
    const db = await openFreshDb(makeTmpPath());
    const runId = insertRawAutoRun(db, { startedAt: pastCapStartedAt(), maxDurationMinutes: PAST_CAP_DUR });
    const state = makeState(null);
    const emits: Array<{ type?: string; runId?: string; status?: string }> = [];
    reapOrphanIfIdle(db, state, false, (f) => emits.push(f as never), 400_000, REAP_IDLE_MS);
    const row = readAutoRunRow(db, runId);
    assert.equal(row?.status, "stopped_by_agent", "orphan must be closed");
    assert.ok(row?.ended_at != null, "ended_at set");
    assert.equal(emits.length, 1, "exactly one auto-run-completed emit");
    assert.equal(emits[0]?.type, "auto-run-completed");
    assert.equal(emits[0]?.runId, runId);
    assert.equal(state.autoRunId, null, "state.autoRunId cleared (was null; stays null)");
  });

  // Given audit idle > threshold BUT the run is still within its cap, Then reapExpiredAutoRun's own guard keeps it open.
  it("T-L3F5.4: within-cap run (audit idle > reapIdleMs) → not closed", async () => {
    const reapOrphanIfIdle = await importReaper();
    const db = await openFreshDb(makeTmpPath());
    const runId = insertRawAutoRun(db, { startedAt: Date.now(), maxDurationMinutes: PAST_CAP_DUR });
    const state = makeState(null);
    const emits: unknown[] = [];
    reapOrphanIfIdle(db, state, false, (f: unknown) => emits.push(f), 400_000, REAP_IDLE_MS);
    assert.equal(readAutoRunRow(db, runId)?.status, "running", "within-cap run must not be reaped");
    assert.equal(emits.length, 0);
  });

  // Given no running row (Manual/Magical/idle), Then no-op.
  it("T-L3F5.5: no running run → no-op", async () => {
    const reapOrphanIfIdle = await importReaper();
    const db = await openFreshDb(makeTmpPath());
    const state = makeState(null);
    const emits: unknown[] = [];
    reapOrphanIfIdle(db, state, false, (f: unknown) => emits.push(f), 400_000, REAP_IDLE_MS);
    assert.equal(emits.length, 0, "no emit when there is no running run");
  });

  // Given a missing audit file (auditIdleMs=Infinity at boot) + no running run, Then no-op, no throw.
  it("T-L3F5.6: boot/missing-audit (Infinity idle) + no running run → no-op", async () => {
    const reapOrphanIfIdle = await importReaper();
    const db = await openFreshDb(makeTmpPath());
    const state = makeState(null);
    const emits: unknown[] = [];
    assert.doesNotThrow(() =>
      reapOrphanIfIdle(db, state, false, (f: unknown) => emits.push(f), Number.POSITIVE_INFINITY, REAP_IDLE_MS),
    );
    assert.equal(emits.length, 0);
  });
});
