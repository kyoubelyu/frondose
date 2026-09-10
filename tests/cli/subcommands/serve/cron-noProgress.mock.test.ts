/**
 * P-AUTO-12 Step 3 scaffold — T-CronNoProgress.* (main matrix)
 *
 * Gate coverage:
 *   G-A12.6  — T-CronNoProgress.1  : zero-progress non-cooldown tick increments counter
 *   G-A12.7  — T-CronNoProgress.2  : discovery-only (Signal D: last_seen_at) does NOT increment
 *   G-A12.8  — T-CronNoProgress.3  : scoring tick (Signal B: lead_timeline 'scored') does NOT increment
 *   G-A12.9  — T-CronNoProgress.4  : promotion tick (Signal B: 'promoted_to_lead') does NOT increment
 *   G-A12.10 — T-CronNoProgress.5  : drafting tick (Signal C: message_drafts.created_at) does NOT increment
 *   G-A12.11 — T-CronNoProgress.6  : outbound tick (Signal A: ledger) does NOT increment
 *   G-A12.12 — T-CronNoProgress.7  : cooldown tick HOLDS counter (no increment, no reset)
 *   G-A12.13 — T-CronNoProgress.8  : truly-stuck run closes at threshold 10 with exactly 1 frame
 *   G-A12.14 — T-CronNoProgress.9  : discovery-only run survives 12 ticks (F-1 acceptance)
 *   G-A12.15 — T-CronNoProgress.10 : cooldown-heavy run survives 20 ticks (counter HELD)
 *   G-A12.16 — T-CronNoProgress.11 : fresh run resets counter (no cross-run bleed)
 *   G-A12.18 — T-CronNoProgress.13 : after no-progress closure, next tick does NOT re-emit
 *   G-A12.19 — T-CronNoProgress.14 : agent-called end_auto_run path is unaffected
 *   G-A12.21 — T-CronNoProgress.16 : FRONDOSE_CRON_NOPROGRESS_LIMIT=5 overrides default 10
 *
 * Design: use the `createCronDriver` seam with a real in-memory salesDb.
 * `turn.runOneTurn` is mocked to write specific rows to the salesDb (simulating
 * what the real agent would do), then the post-handler's logic runs on the actual
 * DB state. This is the same seam used by cronAutoRunLifecycle.mock.test.ts.
 *
 * Step-3 compile note: the no-progress logic does not exist until Step 4. Until
 * then `state.cronNoProgressTurns` stays 0 after every tick (the post-handler
 * doesn't touch the new fields). All assertions on counter increments FAIL — intentional.
 *
 * Run (mock, single file):
 *   node --import tsx --test --test-force-exit \
 *     tests/cli/subcommands/serve/cron-noProgress.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: pre-builder stubs
type AnyFn = (...args: any[]) => any;
// biome-ignore lint/suspicious/noExplicitAny: mock shapes
type MockRecord = Record<string, any>;

let createCronDriver: AnyFn | null = null;
let openSalesDatabase: AnyFn | null = null;
let endAutoRun: AnyFn | null = null;
let appendAutoLedger: AnyFn | null = null;
let insertDraft: AnyFn | null = null;

before(async () => {
  const cronMod = await import("../../../../src/app/backend/cron.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  createCronDriver = (cronMod as any)?.createCronDriver ?? null;

  const dbMod = await import("../../../../src/persistence/salesDb.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  const db = dbMod as any;
  openSalesDatabase = db?.openSalesDatabase ?? null;
  endAutoRun = db?.endAutoRun ?? null;
  appendAutoLedger = db?.appendAutoLedger ?? null;
  insertDraft = db?.insertDraft ?? null;
});

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Write a JSONL schedule file with one due recurring entry. */
function writeDueSchedule(schedulePath: string, taskText = "[AUTO_CONNECTS=5] [AUTO_DURATION=30] qualify leads"): void {
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

/** Build minimal mock ServeState with new P-AUTO-12 fields. */
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
    // P-AUTO-12 (b): new no-progress tracking fields
    cronNoProgressRunId: null,
    cronNoProgressTurns: 0,
    ...extra,
  };
}

/** Build minimal mock ServeDeps. */
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
    emitFrame: (frame: unknown) => {
      emittedFrames.push(frame);
    },
    emitOverlayEvent: () => {},
  };
}

/** Seed a running auto_run row and pre-set state.cronNoProgressRunId + cronNoProgressTurns. */
function seedAutoRunAndState(db: AnyFn, state: MockRecord, turns = 0): string {
  const id = randomUUID();
  const now = Date.now();
  (db as any)
    .prepare(`
    INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters)
    VALUES (?, ?, NULL, 480, 20, 'running', NULL, NULL)
  `)
    .run(id, now);
  state.autoRunId = id;
  state.cronNoProgressRunId = id;
  state.cronNoProgressTurns = turns;
  return id;
}

/** Seed a raw_candidate row, bumping last_seen_at. Returns the id. */
// Monotonic fake clock for last_seen_at/observed_at: the Signal-D high-water mark is
// MAX(last_seen_at), so ticks must strictly advance it — on a fast CI runner a dozen
// ticks can land inside one real millisecond and the signal would stop advancing.
let fakeClockMs = Date.now() - 3_600_000;

function upsertRawCandidate(db: AnyFn, existingId?: string): string {
  const id = existingId ?? randomUUID();
  fakeClockMs += 1_000;
  const now = fakeClockMs;
  (db as any)
    .prepare(`
    INSERT INTO raw_candidates (id, person_name, profile_url, account_id, source, observed_at, last_seen_at, status)
    VALUES (?, 'Test Person', 'https://linkedin.com/in/tp-${id.slice(0, 6)}', NULL, 'profile-nav', ?, ?, 'new')
    ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `)
    .run(id, now - 5000, now);
  return id;
}

/** Insert a lead_timeline row (candidate_id is NOT NULL per schema; seed a raw_candidate first). */
function insertTimelineEvent(db: AnyFn, eventType: string): void {
  fakeClockMs += 1_000;
  const now = fakeClockMs;
  // Seed a raw_candidate to satisfy the NOT NULL FK on candidate_id
  const candidateId = randomUUID();
  (db as any)
    .prepare(`
    INSERT INTO raw_candidates (id, person_name, profile_url, account_id, source, observed_at, last_seen_at, status)
    VALUES (?, 'TL Person', 'https://linkedin.com/in/tlp-${candidateId.slice(0, 6)}', NULL, 'profile-nav', ?, ?, 'new')
  `)
    .run(candidateId, now - 5000, now - 5000);
  // Schema column is `metadata`, NOT `detail`
  (db as any)
    .prepare(`
    INSERT INTO lead_timeline (id, candidate_id, lead_id, event_type, ts, metadata)
    VALUES (?, ?, NULL, ?, ?, NULL)
  `)
    .run(randomUUID(), candidateId, eventType, now);
}

/** Insert a message_drafts row. */
function insertMessageDraft(db: AnyFn, leadId?: string): void {
  const now = Date.now();
  (db as any)
    .prepare(`
    INSERT INTO message_drafts (id, lead_id, kind, text, status, created_by, evidence, created_at)
    VALUES (?, ?, 'connect_note', 'Draft text', 'draft', 'llm', NULL, ?)
  `)
    .run(randomUUID(), leadId ?? null, now);
}

/** Seed a recent outbound entry in auto_run_ledger. The timestamp column is `ts` (not `created_at`). */
function seedRecentOutbound(db: AnyFn, runId: string, msecondsAgo = 1000): void {
  const ts = Date.now() - msecondsAgo;
  // auto_run_ledger uses `ts` (integer NOT NULL) — not `created_at`
  (db as any)
    .prepare(`
    INSERT INTO auto_run_ledger (id, run_id, action_type, result, ts, count_weight)
    VALUES (?, ?, 'connect_sent', 'success', ?, 1.0)
  `)
    .run(randomUUID(), runId, ts);
}

// ─── T-CronNoProgress.1 — G-A12.6 ───────────────────────────────────────────

describe("T-CronNoProgress.1: zero-progress non-cooldown tick increments state.cronNoProgressTurns by 1 (G-A12.6)", () => {
  it("when no progress signal fires AND no cooldown AND runId matches, counter increments from 0 to 1 — no closure", async () => {
    // Given: state.autoRunId='run-A', cronNoProgressRunId='run-A', cronNoProgressTurns=0
    //        runOneTurn writes NOTHING to ledger/timeline/drafts/candidates; no recent outbound
    // When:  tick() runs
    // Then:  state.cronNoProgressTurns===1; no endAutoRun; no auto-run-completed frame
    assert.ok(createCronDriver !== null && openSalesDatabase !== null, "imports required");

    const salesDbPath = join(tmpdir(), `np-t1-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-np-t1-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    seedAutoRunAndState(db, state, 0);

    writeDueSchedule(schedulePath);
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    // noop turn — writes nothing
    const turn = { runOneTurn: async () => {} };

    const driver = createCronDriver!(state, deps, turn);
    await driver.tick();

    assert.equal(
      state.cronNoProgressTurns,
      1,
      `cronNoProgressTurns must be 1 after one zero-progress tick; got: ${state.cronNoProgressTurns}`,
    );
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(completedFrames.length, 0, "No auto-run-completed frame must be emitted before threshold");
    assert.ok(state.autoRunId !== null, "autoRunId must still be set (run not closed)");
  });
});

// ─── T-CronNoProgress.2 — G-A12.7 (F-1 load-bearing) ────────────────────────

describe("T-CronNoProgress.2: discovery-only tick (Signal D: raw_candidates.last_seen_at) does NOT increment counter (G-A12.7)", () => {
  it("when tick upserts raw_candidate (last_seen_at advances), counter resets from 5 to 0 (F-1 case)", async () => {
    // Given: cronNoProgressTurns=5; runOneTurn upserts a raw_candidate (bumps last_seen_at); no ledger/timeline/drafts
    // When:  tick() runs
    // Then:  state.cronNoProgressTurns===0 (reset); no endAutoRun; no closure frame
    assert.ok(createCronDriver !== null && openSalesDatabase !== null, "imports required");

    const salesDbPath = join(tmpdir(), `np-t2-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-np-t2-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    seedAutoRunAndState(db, state, 5); // counter pre-set to 5

    writeDueSchedule(schedulePath);
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);

    // Turn that inserts a raw_candidate (Signal D)
    const turn = {
      runOneTurn: async () => {
        upsertRawCandidate(openSalesDatabase!(salesDbPath));
      },
    };

    const driver = createCronDriver!(state, deps, turn);
    await driver.tick();

    assert.equal(
      state.cronNoProgressTurns,
      0,
      `cronNoProgressTurns must reset to 0 on discovery (Signal D) tick; got: ${state.cronNoProgressTurns}`,
    );
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(completedFrames.length, 0, "No auto-run-completed on discovery tick");
  });
});

// ─── T-CronNoProgress.3 — G-A12.8 ───────────────────────────────────────────

describe("T-CronNoProgress.3: scoring tick (lead_timeline 'scored' — Signal B) does NOT increment counter (G-A12.8)", () => {
  it("when tick inserts a lead_timeline scored event, counter resets from 5 to 0", async () => {
    // Given: cronNoProgressTurns=5; runOneTurn inserts lead_timeline 'scored' row
    // When:  tick() runs
    // Then:  cronNoProgressTurns===0 (reset); no closure
    assert.ok(createCronDriver !== null && openSalesDatabase !== null, "imports required");

    const salesDbPath = join(tmpdir(), `np-t3-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-np-t3-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    seedAutoRunAndState(db, state, 5);

    writeDueSchedule(schedulePath);
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);

    const turn = {
      runOneTurn: async () => {
        insertTimelineEvent(openSalesDatabase!(salesDbPath), "scored");
      },
    };

    const driver = createCronDriver!(state, deps, turn);
    await driver.tick();

    assert.equal(
      state.cronNoProgressTurns,
      0,
      `cronNoProgressTurns must reset to 0 on 'scored' timeline tick; got: ${state.cronNoProgressTurns}`,
    );
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(completedFrames.length, 0, "No auto-run-completed on scoring tick");
  });
});

// ─── T-CronNoProgress.4 — G-A12.9 ───────────────────────────────────────────

describe("T-CronNoProgress.4: promotion tick (lead_timeline 'promoted_to_lead' — Signal B) does NOT increment counter (G-A12.9)", () => {
  it("when tick inserts a lead_timeline promoted_to_lead event, counter resets from 5 to 0", async () => {
    // Given: cronNoProgressTurns=5; runOneTurn inserts lead_timeline 'promoted_to_lead' row
    // When:  tick() runs
    // Then:  cronNoProgressTurns===0 (reset); no closure
    assert.ok(createCronDriver !== null && openSalesDatabase !== null, "imports required");

    const salesDbPath = join(tmpdir(), `np-t4-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-np-t4-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    seedAutoRunAndState(db, state, 5);

    writeDueSchedule(schedulePath);
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);

    const turn = {
      runOneTurn: async () => {
        insertTimelineEvent(openSalesDatabase!(salesDbPath), "promoted_to_lead");
      },
    };

    const driver = createCronDriver!(state, deps, turn);
    await driver.tick();

    assert.equal(
      state.cronNoProgressTurns,
      0,
      `cronNoProgressTurns must reset to 0 on 'promoted_to_lead' tick; got: ${state.cronNoProgressTurns}`,
    );
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(completedFrames.length, 0, "No auto-run-completed on promotion tick");
  });
});

// ─── T-CronNoProgress.5 — G-A12.10 ──────────────────────────────────────────

describe("T-CronNoProgress.5: drafting tick (message_drafts.created_at — Signal C) does NOT increment counter (G-A12.10)", () => {
  it("when tick inserts a message_drafts row, counter resets from 5 to 0", async () => {
    // Given: cronNoProgressTurns=5; runOneTurn inserts a message_drafts row
    // When:  tick() runs
    // Then:  cronNoProgressTurns===0 (reset); no closure
    assert.ok(createCronDriver !== null && openSalesDatabase !== null, "imports required");

    const salesDbPath = join(tmpdir(), `np-t5-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-np-t5-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    seedAutoRunAndState(db, state, 5);

    writeDueSchedule(schedulePath);
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);

    const turn = {
      runOneTurn: async () => {
        insertMessageDraft(openSalesDatabase!(salesDbPath));
      },
    };

    const driver = createCronDriver!(state, deps, turn);
    await driver.tick();

    assert.equal(
      state.cronNoProgressTurns,
      0,
      `cronNoProgressTurns must reset to 0 on drafting (Signal C) tick; got: ${state.cronNoProgressTurns}`,
    );
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(completedFrames.length, 0, "No auto-run-completed on drafting tick");
  });
});

// ─── T-CronNoProgress.6 — G-A12.11 ──────────────────────────────────────────

describe("T-CronNoProgress.6: outbound tick (auto_run_ledger — Signal A) does NOT increment counter (G-A12.11)", () => {
  it("when tick appends an auto_run_ledger connect_sent row, counter resets from 5 to 0", async () => {
    // Given: cronNoProgressTurns=5; runOneTurn appends appendAutoLedger(connect_sent) for the run
    // When:  tick() runs
    // Then:  cronNoProgressTurns===0 (reset); no closure
    assert.ok(createCronDriver !== null && openSalesDatabase !== null && appendAutoLedger !== null, "imports required");

    const salesDbPath = join(tmpdir(), `np-t6-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-np-t6-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    const runId = seedAutoRunAndState(db, state, 5);

    writeDueSchedule(schedulePath);
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);

    const turn = {
      runOneTurn: async () => {
        appendAutoLedger!(openSalesDatabase!(salesDbPath), { runId, actionType: "connect_sent", result: "success" });
      },
    };

    const driver = createCronDriver!(state, deps, turn);
    await driver.tick();

    assert.equal(
      state.cronNoProgressTurns,
      0,
      `cronNoProgressTurns must reset to 0 on outbound (Signal A) tick; got: ${state.cronNoProgressTurns}`,
    );
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(completedFrames.length, 0, "No auto-run-completed on outbound tick");
  });
});

// ─── T-CronNoProgress.7 — G-A12.12 ──────────────────────────────────────────

describe("T-CronNoProgress.7: cooldown tick HOLDS counter — neither increments nor resets (G-A12.12)", () => {
  it("when lastOutboundAt is 1s ago (within cooldownMs) and no progress signals fire, counter stays at 5 (HELD)", async () => {
    // Given: cronNoProgressTurns=5; lastOutboundAt seeded 1 second ago (cooldown active);
    //        runOneTurn writes nothing; no progress signals advance
    // When:  tick() runs
    // Then:  cronNoProgressTurns===5 (HELD — neither incremented nor reset); no closure
    assert.ok(createCronDriver !== null && openSalesDatabase !== null, "imports required");

    const salesDbPath = join(tmpdir(), `np-t7-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-np-t7-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    const runId = seedAutoRunAndState(db, state, 5);

    // Seed a very recent outbound (1 second ago) → cooldownActive=true
    seedRecentOutbound(db, runId, 1000);

    writeDueSchedule(schedulePath);
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    // noop turn — no progress signals
    const turn = { runOneTurn: async () => {} };

    const driver = createCronDriver!(state, deps, turn);
    await driver.tick();

    assert.equal(
      state.cronNoProgressTurns,
      5,
      `cronNoProgressTurns must remain 5 (HELD) during cooldown tick; got: ${state.cronNoProgressTurns}`,
    );
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(completedFrames.length, 0, "No auto-run-completed on cooldown HOLD tick");
  });
});

// ─── T-CronNoProgress.8 — G-A12.13 ──────────────────────────────────────────

describe("T-CronNoProgress.8: truly-stuck run closes at threshold 10 with exactly 1 auto-run-completed frame (G-A12.13)", () => {
  let savedLimit: string | undefined;

  before(() => {
    savedLimit = process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
  });

  after(() => {
    if (savedLimit === undefined) delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    else process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT = savedLimit;
  });

  it("when cronNoProgressTurns=9 and tick makes zero progress (all four signals), endAutoRun(stopped_by_agent) called once + exactly 1 frame + state cleared", async () => {
    // Given: default threshold (no env); cronNoProgressTurns=9; cronNoProgressRunId='run-A';
    //        no cooldown; runOneTurn writes NOTHING
    // When:  tick() runs (10th no-progress tick)
    // Then:  endAutoRun called once with status='stopped_by_agent'; exactly 1 auto-run-completed frame;
    //        summary matches /No durable funnel progress in 10 consecutive cron ticks/;
    //        state.autoRunId===null, cronNoProgressRunId===null, cronNoProgressTurns===0
    assert.ok(createCronDriver !== null && openSalesDatabase !== null, "imports required");

    const salesDbPath = join(tmpdir(), `np-t8-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-np-t8-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    const runId = seedAutoRunAndState(db, state, 9); // one tick away from threshold=10

    writeDueSchedule(schedulePath);
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    // noop — no progress signals advance
    const turn = { runOneTurn: async () => {} };

    const driver = createCronDriver!(state, deps, turn);
    await driver.tick();

    // Exactly 1 auto-run-completed frame
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(
      completedFrames.length,
      1,
      `Must emit exactly 1 auto-run-completed frame when threshold is reached; got ${completedFrames.length}`,
    );

    const cf = completedFrames[0] as any;
    assert.equal(cf.runId, runId, "auto-run-completed frame must have the correct runId");
    assert.equal(cf.status, "stopped_by_agent", "status must be stopped_by_agent");
    assert.ok(
      /No durable funnel progress in 10 consecutive cron ticks/i.test(cf.summary ?? ""),
      `summary must mention no-progress threshold; got: "${cf.summary}"`,
    );

    // State cleared
    assert.equal(state.autoRunId, null, "state.autoRunId must be null after closure");
    assert.equal(state.cronNoProgressRunId, null, "cronNoProgressRunId must be null after closure");
    assert.equal(state.cronNoProgressTurns, 0, "cronNoProgressTurns must be 0 after closure");

    // DB row must be ended
    const row = (db as any).prepare("SELECT status FROM auto_runs WHERE id = ?").get(runId) as any;
    assert.equal(row?.status, "stopped_by_agent", "auto_runs row must be stopped_by_agent after closure");
  });
});

// ─── T-CronNoProgress.9 — G-A12.14 (F-1 acceptance) ─────────────────────────

describe("T-CronNoProgress.9: [AUTO_CONNECTS=0] discovery-only run survives 12 ticks (F-1 acceptance case) (G-A12.14)", () => {
  let savedLimit: string | undefined;

  before(() => {
    savedLimit = process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
  });

  after(() => {
    if (savedLimit === undefined) delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    else process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT = savedLimit;
  });

  it("when every tick upserts at least one raw_candidate (Signal D), run is NOT closed after 12 ticks", async () => {
    // Given: default threshold=10; auto_run with maxConnects=0 (discovery-only);
    //        runOneTurn upserts one raw_candidate per call (Signal D advances each tick)
    // When:  12 consecutive tick() calls run
    // Then:  auto_runs row still status='running'; no auto-run-completed frame; cronNoProgressTurns===0
    assert.ok(createCronDriver !== null && openSalesDatabase !== null, "imports required");

    const salesDbPath = join(tmpdir(), `np-t9-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-np-t9-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    const runId = seedAutoRunAndState(db, state, 0);

    // Discovery-only turn (upserts a unique raw_candidate per tick)
    const turn = {
      runOneTurn: async () => {
        upsertRawCandidate(openSalesDatabase!(salesDbPath));
      },
    };

    for (let i = 0; i < 12; i++) {
      writeDueSchedule(schedulePath, "[AUTO_CONNECTS=0] [AUTO_DURATION=30] discovery-only find leads");
      const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
      const driver = createCronDriver!(state, deps, turn);
      await driver.tick();
    }

    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(
      completedFrames.length,
      0,
      `Discovery-only run must NOT be closed after 12 ticks (F-1 acceptance); got ${completedFrames.length} completed frames`,
    );

    const row = (db as any).prepare("SELECT status FROM auto_runs WHERE id = ?").get(runId) as any;
    assert.equal(row?.status, "running", "auto_runs row must still be 'running' after 12 discovery-only ticks");
    assert.equal(state.cronNoProgressTurns, 0, "cronNoProgressTurns must be 0 (reset on each discovery tick)");
  });
});

// ─── T-CronNoProgress.10 — G-A12.15 ─────────────────────────────────────────

describe("T-CronNoProgress.10: cooldown-heavy run survives 20 ticks (counter HELD, not incremented) (G-A12.15)", () => {
  let savedLimit: string | undefined;

  before(() => {
    savedLimit = process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
  });

  after(() => {
    if (savedLimit === undefined) delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    else process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT = savedLimit;
  });

  it("when every tick is in cooldown (lastOutboundAt refreshed each tick), run is NOT closed after 20 ticks", async () => {
    // Given: default threshold=10; every tick has lastOutboundAt within cooldownMs (fresh outbound each tick);
    //        no progress signals advance (noop turn)
    // When:  20 consecutive tick() calls run
    // Then:  auto_runs row still status='running'; no auto-run-completed frame; cronNoProgressTurns never exceeds initial
    assert.ok(createCronDriver !== null && openSalesDatabase !== null, "imports required");

    const salesDbPath = join(tmpdir(), `np-t10-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-np-t10-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    const runId = seedAutoRunAndState(db, state, 0);

    for (let i = 0; i < 20; i++) {
      // Refresh cooldown: seed a very recent outbound entry each tick
      seedRecentOutbound(db, runId, 500); // 500ms ago → within default cooldownMs (30min)

      writeDueSchedule(schedulePath, "[AUTO_CONNECTS=5] [AUTO_DURATION=30] cooldown heavy run");
      const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
      const turn = { runOneTurn: async () => {} }; // noop — no progress signals
      const driver = createCronDriver!(state, deps, turn);
      await driver.tick();
    }

    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(
      completedFrames.length,
      0,
      `Cooldown-heavy run must NOT be closed after 20 ticks; got ${completedFrames.length} completed frames`,
    );

    const row = (db as any).prepare("SELECT status FROM auto_runs WHERE id = ?").get(runId) as any;
    assert.equal(row?.status, "running", "auto_runs row must still be 'running' after 20 cooldown ticks");

    // Counter should be HELD at 0 (never incremented because every tick is cooldown)
    assert.equal(
      state.cronNoProgressTurns,
      0,
      `cronNoProgressTurns must be HELD at 0 by cooldown exclusion; got: ${state.cronNoProgressTurns}`,
    );
  });
});

// ─── T-CronNoProgress.11 — G-A12.16 ─────────────────────────────────────────

describe("T-CronNoProgress.11: run-id change resets counter (no cross-run bleed) (G-A12.16)", () => {
  it("when active auto_run id changes from run-A to run-B, cronNoProgressTurns resets to 0 and cronNoProgressRunId updates", async () => {
    // Given: state.cronNoProgressRunId='run-A', cronNoProgressTurns=7;
    //        getCurrentAutoRun returns a row with id='run-B' (run-A ended, run-B started)
    // When:  tick() runs
    // Then:  state.cronNoProgressRunId==='run-B'; cronNoProgressTurns===0; no endAutoRun for run-A
    assert.ok(createCronDriver !== null && openSalesDatabase !== null, "imports required");

    const salesDbPath = join(tmpdir(), `np-t11-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-np-t11-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);

    // Pre-state: track run-A with 7 stale turns; but the DB has run-B as the active run
    const runAId = randomUUID();
    const runBId = randomUUID();
    const now = Date.now();

    // run-A is ended
    db.prepare(
      `INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, ?, 480, 20, 'stopped_by_agent', 'done', NULL)`,
    ).run(runAId, now - 60000, now - 1000);

    // run-B is the new active run
    db.prepare(
      `INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, 480, 20, 'running', NULL, NULL)`,
    ).run(runBId, now);

    // State reflects stale run-A tracking
    state.autoRunId = runBId; // the cron driver will read this from the DB on tick
    state.cronNoProgressRunId = runAId; // stale — should be reset
    state.cronNoProgressTurns = 7; // stale — should reset to 0

    writeDueSchedule(schedulePath);
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    const turn = { runOneTurn: async () => {} };

    const driver = createCronDriver!(state, deps, turn);
    await driver.tick();

    assert.equal(
      state.cronNoProgressRunId,
      runBId,
      `cronNoProgressRunId must be updated to run-B; got: ${state.cronNoProgressRunId}`,
    );
    assert.equal(
      state.cronNoProgressTurns,
      0,
      `cronNoProgressTurns must reset to 0 on run-id change; got: ${state.cronNoProgressTurns}`,
    );
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(completedFrames.length, 0, "No auto-run-completed on run-id change tick");
  });
});

// ─── T-CronNoProgress.13 — G-A12.18 ─────────────────────────────────────────

describe("T-CronNoProgress.13: after no-progress closure, next tick does NOT re-emit auto-run-completed (G-A12.18)", () => {
  let savedLimit: string | undefined;

  before(() => {
    savedLimit = process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    // Force threshold=1 for a fast closure
    process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT = "1";
    delete process.env.MAI_CRON_NOPROGRESS_LIMIT;
  });

  after(() => {
    if (savedLimit === undefined) delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    else process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT = savedLimit;
  });

  it("tick N trips threshold (1 frame emitted, state cleared); tick N+1 does NOT emit another auto-run-completed", async () => {
    // Given: FRONDOSE_CRON_NOPROGRESS_LIMIT=1; tick N has cronNoProgressTurns=0 + zero progress;
    //        tick N trips to 1, closes run-A, emits 1 frame, clears state.
    //        tick N+1 starts a fresh run-B.
    // When:  two consecutive tick() calls run
    // Then:  total auto-run-completed frames === 1 (for run-A only); run-B is running
    assert.ok(createCronDriver !== null && openSalesDatabase !== null, "imports required");

    const salesDbPath = join(tmpdir(), `np-t13-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-np-t13-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    const runAId = seedAutoRunAndState(db, state, 0); // cronNoProgressTurns=0; threshold=1 → one no-progress tick closes it

    // Tick N (closes run-A)
    writeDueSchedule(schedulePath);
    const depsN = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    const turnN = { runOneTurn: async () => {} }; // noop — closes run-A
    const driverN = createCronDriver!(state, depsN, turnN);
    await driverN.tick();

    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const framesAfterTickN = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(
      framesAfterTickN.length,
      1,
      `Tick N must emit exactly 1 auto-run-completed (for run-A); got ${framesAfterTickN.length}`,
    );
    assert.equal(state.autoRunId, null, "state.autoRunId must be null after closure");
    void runAId; // used above in seedAutoRunAndState

    // Tick N+1 (starts a fresh run-B; no closure should happen)
    writeDueSchedule(schedulePath, "[AUTO_CONNECTS=5] [AUTO_DURATION=30] follow up run");
    const depsN1 = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    const turnN1 = { runOneTurn: async () => {} };
    const driverN1 = createCronDriver!(state, depsN1, turnN1);
    await driverN1.tick();

    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const framesAfterTickN1 = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(
      framesAfterTickN1.length,
      1,
      `Tick N+1 must NOT emit another auto-run-completed; total must remain 1; got ${framesAfterTickN1.length}`,
    );
  });
});

// ─── T-CronNoProgress.14 — G-A12.19 ─────────────────────────────────────────

describe("T-CronNoProgress.14: agent-called end_auto_run path unaffected (no-progress check does not run) (G-A12.19)", () => {
  it("when agent calls end_auto_run mid-turn (postRun===null), no-progress logic does NOT run + existing P-SP-E emit path preserved", async () => {
    // Given: cronNoProgressTurns=5; during the turn agent calls end_auto_run({status:'completed'})
    // When:  cron post-turn block runs
    // Then:  postRun===null → if(postRun) branch is FALSE → no-progress logic does NOT execute;
    //        existing else-if (state.autoRunId !== null) branch emits exactly 1 auto-run-completed(completed);
    //        state.cronNoProgressTurns remains 5 (untouched by the else-if branch — reset occurs on NEXT tick)
    assert.ok(createCronDriver !== null && openSalesDatabase !== null && endAutoRun !== null, "imports required");

    const salesDbPath = join(tmpdir(), `np-t14-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-np-t14-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    const runId = seedAutoRunAndState(db, state, 5);

    writeDueSchedule(schedulePath);
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);

    // Turn that closes the run (simulates agent calling end_auto_run)
    const turn = {
      runOneTurn: async () => {
        endAutoRun!(openSalesDatabase!(salesDbPath), runId, {
          status: "completed",
          summary: "All targets advanced",
        });
      },
    };

    const driver = createCronDriver!(state, deps, turn);
    await driver.tick();

    // Exactly 1 auto-run-completed frame with status='completed' (from the agent's call)
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(
      completedFrames.length,
      1,
      `Must emit exactly 1 auto-run-completed (P-SP-E path); got ${completedFrames.length}`,
    );
    const cf = completedFrames[0] as any;
    assert.equal(cf.status, "completed", `Frame status must be 'completed' (agent-ended); got: ${cf.status}`);
    assert.ok(
      /All targets advanced/i.test(cf.summary ?? ""),
      `Frame summary must match agent's summary; got: "${cf.summary}"`,
    );

    // state.autoRunId must be null (cleared by existing P-SP-E handler)
    assert.equal(state.autoRunId, null, "state.autoRunId must be null after agent-ended detection");
  });
});

// ─── T-CronNoProgress.16 — G-A12.21 ─────────────────────────────────────────

describe("T-CronNoProgress.16: FRONDOSE_CRON_NOPROGRESS_LIMIT=5 closes run after 5 consecutive zero-progress ticks (G-A12.21)", () => {
  let savedLimit: string | undefined;

  before(() => {
    savedLimit = process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT = "5";
    delete process.env.MAI_CRON_NOPROGRESS_LIMIT;
  });

  after(() => {
    if (savedLimit === undefined) delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    else process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT = savedLimit;
  });

  it("with FRONDOSE_CRON_NOPROGRESS_LIMIT=5 and cronNoProgressTurns=4, one more zero-progress tick closes the run with summary mentioning '5 consecutive cron ticks'", async () => {
    // Given: FRONDOSE_CRON_NOPROGRESS_LIMIT=5; cronNoProgressTurns=4 (one away from limit);
    //        no cooldown; runOneTurn writes nothing
    // When:  tick() runs
    // Then:  endAutoRun + auto-run-completed with summary /5 consecutive cron ticks/; state cleared
    assert.ok(createCronDriver !== null && openSalesDatabase !== null, "imports required");

    const salesDbPath = join(tmpdir(), `np-t16-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-np-t16-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    const runId = seedAutoRunAndState(db, state, 4); // cronNoProgressTurns=4; threshold=5

    writeDueSchedule(schedulePath);
    // Construct driver AFTER env var is set (resolves at construction time)
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
    const turn = { runOneTurn: async () => {} }; // noop
    const driver = createCronDriver!(state, deps, turn);
    await driver.tick();

    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(
      completedFrames.length,
      1,
      `Must emit exactly 1 auto-run-completed at custom threshold 5; got ${completedFrames.length}`,
    );
    const cf = completedFrames[0] as any;
    assert.equal(cf.status, "stopped_by_agent");
    assert.ok(
      /5 consecutive cron ticks/i.test(cf.summary ?? ""),
      `Summary must mention '5 consecutive cron ticks'; got: "${cf.summary}"`,
    );
    assert.equal(cf.runId, runId, "Frame runId must match");
    assert.equal(state.autoRunId, null);
    assert.equal(state.cronNoProgressRunId, null);
    assert.equal(state.cronNoProgressTurns, 0);
  });
});
