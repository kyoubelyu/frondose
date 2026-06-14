/**
 * P-AUTO-12 Step 3 scaffold — T-CronNoProgress.12 + T-CronNoProgress.18
 * (exactly-once auto-run-completed matrix)
 *
 * Gate coverage:
 *   G-A12.17 — T-CronNoProgress.12 : duration cap takes precedence; reaper ends row;
 *               cron's pre-existing else-if branch emits 1 frame; no-progress check SKIPPED
 *   G-A12.24 — T-CronNoProgress.18 : across all four closure scenarios exactly 1 frame per run
 *
 * Design: exercises the F-2 emitter-ownership contract. For the duration-cap path
 * (Scenario A), the runOneTurn mock simulates the reaper by directly ending the auto_run
 * row in the DB and leaving state.autoRunId set (reaper skips clearing when cronWillEmit).
 * The test then drives a cron tick and confirms the pre-existing else-if branch at
 * cron.ts:153-174 is the one that emits — NOT the no-progress block (which is guarded
 * by `if (postRun)` that evaluates to false when the row is ended).
 *
 * Step-3 compile note: the no-progress block does not exist until Step 4. Until then,
 * only the G-A12.24 Scenario B assertion will fail (the new code path doesn't exist yet).
 * Scenarios A and C are already implemented (the else-if branch + reaper coordination
 * pre-exist) and may pass at Step 3. Scenario B is the new code — it FAILS at Step 3.
 *
 * Run (mock, single file):
 *   node --import tsx --test --test-force-exit \
 *     tests/cli/subcommands/serve/cron-autorun-exactly-once.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: pre-builder stubs
type AnyFn = (...args: any[]) => any;
// biome-ignore lint/suspicious/noExplicitAny: mock shapes
type MockRecord = Record<string, any>;

let createCronDriver: AnyFn | null = null;
let openSalesDatabase: AnyFn | null = null;
let endAutoRun: AnyFn | null = null;

before(async () => {
  const cronMod = await import("../../../../src/cli/subcommands/serve/cron.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  createCronDriver = (cronMod as any)?.createCronDriver ?? null;
  const dbMod = await import("../../../../src/persistence/salesDb.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  const db = dbMod as any;
  openSalesDatabase = db?.openSalesDatabase ?? null;
  endAutoRun = db?.endAutoRun ?? null;
});

function writeDueSchedule(schedulePath: string, taskText = "[AUTO_CONNECTS=5] [AUTO_DURATION=30] test run"): void {
  const record = {
    id: randomUUID(),
    task: taskText,
    cronExpr: "* * * * *",
    type: "recurring",
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
    lastRunAt: null,
    createdAt: new Date(Date.now() - 60000).toISOString(),
    enabled: true,
  };
  writeFileSync(schedulePath, `${JSON.stringify(record)}\n`);
}

function makeMockState(extra: Partial<MockRecord> = {}): MockRecord {
  return {
    cronEnabled: true,
    currentTurn: null,
    overlayContextId: undefined,
    unsubscribeContextId: undefined,
    unsubscribeOverlayEvents: undefined,
    passiveEnabled: false,
    lastTurnUserPrompt: null,
    lastFailedTurnPrompt: null,
    retryAttempts: 0,
    messages: [],
    passiveProfileCache: new Map(),
    passiveLimiter: { check: () => ({ allowed: true }) },
    sseClients: new Set(),
    autoRunId: null,
    lastEmittedAutoCounters: null,
    cronNoProgressRunId: null,
    cronNoProgressTurns: 0,
    ...extra,
  };
}

function makeMockDeps(schedulePath: string, salesDbPath: string, emittedFrames: unknown[]): MockRecord {
  return {
    model: null,
    system: "test-system",
    systemResume: "test-resume",
    tools: {},
    maxSteps: 200,
    auditWriter: { write: () => {} },
    session: { getClient: () => null, getOrInitClient: async () => ({ ok: false }) },
    schedulePath,
    salesDbPath,
    auditPath: "/dev/null",
    expectedToken: Buffer.from("test"),
    workflow: { handleEndpoint: () => ({ status: 200, response: { ok: true } }) },
    emitFrame: (frame: unknown) => { emittedFrames.push(frame); },
    emitOverlayEvent: () => {},
  };
}

// ─── T-CronNoProgress.12 — G-A12.17 — duration cap takes precedence ──────────

describe("T-CronNoProgress.12: duration cap takes precedence — reaper ends row; cron else-if emits ONE frame; no-progress check SKIPPED (G-A12.17)", () => {
  it("when reaper ends the row (postRun===null, state.autoRunId still set), no-progress check is skipped; existing else-if branch emits exactly 1 auto-run-completed frame", async () => {
    // Given: cronNoProgressTurns=9 (one away from threshold=10); runOneTurn mock simulates the
    //        P-AUTO-7 reaper by: calling endAutoRun(db, runId, {status:'stopped_by_agent',
    //        summary:'Duration cap reached...'}) but NOT clearing state.autoRunId (reaper skips
    //        clear when cronWillEmit=true for matched cron turn)
    // When:  cron post-turn block runs
    // Then:  if(postRun) is FALSE (reaper ended the row) → no-progress code does NOT execute
    //        (no second endAutoRun, no cronNoProgressTurns increment);
    //        existing else-if(state.autoRunId !== null) branch emits exactly 1 auto-run-completed
    //        with status='stopped_by_agent' and summary matching /Duration cap/;
    //        state.autoRunId === null after the tick
    assert.ok(createCronDriver !== null && openSalesDatabase !== null && endAutoRun !== null, "imports required");

    const salesDbPath = join(tmpdir(), `eo-t12-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-eo-t12-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    const runId = randomUUID();
    const now = Date.now();
    // Seed an active run
    db.prepare(`INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, 480, 20, 'running', NULL, NULL)`)
      .run(runId, now);

    state.autoRunId = runId;
    state.cronNoProgressRunId = runId;
    state.cronNoProgressTurns = 9; // one tick from threshold

    writeDueSchedule(schedulePath);
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);

    // Simulate what the P-AUTO-7 reaper does for a matched cron turn:
    // ends the row in DB but does NOT clear state.autoRunId (cron's else-if handles clearing)
    const turn = {
      runOneTurn: async () => {
        // Reaper ends the row with duration summary
        endAutoRun!(openSalesDatabase!(salesDbPath), runId, {
          status: "stopped_by_agent",
          summary: "Duration cap reached by server safety net",
        });
        // Reaper DOES NOT clear state.autoRunId (cronWillEmit=true for matched cron run)
        // So state.autoRunId stays set here.
      },
    };

    const driver = createCronDriver!(state, deps, turn);
    await driver.tick();

    // Exactly 1 auto-run-completed frame (from the existing else-if branch)
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(completedFrames.length, 1,
      `Must emit exactly 1 auto-run-completed (from cron else-if, NOT from no-progress); got ${completedFrames.length}`);

    const cf = completedFrames[0] as any;
    assert.equal(cf.runId, runId);
    assert.equal(cf.status, "stopped_by_agent");
    assert.ok(
      /Duration cap/i.test(cf.summary ?? ""),
      `Frame summary must be the duration-cap summary (NOT no-progress summary); got: "${cf.summary}"`,
    );

    // state.autoRunId must be null (cleared by cron else-if, not by no-progress block)
    assert.equal(state.autoRunId, null, "state.autoRunId must be null after the else-if branch clears it");

    // IMPORTANT: cronNoProgressTurns must NOT have been incremented (no-progress check was SKIPPED)
    // Because postRun was null, the if(postRun) branch was false — the new no-progress code never ran.
    // The counter should still be 9 (or 0 if state was cleared by the else-if — the spec says
    // the else-if does NOT reset cronNoProgressTurns; that resets only on the NEXT tick's run-id change).
    // Either way it must NOT be 10 (threshold was not tripped by no-progress code on this tick).
    assert.notEqual(state.cronNoProgressTurns, 10,
      "cronNoProgressTurns must NOT reach 10 via no-progress path on a duration-cap tick (code was skipped)");
  });
});

// ─── T-CronNoProgress.18 — G-A12.24 — exactly-once across all four scenarios ─

describe("T-CronNoProgress.18: across all four closure scenarios, exactly 1 auto-run-completed frame is emitted per run (G-A12.24)", () => {
  // Scenario A: Duration cap (reaper ends + cron else-if emits)
  it("Scenario A (duration cap, matched cron): exactly 1 auto-run-completed frame", async () => {
    // Given: reaper ends the row mid-turn, state.autoRunId kept set (cronWillEmit)
    // When:  cron post-turn runs
    // Then:  1 frame from else-if branch; no-progress block does NOT run
    assert.ok(createCronDriver !== null && openSalesDatabase !== null && endAutoRun !== null, "imports required");

    const salesDbPath = join(tmpdir(), `eo-a-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-eo-a-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    const runId = randomUUID();
    db.prepare(`INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, 480, 20, 'running', NULL, NULL)`)
      .run(runId, Date.now());
    state.autoRunId = runId;

    writeDueSchedule(schedulePath);
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    const turn = {
      runOneTurn: async () => {
        endAutoRun!(openSalesDatabase!(salesDbPath), runId, { status: "stopped_by_agent", summary: "Duration cap reached by server safety net" });
        // reaper skips clearing state.autoRunId → stays set
      },
    };

    const driver = createCronDriver!(state, deps, turn);
    await driver.tick();

    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed" && f.runId === runId);
    assert.equal(completedFrames.length, 1, `Scenario A: expected 1 auto-run-completed; got ${completedFrames.length}`);

    const row = db.prepare("SELECT ended_at FROM auto_runs WHERE id = ?").get(runId) as any;
    assert.ok(row?.ended_at !== null, "Scenario A: auto_runs.ended_at must be set exactly once");
  });

  // Scenario B: No-progress cap (cron no-progress block ends + emits)
  it("Scenario B (no-progress cap): exactly 1 auto-run-completed frame with status=stopped_by_agent", async () => {
    // Given: FRONDOSE_CRON_NOPROGRESS_LIMIT=1; cronNoProgressTurns=0; noop turn
    // When:  tick() runs (first no-progress tick trips the threshold=1)
    // Then:  exactly 1 auto-run-completed frame with status='stopped_by_agent' from the no-progress block
    assert.ok(createCronDriver !== null && openSalesDatabase !== null, "imports required");

    const savedLimit = process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT = "1";

    try {
      const salesDbPath = join(tmpdir(), `eo-b-${randomUUID()}.sqlite`);
      const schedulePath = join(tmpdir(), `sched-eo-b-${randomUUID()}.jsonl`);
      const emittedFrames: unknown[] = [];
      const state = makeMockState();

      // biome-ignore lint/suspicious/noExplicitAny: test DB
      const db: any = openSalesDatabase!(salesDbPath);
      const runId = randomUUID();
      db.prepare(`INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, 480, 20, 'running', NULL, NULL)`)
        .run(runId, Date.now());
      state.autoRunId = runId;
      state.cronNoProgressRunId = runId;
      state.cronNoProgressTurns = 0;

      writeDueSchedule(schedulePath);
      const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
      const turn = { runOneTurn: async () => {} }; // noop — threshold=1 → closes on this tick

      const driver = createCronDriver!(state, deps, turn);
      await driver.tick();

      // biome-ignore lint/suspicious/noExplicitAny: frame type check
      const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed" && f.runId === runId);
      assert.equal(completedFrames.length, 1, `Scenario B: expected 1 auto-run-completed; got ${completedFrames.length}`);
      const cf = completedFrames[0] as any;
      assert.equal(cf.status, "stopped_by_agent", "Scenario B: status must be stopped_by_agent");

      const row = db.prepare("SELECT ended_at FROM auto_runs WHERE id = ?").get(runId) as any;
      assert.ok(row?.ended_at !== null, "Scenario B: auto_runs.ended_at must be set exactly once");
    } finally {
      if (savedLimit === undefined) delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
      else process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT = savedLimit;
    }
  });

  // Scenario C: Agent called end_auto_run (cron else-if emits)
  it("Scenario C (agent end_auto_run): exactly 1 auto-run-completed frame with status=completed", async () => {
    // Given: agent calls end_auto_run({status:'completed'}) mid-turn; postRun===null
    // When:  cron post-turn's else-if branch runs
    // Then:  exactly 1 auto-run-completed frame with status='completed'
    assert.ok(createCronDriver !== null && openSalesDatabase !== null && endAutoRun !== null, "imports required");

    const salesDbPath = join(tmpdir(), `eo-c-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-eo-c-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    const runId = randomUUID();
    db.prepare(`INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, 480, 20, 'running', NULL, NULL)`)
      .run(runId, Date.now());
    state.autoRunId = runId;

    writeDueSchedule(schedulePath);
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    const turn = {
      runOneTurn: async () => {
        endAutoRun!(openSalesDatabase!(salesDbPath), runId, { status: "completed", summary: "Agent completed the run" });
      },
    };

    const driver = createCronDriver!(state, deps, turn);
    await driver.tick();

    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed" && f.runId === runId);
    assert.equal(completedFrames.length, 1, `Scenario C: expected 1 auto-run-completed; got ${completedFrames.length}`);
    const cf = completedFrames[0] as any;
    assert.equal(cf.status, "completed", "Scenario C: status must be completed");

    const row = db.prepare("SELECT ended_at FROM auto_runs WHERE id = ?").get(runId) as any;
    assert.ok(row?.ended_at !== null, "Scenario C: auto_runs.ended_at must be set exactly once");
  });
});
