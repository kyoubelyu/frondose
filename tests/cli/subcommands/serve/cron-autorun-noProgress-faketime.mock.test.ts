/**
 * P-AUTO-12 Step 3 scaffold — L1-equivalent fake-time integration tests
 *
 * Gate coverage: L1-equivalent (truly-stuck closure at threshold + discovery-only survival)
 *
 * These tests use a real in-memory salesDb + the real cron driver + mocked turn.runOneTurn.
 * They drive N consecutive tick() calls (without fake timers — timing is controlled by
 * constructing schedule entries due on each tick) and verify the final DB state.
 *
 * Two scenarios:
 *   L1-Stuck   : threshold=10 tick()s with zero progress → run ends as stopped_by_agent
 *   L1-Discovery: threshold=10; 12 tick()s where each tick upserts a raw_candidate
 *                 → run stays 'running' after 12 ticks (F-1 acceptance scenario)
 *
 * Step-3 compile note: the no-progress logic does not exist at Step 3. Both L1-Stuck
 * and L1-Discovery assertion FAIL. These tests only PASS after the builder ships
 * the no-progress block (Step 4) and the validator fills them at Step 5.
 * The plan marks this file as "Step 5 only — not required for Step 3 scaffold compile-pass"
 * (§6.2). We scaffold it now so the builder knows the seam and the test names are
 * locked in the test contract.
 *
 * Run (mock, single file):
 *   node --import tsx --test --test-force-exit \
 *     tests/cli/subcommands/serve/cron-autorun-noProgress-faketime.mock.test.ts
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

before(async () => {
  const cronMod = await import("../../../../src/cli/subcommands/serve/cron.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  createCronDriver = (cronMod as any)?.createCronDriver ?? null;
  const dbMod = await import("../../../../src/persistence/salesDb.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  openSalesDatabase = (dbMod as any)?.openSalesDatabase ?? null;
});

function writeDueSchedule(schedulePath: string, taskText = "[AUTO_CONNECTS=5] [AUTO_DURATION=480] test run"): void {
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

// ─── L1-Stuck: truly-stuck run closes at exactly 10 ticks ────────────────────

describe("L1-Stuck: truly-stuck run closes at threshold=10 (real cron driver, real in-memory salesDb)", () => {
  let savedLimit: string | undefined;

  before(() => {
    savedLimit = process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    delete process.env.MAI_CRON_NOPROGRESS_LIMIT;
  });

  after(() => {
    if (savedLimit === undefined) delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    else process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT = savedLimit;
  });

  it("after 11 consecutive zero-progress non-cooldown ticks, auto_runs row has status='stopped_by_agent' and exactly 1 auto-run-completed frame emitted", async () => {
    // Given: real createCronDriver + real in-memory salesDb; threshold=10 (default);
    //        turn.runOneTurn is a noop (writes nothing to any of the four tables)
    // When:  11 consecutive tick() calls run (tick 1 baselines counter at 0; ticks 2..11 each
    //        increment; on tick 11 the counter reaches 10 → closure)
    // Then:  after tick 11: auto_runs row has status='stopped_by_agent';
    //        exactly 1 'auto-run-completed' frame in emittedFrames with status='stopped_by_agent';
    //        summary matches /No durable funnel progress in 10 consecutive cron ticks/
    assert.ok(createCronDriver !== null && openSalesDatabase !== null, "imports required (not yet at Step 3)");

    const salesDbPath = join(tmpdir(), `l1-stuck-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-l1-stuck-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();
    const noop = { runOneTurn: async () => {} };

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    let runId: string | null = null;

    // 11 ticks: tick 1 starts the run + baselines counter (0→0);
    // ticks 2..11 each increment; on tick 11 counter hits 10 → closure
    for (let i = 0; i < 11; i++) {
      writeDueSchedule(schedulePath);
      const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
      const driver = createCronDriver!(state, deps, noop);
      await driver.tick();

      // Capture the runId after the first tick (when the run is created)
      if (i === 0 && state.autoRunId) {
        runId = state.autoRunId as string;
      }
    }

    assert.ok(runId !== null, "runId must be set after tick 1");

    // auto_runs row must be stopped_by_agent
    const row = db.prepare("SELECT status FROM auto_runs WHERE id = ?").get(runId) as any;
    assert.equal(row?.status, "stopped_by_agent",
      `auto_runs row must be 'stopped_by_agent' after 10 zero-progress ticks; got: ${row?.status}`);

    // Exactly 1 auto-run-completed frame
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(completedFrames.length, 1,
      `Must emit exactly 1 auto-run-completed; got ${completedFrames.length}`);

    const cf = completedFrames[0] as any;
    assert.equal(cf.status, "stopped_by_agent");
    assert.ok(
      /No durable funnel progress in 10 consecutive cron ticks/i.test(cf.summary ?? ""),
      `summary must match no-progress pattern; got: "${cf.summary}"`,
    );
  });
});

// ─── L1-Discovery: discovery-only run survives 12 ticks ──────────────────────

describe("L1-Discovery: discovery-only run (raw_candidate upsert per tick) survives 12 ticks (F-1 acceptance, real driver)", () => {
  let savedLimit: string | undefined;

  before(() => {
    savedLimit = process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    delete process.env.MAI_CRON_NOPROGRESS_LIMIT;
  });

  after(() => {
    if (savedLimit === undefined) delete process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT;
    else process.env.FRONDOSE_CRON_NOPROGRESS_LIMIT = savedLimit;
  });

  it("when runOneTurn upserts at least one raw_candidate per call, auto_runs row has status='running' after 12 ticks (not closed)", async () => {
    // Given: real createCronDriver + real in-memory salesDb; threshold=10 (default);
    //        turn.runOneTurn upserts a unique raw_candidate per call (Signal D advances each tick)
    // When:  12 consecutive tick() calls run
    // Then:  after all 12 ticks: auto_runs row still status='running'; no auto-run-completed frame
    assert.ok(createCronDriver !== null && openSalesDatabase !== null, "imports required (not yet at Step 3)");

    const salesDbPath = join(tmpdir(), `l1-disc-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-l1-disc-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    // biome-ignore lint/suspicious/noExplicitAny: test DB
    const db: any = openSalesDatabase!(salesDbPath);
    let runId: string | null = null;

    // Discovery turn: upserts a fresh raw_candidate each call
    const discoveryTurn = {
      runOneTurn: async () => {
        const id = randomUUID();
        const now = Date.now();
        (openSalesDatabase!(salesDbPath) as any).prepare(`
          INSERT INTO raw_candidates (id, person_name, profile_url, account_id, source, observed_at, last_seen_at, status)
          VALUES (?, 'Discovery Person', 'https://linkedin.com/in/dp-${id.slice(0, 6)}', NULL, 'profile-nav', ?, ?, 'new')
          ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
        `).run(id, now - 1000, now);
      },
    };

    for (let i = 0; i < 12; i++) {
      writeDueSchedule(schedulePath, "[AUTO_CONNECTS=0] [AUTO_DURATION=480] discovery-only run");
      const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);
      const driver = createCronDriver!(state, deps, discoveryTurn);
      await driver.tick();

      if (i === 0 && state.autoRunId) {
        runId = state.autoRunId as string;
      }
    }

    assert.ok(runId !== null, "runId must be set after tick 1");

    // auto_runs row must still be running
    const row = db.prepare("SELECT status FROM auto_runs WHERE id = ?").get(runId) as any;
    assert.equal(row?.status, "running",
      `Discovery-only run must still be 'running' after 12 ticks; got: ${row?.status} (F-1 acceptance — Step-1 design with ledger-only signal would have wrongly closed this at tick 3)`);

    // No auto-run-completed frame
    // biome-ignore lint/suspicious/noExplicitAny: frame type check
    const completedFrames = (emittedFrames as any[]).filter((f: any) => f.type === "auto-run-completed");
    assert.equal(completedFrames.length, 0,
      `Discovery-only run must NOT emit auto-run-completed after 12 ticks; got ${completedFrames.length} frames`);
  });
});
