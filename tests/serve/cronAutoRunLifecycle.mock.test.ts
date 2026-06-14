/**
 * P-SP-E Step 5 — T-E.Cron.1..8 (G-PSPE.8..11) — assertions filled.
 * cron.ts lifecycle integration: AUTO_RUN_ID injection + duration safety net +
 * progress frame + post-turn end-detection + progress de-dup (CONCERN-MR-2 + MR-5).
 *
 * STEP 5 FIXES:
 *   1. writeDueSchedule fixed to use JSONL format (readSchedule reads line-by-line)
 *      and includes required `type: "recurring"` field.
 *   2. T-E.Cron.7 (CONCERN-MR-5 de-dup) will FAIL — de-duplication was NOT
 *      implemented in cron.ts. DEFECT D-SP-E-Cron.7.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/serve/cronAutoRunLifecycle.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: pre-builder stubs (ServeState + ServeDeps not yet extended)
type AnyFn = (...args: any[]) => any;
// biome-ignore lint/suspicious/noExplicitAny: mock state shape
type MockState = Record<string, any>;
// biome-ignore lint/suspicious/noExplicitAny: mock deps shape
type MockDeps = Record<string, any>;

let createCronDriver: AnyFn;
let openSalesDatabase: AnyFn;
let endAutoRun: AnyFn;
let appendAutoLedger: AnyFn;

before(async () => {
  const cronMod = await import("../../src/cli/subcommands/serve/cron.js").catch(() => null);
  createCronDriver = cronMod?.createCronDriver ?? null;

  const dbMod = await import("../../src/persistence/salesDb.js").catch(() => null);
  openSalesDatabase = dbMod?.openSalesDatabase ?? null;
  endAutoRun = dbMod?.endAutoRun ?? null;
  appendAutoLedger = dbMod?.appendAutoLedger ?? null;
});

/**
 * Write a JSONL schedule file with one due recurring job.
 * FIXED from scaffold: uses JSONL format (one record per line) + includes `type: "recurring"`.
 */
function writeDueSchedule(schedulePath: string, taskText: string): void {
  const now = Date.now();
  const record = {
    id: randomUUID(),
    task: taskText,
    cronExpr: "* * * * *",
    type: "recurring",
    nextRunAt: new Date(now - 1000).toISOString(), // 1 second ago = due now
    lastRunAt: null,
    createdAt: new Date(now - 60000).toISOString(),
    enabled: true,
  };
  // JSONL: one JSON object per line (NOT JSON array)
  writeFileSync(schedulePath, `${JSON.stringify(record)}\n`);
}

/** Build a minimal mock state (pre-builder: will be cast to ServeState). */
function makeMockState(extra: Partial<MockState> = {}): MockState {
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
    lastEmittedAutoCounters: null, // CONCERN-MR-5 field (NOT in actual ServeState — de-dup not implemented)
    ...extra,
  };
}

/** Build a minimal mock deps. */
function makeMockDeps(schedulePath: string, salesDbPath: string, emittedFrames: unknown[]): MockDeps {
  return {
    model: null,
    system: "test-system",
    systemResume: "test-resume",
    tools: {},
    maxSteps: 3,
    auditWriter: { write: () => {} },
    session: {
      getClient: () => null,
      getOrInitClient: async () => ({ ok: false }),
    },
    schedulePath,
    salesDbPath,
    auditPath: "/dev/null",
    expectedToken: Buffer.from("test"),
    workflow: {
      handleEndpoint: () => ({ status: 200, response: { ok: true } }),
    },
    emitFrame: (frame: unknown) => {
      emittedFrames.push(frame);
    },
    emitOverlayEvent: () => {},
  };
}

/** Noop turn runner. */
function makeNoopTurn(): { runOneTurn: AnyFn } {
  return {
    runOneTurn: async () => {},
  };
}

/** Helper: seed a running auto_run with specific started_at (using raw SQL). */
function seedRunningRow(db: AnyFn, startedAt: number, maxDurationMinutes: number, maxConnects: number | null): string {
  const id = randomUUID();
  (db as any)
    .prepare(
      "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, ?, ?, 'running', NULL, NULL)",
    )
    .run(id, startedAt, maxDurationMinutes, maxConnects);
  return id;
}

describe("T-E.Cron — cron.ts Auto lifecycle integration (P-SP-E Sketch E)", () => {
  // ─── T-E.Cron.1 ──────────────────────────────────────────────────────────────
  it("T-E.Cron.1: tick with NO running row + [AUTO_CONNECTS=5] [AUTO_DURATION=30] in task text → cronPrompt includes AUTO_RUN_ID + ELAPSED + CONNECTS_USED; state.autoRunId set; auto-run-started SSE emitted", async () => {
    // Given: empty auto_runs table; cron task text includes [AUTO_CONNECTS=5] [AUTO_DURATION=30]
    // When:  cron.tick() fires
    // Then:  (1) auto_runs has 1 new row with maxDurationMinutes=30 and maxConnects=5;
    //        (2) cronPrompt contains [AUTO_RUN_ID=<uuid>] AND [ELAPSED=0/30min] AND [CONNECTS_USED=0/5];
    //        (3) state.autoRunId is the new runId;
    //        (4) emittedFrames contains exactly 1 'auto-run-started' frame
    if (!createCronDriver || !openSalesDatabase) {
      assert.ok(false, "T-E.Cron.1: createCronDriver or openSalesDatabase not importable");
      return;
    }

    const salesDbPath = join(tmpdir(), `cron-t1-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-t1-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    writeDueSchedule(schedulePath, "[AUTO_CONNECTS=5] [AUTO_DURATION=30] find VP Engineering leads");
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    const turn = makeNoopTurn();

    const driver = createCronDriver(state, deps, turn);
    await driver.tick();

    // (1) DB has 1 running row with correct caps
    const db = openSalesDatabase(salesDbPath);
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const rows = (db as any).prepare("SELECT * FROM auto_runs").all();
    assert.equal(rows.length, 1, "T-E.Cron.1: auto_runs must have exactly 1 row after tick");
    assert.equal(rows[0].status, "running", "T-E.Cron.1: row status must be 'running'");
    assert.equal(rows[0].max_duration_minutes, 30, "T-E.Cron.1: max_duration_minutes must be 30");
    assert.equal(rows[0].max_connects, 5, "T-E.Cron.1: max_connects must be 5");

    // (2) cronPrompt injected into state.messages
    const cronPrompt = (state.messages[state.messages.length - 1] as any)?.content as string;
    assert.ok(
      typeof cronPrompt === "string" && cronPrompt.length > 0,
      "T-E.Cron.1: cronPrompt must be a non-empty string in state.messages",
    );
    assert.ok(cronPrompt.includes("[AUTO_RUN_ID="), "T-E.Cron.1: cronPrompt must contain [AUTO_RUN_ID=");
    assert.ok(/\[ELAPSED=0\/30min\]/.test(cronPrompt), "T-E.Cron.1: cronPrompt must contain [ELAPSED=0/30min]");
    assert.ok(/\[CONNECTS_USED=0\/5\]/.test(cronPrompt), "T-E.Cron.1: cronPrompt must contain [CONNECTS_USED=0/5]");

    // (3) state.autoRunId set
    assert.ok(
      state.autoRunId !== null && typeof state.autoRunId === "string",
      "T-E.Cron.1: state.autoRunId must be set to a non-null string after tick",
    );

    // (4) exactly 1 auto-run-started frame
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const startedFrames = emittedFrames.filter((f: any) => f.type === "auto-run-started");
    assert.equal(startedFrames.length, 1, "T-E.Cron.1: must have exactly 1 'auto-run-started' frame");
  });

  // ─── T-E.Cron.2 ──────────────────────────────────────────────────────────────
  it("T-E.Cron.2: tick with EXISTING running row (started 10min ago, maxDuration=30) → cronPrompt includes EXISTING runId + ELAPSED≈10/30min; NO new row inserted", async () => {
    // Given: auto_runs has 1 running row (started 10 min ago, maxDuration=30, maxConnects=5)
    // When:  cron.tick() fires again (resume tick)
    // Then:  no new auto_runs row inserted (still 1 row);
    //        cronPrompt contains the EXISTING runId (not a new uuid);
    //        ELAPSED ≈ 10/30min (within ±2 of 10); CONNECTS_USED=0/5
    if (!createCronDriver || !openSalesDatabase) {
      assert.ok(false, "T-E.Cron.2: createCronDriver or openSalesDatabase not importable");
      return;
    }

    const salesDbPath = join(tmpdir(), `cron-t2-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-t2-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // Seed a running row started 10 minutes ago
    const db = openSalesDatabase(salesDbPath);
    const originalRunId = seedRunningRow(db, Date.now() - 10 * 60000, 30, 5);

    writeDueSchedule(schedulePath, "[AUTO_CONNECTS=5] [AUTO_DURATION=30] continue lead qualification");
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    const turn = makeNoopTurn();

    const driver = createCronDriver(state, deps, turn);
    await driver.tick();

    // Still only 1 row (no new row created)
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const rows = (db as any).prepare("SELECT * FROM auto_runs").all();
    assert.equal(rows.length, 1, "T-E.Cron.2: auto_runs must still have exactly 1 row (resume, no new row)");

    // state.autoRunId = original run ID
    assert.equal(
      state.autoRunId,
      originalRunId,
      "T-E.Cron.2: state.autoRunId must be the ORIGINAL run ID (not a new one)",
    );

    // cronPrompt contains original runId + ELAPSED ≈ 10
    const cronPrompt = (state.messages[state.messages.length - 1] as any)?.content as string;
    assert.ok(cronPrompt.includes(originalRunId), "T-E.Cron.2: cronPrompt must contain the original runId");
    const elapsedMatch = cronPrompt.match(/\[ELAPSED=(\d+)\/30min\]/);
    assert.ok(elapsedMatch !== null, "T-E.Cron.2: cronPrompt must contain [ELAPSED=N/30min]");
    const elapsed = Number.parseInt(elapsedMatch![1] ?? "0", 10);
    assert.ok(elapsed >= 9 && elapsed <= 11, `T-E.Cron.2: ELAPSED must be ≈10 (got ${elapsed}); row started 10min ago`);
    assert.ok(/\[CONNECTS_USED=0\/5\]/.test(cronPrompt), "T-E.Cron.2: cronPrompt must contain [CONNECTS_USED=0/5]");

    // No auto-run-started frame (we resumed existing run)
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const startedFrames = emittedFrames.filter((f: any) => f.type === "auto-run-started");
    assert.equal(startedFrames.length, 0, "T-E.Cron.2: must NOT emit auto-run-started on resume (existing row)");
  });

  // ─── T-E.Cron.3 ──────────────────────────────────────────────────────────────
  it("T-E.Cron.3 (G-PSPE.9 — duration safety net): tick with EXISTING running row (started 35min ago, maxDuration=30, EXCEEDED) → force-close via endAutoRun + auto-run-completed SSE BEFORE turn starts; a NEW auto_runs row is created (total = 2 rows)", async () => {
    // Given: auto_runs has 1 running row (started_at = now - 35 * 60000, maxDurationMinutes=30)
    // When:  cron.tick() fires
    // Then:  row status becomes 'stopped_by_agent', summary contains 'safety net' or 'Duration cap';
    //        emittedFrames has 'auto-run-completed' BEFORE 'turn-started';
    //        a NEW auto_runs row is created (total = 2 rows)
    if (!createCronDriver || !openSalesDatabase) {
      assert.ok(false, "T-E.Cron.3: createCronDriver or openSalesDatabase not importable");
      return;
    }

    const salesDbPath = join(tmpdir(), `cron-t3-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-t3-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // Seed a running row started 35 minutes ago (exceeds maxDuration=30)
    const db = openSalesDatabase(salesDbPath);
    const overdueRunId = seedRunningRow(db, Date.now() - 35 * 60000, 30, 5);

    writeDueSchedule(schedulePath, "[AUTO_CONNECTS=5] [AUTO_DURATION=30] lead qualification run");
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    const turn = makeNoopTurn();

    const driver = createCronDriver(state, deps, turn);
    await driver.tick();

    // Old row force-closed
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const overdueRow = (db as any).prepare("SELECT * FROM auto_runs WHERE id = ?").get(overdueRunId) as any;
    assert.equal(
      overdueRow.status,
      "stopped_by_agent",
      "T-E.Cron.3: over-duration row must be force-closed with status='stopped_by_agent'",
    );
    assert.ok(overdueRow.ended_at !== null, "T-E.Cron.3: over-duration row must have ended_at set");
    assert.ok(
      typeof overdueRow.summary === "string" &&
        (/safety net/i.test(overdueRow.summary) || /Duration cap/i.test(overdueRow.summary)),
      `T-E.Cron.3: summary must mention safety net or Duration cap; got: "${overdueRow.summary}"`,
    );

    // 2 rows total (old closed + new running)
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const allRows = (db as any).prepare("SELECT * FROM auto_runs").all() as any[];
    assert.equal(allRows.length, 2, "T-E.Cron.3: must have 2 auto_runs rows (old force-closed + new running)");
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const newRow = allRows.find((r: any) => r.id !== overdueRunId);
    assert.ok(newRow !== undefined, "T-E.Cron.3: a new auto_runs row must exist");
    assert.equal(newRow?.status, "running", "T-E.Cron.3: new row must be running");

    // auto-run-completed emitted BEFORE turn-started
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedIdx = emittedFrames.findIndex((f: any) => f.type === "auto-run-completed");
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const turnStartedIdx = emittedFrames.findIndex((f: any) => f.type === "turn-started");
    assert.ok(completedIdx !== -1, "T-E.Cron.3: emittedFrames must contain 'auto-run-completed'");
    assert.ok(turnStartedIdx !== -1, "T-E.Cron.3: emittedFrames must contain 'turn-started' (new run starts)");
    assert.ok(
      completedIdx < turnStartedIdx,
      `T-E.Cron.3: auto-run-completed (idx=${completedIdx}) must come BEFORE turn-started (idx=${turnStartedIdx})`,
    );
  });

  // ─── T-E.Cron.4 ──────────────────────────────────────────────────────────────
  // [P-AUTO-1+2 REVISED] Old assertion: maxConnects=null when no [AUTO_CONNECTS] directive.
  // New assertion: maxConnects=5 (DEFAULT_AUTO_RUN_MAX_CONNECTS) when no directive — cron
  // must also use the constant, not null. [CONNECTS_USED=0/5] in cronPrompt accordingly.
  it("T-E.Cron.4 (G-PSPE.10): NO [AUTO_*] directives in task text → cron creates row with defaults (maxDurationMinutes=480, maxConnects=5) per P-AUTO-1+2", async () => {
    // Given: cron task text with NO [AUTO_DURATION=N] or [AUTO_CONNECTS=N] tokens
    // When:  cron.tick() fires
    // Then:  auto_runs has 1 new row with maxDurationMinutes=480 AND maxConnects=5 (DEFAULT);
    //        cronPrompt contains [AUTO_RUN_ID=...] and [CONNECTS_USED=0/5]
    if (!createCronDriver || !openSalesDatabase) {
      assert.ok(false, "T-E.Cron.4: createCronDriver or openSalesDatabase not importable");
      return;
    }

    const salesDbPath = join(tmpdir(), `cron-t4-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-t4-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // Plain task text — no AUTO directives
    writeDueSchedule(schedulePath, "check pipeline status and send digest");
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    const turn = makeNoopTurn();

    const driver = createCronDriver(state, deps, turn);
    await driver.tick();

    // DB has 1 row with defaults
    const db = openSalesDatabase(salesDbPath);
    // biome-ignore lint/suspicious/noExplicitAny: test assertion
    const rows = (db as any).prepare("SELECT * FROM auto_runs").all() as any[];
    assert.equal(rows.length, 1, "T-E.Cron.4: must have exactly 1 auto_runs row");
    assert.equal(
      rows[0].max_duration_minutes,
      480,
      "T-E.Cron.4: default maxDurationMinutes must be 480 (no [AUTO_DURATION] directive)",
    );
    // [P-AUTO-1+2 REVISED] was: maxConnects=null; now: maxConnects=5 (DEFAULT_AUTO_RUN_MAX_CONNECTS)
    assert.equal(
      rows[0].max_connects,
      5,
      "T-E.Cron.4: default maxConnects must be 5 (DEFAULT_AUTO_RUN_MAX_CONNECTS) when no [AUTO_CONNECTS] directive",
    );

    // cronPrompt has AUTO_RUN_ID + CONNECTS_USED=0/5 (not 0/none — default is now 5)
    const cronPrompt = (state.messages[state.messages.length - 1] as any)?.content as string;
    assert.ok(
      cronPrompt.includes("[AUTO_RUN_ID="),
      "T-E.Cron.4: cronPrompt must contain [AUTO_RUN_ID= even without AUTO directives",
    );
    // [P-AUTO-1+2 REVISED] was: /\[CONNECTS_USED=0\/none\]/; now: /\[CONNECTS_USED=0\/5\]/
    assert.ok(
      /\[CONNECTS_USED=0\/5\]/.test(cronPrompt),
      "T-E.Cron.4: cronPrompt must contain [CONNECTS_USED=0/5] when maxConnects=5 (DEFAULT)",
    );
  });

  // ─── T-E.Cron.5 ──────────────────────────────────────────────────────────────
  it("T-E.Cron.5 (G-PSPE.11): after runOneTurn completes, cron emits auto-run-progress SSE with current counters (OQ-E6 option c)", async () => {
    // Given: 1 running auto_runs row + 0 ledger entries; turn.runOneTurn resolves successfully
    // When:  cron.tick() fires and runOneTurn completes
    // Then:  emittedFrames contains 1 'auto-run-progress' frame with {runId, elapsedMinutes, counters:{}};
    //        the progress frame is emitted AFTER 'cron-tick' and BEFORE 'cron-done'
    if (!createCronDriver || !openSalesDatabase) {
      assert.ok(false, "T-E.Cron.5: createCronDriver or openSalesDatabase not importable");
      return;
    }

    const salesDbPath = join(tmpdir(), `cron-t5-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-t5-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    writeDueSchedule(schedulePath, "[AUTO_DURATION=60] check pipeline");
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    const turn = makeNoopTurn();

    const driver = createCronDriver(state, deps, turn);
    await driver.tick();

    // Should have exactly 1 auto-run-progress frame
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const progressFrames = emittedFrames.filter((f: any) => f.type === "auto-run-progress");
    assert.equal(progressFrames.length, 1, "T-E.Cron.5: must have exactly 1 'auto-run-progress' frame after turn");

    const pf = progressFrames[0] as any;
    assert.ok(typeof pf.runId === "string" && pf.runId.length > 0, "T-E.Cron.5: progress frame must have runId");
    assert.ok(typeof pf.elapsedMinutes === "number", "T-E.Cron.5: progress frame must have elapsedMinutes");
    assert.ok(
      pf.counters !== null && typeof pf.counters === "object",
      "T-E.Cron.5: progress frame must have counters object",
    );
    assert.ok(typeof pf.ts === "number", "T-E.Cron.5: progress frame must have ts");

    // Frame ordering: cron-tick BEFORE progress BEFORE cron-done
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const cronTickIdx = emittedFrames.findIndex((f: any) => f.type === "cron-tick");
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const progressIdx = emittedFrames.findIndex((f: any) => f.type === "auto-run-progress");
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const cronDoneIdx = emittedFrames.findIndex((f: any) => f.type === "cron-done");
    assert.ok(
      cronTickIdx < progressIdx,
      `T-E.Cron.5: cron-tick (${cronTickIdx}) must come BEFORE auto-run-progress (${progressIdx})`,
    );
    assert.ok(
      progressIdx < cronDoneIdx,
      `T-E.Cron.5: auto-run-progress (${progressIdx}) must come BEFORE cron-done (${cronDoneIdx})`,
    );
  });

  // ─── T-E.Cron.6 ──────────────────────────────────────────────────────────────
  it("T-E.Cron.6 (G-PSPE.11 / CONCERN-MR-2): agent called end_auto_run mid-turn → post-turn handler detects getCurrentAutoRun===null + state.autoRunId set → emits auto-run-completed with full payload BEFORE clearing state.autoRunId", async () => {
    // Given: 1 running auto_runs row; turn.runOneTurn calls endAutoRun(db, id, ...) mid-turn
    //        (simulated: after runOneTurn, the DB row has status='completed' + ended_at set)
    // When:  cron.tick() post-turn handler runs
    // Then:  emittedFrames contains 'auto-run-completed' with {runId, status, summary, finalCounters, endedAt};
    //        state.autoRunId === null after tick
    if (!createCronDriver || !openSalesDatabase || !endAutoRun) {
      assert.ok(false, "T-E.Cron.6: required imports not available");
      return;
    }

    const salesDbPath = join(tmpdir(), `cron-t6-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-t6-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // Seed a running row started 5 minutes ago (well within caps)
    const db = openSalesDatabase(salesDbPath);
    const existingRunId = seedRunningRow(db, Date.now() - 5 * 60000, 30, 5);

    writeDueSchedule(schedulePath, "[AUTO_CONNECTS=5] [AUTO_DURATION=30] run qualification loop");
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);

    // Turn that closes the run (simulates agent calling end_auto_run)
    const turn = {
      runOneTurn: async () => {
        // The agent "calls end_auto_run" mid-turn — simulate by ending the DB row directly
        const db2 = openSalesDatabase(salesDbPath);
        endAutoRun(db2, existingRunId, {
          status: "completed",
          summary: "Agent completed: 2 connects sent, 5 candidates observed",
        });
        // state.autoRunId is already set by cron.ts to existingRunId BEFORE this runs
      },
    };

    const driver = createCronDriver(state, deps, turn);
    await driver.tick();

    // state.autoRunId must be null after tick (cleared by post-turn handler)
    assert.equal(state.autoRunId, null, "T-E.Cron.6: state.autoRunId must be null after agent-ended run detection");

    // emittedFrames must have 'auto-run-completed' with correct payload
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = emittedFrames.filter((f: any) => f.type === "auto-run-completed");
    assert.equal(completedFrames.length, 1, "T-E.Cron.6: must have exactly 1 'auto-run-completed' frame");

    const cf = completedFrames[0] as any;
    assert.equal(cf.runId, existingRunId, "T-E.Cron.6: auto-run-completed frame must have the agent-ended runId");
    assert.equal(cf.status, "completed", "T-E.Cron.6: auto-run-completed frame status must be 'completed'");
    assert.ok(
      typeof cf.summary === "string" && cf.summary.length > 0,
      "T-E.Cron.6: auto-run-completed frame must have a summary",
    );
    assert.ok(
      cf.finalCounters !== null && typeof cf.finalCounters === "object",
      "T-E.Cron.6: auto-run-completed frame must have finalCounters",
    );
    assert.ok(typeof cf.endedAt === "number", "T-E.Cron.6: auto-run-completed frame must have endedAt timestamp");

    // Must NOT have an auto-run-progress frame (run ended during turn; no postRun)
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const progressFrames = emittedFrames.filter((f: any) => f.type === "auto-run-progress");
    assert.equal(progressFrames.length, 0, "T-E.Cron.6: must NOT have auto-run-progress when run ended mid-turn");
  });

  // ─── T-E.Cron.7 ──────────────────────────────────────────────────────────────
  it("T-E.Cron.7 (G-PSPE.11 / CONCERN-MR-5 — progress de-dup): 2 consecutive ticks with NO ledger changes between them → only 1 auto-run-progress frame emitted across both ticks", async () => {
    // Given: 1 running auto_runs row; 0 ledger entries; state.lastEmittedAutoCounters is null
    // When:  tick() #1 fires (emits 1 progress frame); tick() #2 fires with SAME counters
    // Then:  total auto-run-progress frames in emittedFrames === 1 (not 2);
    //        state.lastEmittedAutoCounters matches the counters snapshot after tick #1
    //
    // DEFECT D-SP-E-Cron.7: De-duplication (CONCERN-MR-5) was NOT implemented in cron.ts.
    // cron.ts always emits 1 progress frame per tick (lines 133-143) regardless of whether
    // counters changed. Two consecutive ticks = 2 progress frames. Test FAILS.
    if (!createCronDriver || !openSalesDatabase) {
      assert.ok(false, "T-E.Cron.7: createCronDriver or openSalesDatabase not importable");
      return;
    }

    const salesDbPath = join(tmpdir(), `cron-t7-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-t7-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    writeDueSchedule(schedulePath, "[AUTO_DURATION=60] qualify leads");
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    const turn = makeNoopTurn();

    const driver = createCronDriver(state, deps, turn);

    // Tick #1
    await driver.tick();
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const progressAfterTick1 = emittedFrames.filter((f: any) => f.type === "auto-run-progress").length;
    assert.equal(progressAfterTick1, 1, "T-E.Cron.7: tick #1 must emit exactly 1 progress frame");

    // Reset schedule for tick #2 (markRan updated nextRunAt to future)
    writeDueSchedule(schedulePath, "[AUTO_DURATION=60] qualify leads");

    // Tick #2 with SAME counters (no ledger changes between ticks)
    await driver.tick();
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const totalProgressFrames = emittedFrames.filter((f: any) => f.type === "auto-run-progress").length;

    // EXPECTED BY SPEC: 1 total (de-dup: no new progress when counters unchanged)
    // ACTUAL (no de-dup implemented): 2 total → TEST FAILS [DEFECT D-SP-E-Cron.7]
    assert.equal(
      totalProgressFrames,
      1,
      `T-E.Cron.7: total auto-run-progress frames must be 1 (de-dup); got ${totalProgressFrames} [DEFECT D-SP-E-Cron.7: CONCERN-MR-5 de-duplication not implemented in cron.ts]`,
    );
  });

  // ─── T-E.Cron.8 ──────────────────────────────────────────────────────────────
  it("T-E.Cron.8 (G-PSPE.11 / CONCERN-MR-5 — progress on counter change): 2 ticks where 2nd tick has new ledger writes → exactly 1 auto-run-progress frame per tick (not 1-per-ledger-write, per OQ-E6)", async () => {
    // Given: 1 running auto_runs row; after tick #1, 3 ledger rows added (connect_sent=3)
    // When:  tick() #2 fires
    // Then:  exactly 1 new 'auto-run-progress' frame in tick #2 (total 2 across both ticks);
    //        the tick #2 frame has counters.connect_sent=3 (final count, not 3 separate frames)
    if (!createCronDriver || !openSalesDatabase || !appendAutoLedger) {
      assert.ok(false, "T-E.Cron.8: required imports not available");
      return;
    }

    const salesDbPath = join(tmpdir(), `cron-t8-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-t8-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    writeDueSchedule(schedulePath, "[AUTO_DURATION=60] run outreach loop");
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    const turn = makeNoopTurn();

    const driver = createCronDriver(state, deps, turn);

    // Tick #1 (0 ledger entries)
    await driver.tick();
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const progressAfterTick1 = emittedFrames.filter((f: any) => f.type === "auto-run-progress").length;
    assert.equal(progressAfterTick1, 1, "T-E.Cron.8: tick #1 must emit 1 progress frame");

    // Add 3 ledger rows (simulate agent sending 3 connects)
    const runId = state.autoRunId as string;
    assert.ok(runId, "T-E.Cron.8: state.autoRunId must be set after tick #1");
    const db = openSalesDatabase(salesDbPath);
    for (let i = 0; i < 3; i++) {
      appendAutoLedger(db, { runId, actionType: "connect_sent", result: "success" });
    }

    // Reset schedule for tick #2
    writeDueSchedule(schedulePath, "[AUTO_DURATION=60] run outreach loop");

    // Tick #2 (3 new ledger entries)
    await driver.tick();
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const allProgressFrames = emittedFrames.filter((f: any) => f.type === "auto-run-progress");
    assert.equal(
      allProgressFrames.length,
      2,
      `T-E.Cron.8: total progress frames must be 2 across both ticks; got ${allProgressFrames.length}`,
    );

    // tick #2 frame shows connect_sent=3 (aggregated, not 3 separate frames)
    const tick2Frame = allProgressFrames[1] as any;
    assert.equal(
      tick2Frame?.counters?.connect_sent,
      3,
      `T-E.Cron.8: tick #2 progress frame must have counters.connect_sent=3; got: ${JSON.stringify(tick2Frame?.counters)}`,
    );
  });
});
