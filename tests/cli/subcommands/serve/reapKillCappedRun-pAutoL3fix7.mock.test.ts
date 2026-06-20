/**
 * P-AUTO-L3FIX-7 — watchdog-kill cap reaper. Mock tests for the injected-marker
 * helper `reapKillCappedRun(...)` plus tolerant marker-file parsing.
 *
 * Run (mock only):
 *   node --import tsx --test --test-force-exit tests/cli/subcommands/serve/reapKillCappedRun-pAutoL3fix7.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: raw DB access
type AnyDb = any;

const REAP_IDLE_MS = 360_000;
const WATCHDOG_KILL_CAP = 3;

function makeTmpPath(): string {
  return join(tmpdir(), `l3f7-reaper-${randomUUID()}.sqlite`);
}

async function openFreshDb(path: string): Promise<AnyDb> {
  const mod = await import("../../../../src/persistence/salesDb.js");
  return mod.openSalesDatabase(path);
}

function insertRawAutoRun(db: AnyDb, opts: { id?: string; startedAt: number; maxDurationMinutes?: number }): string {
  const id = opts.id ?? randomUUID();
  db.prepare(`
    INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters)
    VALUES (?, ?, NULL, ?, ?, 'running', NULL, NULL)
  `).run(id, opts.startedAt, opts.maxDurationMinutes ?? 480, 5);
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
  const mod = await import("../../../../src/cli/subcommands/serve/turn/reaper.js");
  return mod.reapKillCappedRun;
}

describe("P-AUTO-L3FIX-7 reapKillCappedRun — watchdog-kill cap close", () => {
  // Given an idle current run with 1..cap-1 attributable kills, When the reaper runs, Then it keeps the run and markers.
  it("T-L3F7.1: kills < cap with idle audit and ts >= startedAt → run stays running and markers are kept", async () => {
    const reapKillCappedRun = await importReaper();
    const db = await openFreshDb(makeTmpPath());
    const startedAt = Date.now() - 60_000;
    const runId = insertRawAutoRun(db, { startedAt });
    const state = makeState(runId);
    const emits: unknown[] = [];
    let clearCalls = 0;

    reapKillCappedRun(
      db,
      state,
      false,
      (f: unknown) => emits.push(f),
      400_000,
      REAP_IDLE_MS,
      [startedAt, startedAt + 1],
      WATCHDOG_KILL_CAP,
      () => {
        clearCalls += 1;
      },
    );

    assert.equal(readAutoRunRow(db, runId)?.status, "running", "sub-cap run must stay running");
    assert.equal(emits.length, 0, "sub-cap run must not emit completion");
    assert.equal(clearCalls, 0, "1..cap-1 attributable markers must be kept");
  });

  // Given an idle current run with cap attributable kills, When the reaper runs, Then it closes, emits once, and clears markers.
  it("T-L3F7.2: kills >= cap with idle audit and ts >= startedAt → close stopped_by_agent, emit once, clear markers", async () => {
    const reapKillCappedRun = await importReaper();
    const db = await openFreshDb(makeTmpPath());
    const startedAt = Date.now() - 60_000;
    const runId = insertRawAutoRun(db, { startedAt });
    const state = makeState(runId);
    const emits: Array<{ type?: string; runId?: string; status?: string; summary?: string }> = [];
    let clearCalls = 0;

    reapKillCappedRun(
      db,
      state,
      false,
      (f) => emits.push(f as never),
      400_000,
      REAP_IDLE_MS,
      [startedAt, startedAt + 1, startedAt + 2],
      WATCHDOG_KILL_CAP,
      () => {
        clearCalls += 1;
      },
    );

    const row = readAutoRunRow(db, runId);
    assert.equal(row?.status, "stopped_by_agent", "cap-hit run must close as stopped_by_agent");
    assert.match(row?.summary ?? "", /Watchdog restart cap reached/, "summary must name the watchdog cap");
    assert.equal(emits.length, 1, "completion frame must emit exactly once");
    assert.equal(emits[0]?.type, "auto-run-completed");
    assert.equal(emits[0]?.runId, runId);
    assert.equal(emits[0]?.status, "stopped_by_agent");
    assert.match(emits[0]?.summary ?? "", /Watchdog restart cap reached/);
    assert.equal(clearCalls, 1, "cap-hit close must clear markers");
    assert.equal(state.autoRunId, null, "non-cron self-emit path must clear tracked run state");
  });

  // Given only pre-run marker timestamps, When the reaper runs, Then it prunes stale markers without closing the current run.
  it("T-L3F7.3: kills with ts < startedAt only → no close and stale markers are cleared", async () => {
    const reapKillCappedRun = await importReaper();
    const db = await openFreshDb(makeTmpPath());
    const startedAt = Date.now() - 60_000;
    const runId = insertRawAutoRun(db, { startedAt });
    const state = makeState(runId);
    const emits: unknown[] = [];
    let clearCalls = 0;

    reapKillCappedRun(
      db,
      state,
      false,
      (f: unknown) => emits.push(f),
      400_000,
      REAP_IDLE_MS,
      [startedAt - 2_000, startedAt - 1_000],
      WATCHDOG_KILL_CAP,
      () => {
        clearCalls += 1;
      },
    );

    assert.equal(readAutoRunRow(db, runId)?.status, "running", "prior-run kills must not close current run");
    assert.equal(emits.length, 0, "prior-run-only markers must not emit");
    assert.equal(clearCalls, 1, "prior-run-only markers must be pruned");
  });

  // Given cap-count markers but a recent audit mtime, When the reaper runs, Then the audit-idle safety gate wins.
  it("T-L3F7.4: audit NOT idle but count >= cap → no close", async () => {
    const reapKillCappedRun = await importReaper();
    const db = await openFreshDb(makeTmpPath());
    const startedAt = Date.now() - 60_000;
    const runId = insertRawAutoRun(db, { startedAt });
    const state = makeState(runId);
    const emits: unknown[] = [];
    let clearCalls = 0;

    reapKillCappedRun(
      db,
      state,
      false,
      (f: unknown) => emits.push(f),
      30_000,
      REAP_IDLE_MS,
      [startedAt, startedAt + 1, startedAt + 2],
      WATCHDOG_KILL_CAP,
      () => {
        clearCalls += 1;
      },
    );

    assert.equal(readAutoRunRow(db, runId)?.status, "running", "recent audit must block the cap close");
    assert.equal(emits.length, 0, "recent audit must not emit completion");
    assert.equal(clearCalls, 0, "recent audit exits before marker pruning");
  });

  // Given no current running run and leftover markers, When the reaper runs, Then it only prunes the marker file.
  it("T-L3F7.5: no current running run + non-empty markers → no close and clear markers", async () => {
    const reapKillCappedRun = await importReaper();
    const db = await openFreshDb(makeTmpPath());
    const state = makeState(null);
    const emits: unknown[] = [];
    let clearCalls = 0;

    reapKillCappedRun(
      db,
      state,
      false,
      (f: unknown) => emits.push(f),
      400_000,
      REAP_IDLE_MS,
      [Date.now()],
      WATCHDOG_KILL_CAP,
      () => {
        clearCalls += 1;
      },
    );

    assert.equal(emits.length, 0, "no running run must not emit");
    assert.equal(clearCalls, 1, "leftover markers must be pruned when no run is current");
  });
});

describe("P-AUTO-L3FIX-7 watchdog kill marker file parsing", () => {
  // Given a missing file and then malformed marker lines, When timestamps are read, Then parsing is tolerant and returns [].
  it("T-L3F7.6: malformed or missing marker file → readWatchdogKillTimestamps returns [] without throwing", async () => {
    const paths = await import("../../../../src/persistence/paths.js");
    const prevHomeBase = process.env.FRONDOSE_HOME_BASE;
    const tmpHome = join(tmpdir(), `l3f7-paths-${randomUUID()}`);
    try {
      process.env.FRONDOSE_HOME_BASE = tmpHome;
      assert.deepEqual(paths.readWatchdogKillTimestamps(), [], "missing marker file must read as []");

      const markerPath = paths.WATCHDOG_KILLS_PATH();
      mkdirSync(dirname(markerPath), { recursive: true });
      writeFileSync(markerPath, '\nnot-json\n{"ts":"bad"}\n{"ts":null}\n{}\n', "utf8");
      assert.deepEqual(paths.readWatchdogKillTimestamps(), [], "malformed/invalid-only marker file must read as []");

      writeFileSync(markerPath, '{"ts":123}\nnot-json\n{"ts":456}\n', "utf8");
      assert.deepEqual(
        paths.readWatchdogKillTimestamps(),
        [123, 456],
        "valid marker lines must survive malformed lines",
      );
    } finally {
      if (prevHomeBase === undefined) delete process.env.FRONDOSE_HOME_BASE;
      else process.env.FRONDOSE_HOME_BASE = prevHomeBase;
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
