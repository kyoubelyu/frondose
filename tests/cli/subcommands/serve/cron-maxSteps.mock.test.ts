/**
 * P-AUTO-12 Step 3 scaffold — T-CronMaxSteps.* (G-A12.1, G-A12.2)
 *
 * Verifies that `createCronDriver`'s `tick()` passes `maxSteps === resolveCronMaxSteps()`
 * (not `deps.maxSteps = 200`) to `turn.runOneTurn`, and that the env override works.
 *
 * Gate coverage: G-A12.1, G-A12.2
 *
 * Design: Mock `turn.runOneTurn` to capture the args it receives. Use a real in-memory
 * salesDb + a temp schedule with a due entry + a minimal mock state/deps. Inspect the
 * captured `maxSteps` argument.
 *
 * Step-3 compile note: `resolveCronMaxSteps` does not exist until Step 4. The seam works
 * because `createCronDriver` already exists and the cron tick loop already calls
 * `turn.runOneTurn(...)`. At Step 4 the builder adds `maxSteps: cronMaxSteps` to that call;
 * the scaffold then PASSES. Until then, the captured args will have `maxSteps === undefined`
 * (the field is missing), so the assertions FAIL as intended.
 *
 * Run (mock, single file):
 *   node --import tsx --test --test-force-exit \
 *     tests/cli/subcommands/serve/cron-maxSteps.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: pre-builder stubs
type AnyFn = (...args: any[]) => any;
// biome-ignore lint/suspicious/noExplicitAny: mock state/deps shapes
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

/** Write a JSONL schedule file with one due recurring entry. */
function writeDueSchedule(schedulePath: string, taskText: string): void {
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

/** Build minimal mock ServeState with a running autoRunId. */
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
    // P-AUTO-12 (b): new fields — pre-builder defaults (Step 3)
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
    maxSteps: 200, // deps.maxSteps is 200 — the cron cap must override this to 40
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

// ─── T-CronMaxSteps.1 ────────────────────────────────────────────────────────

describe("T-CronMaxSteps.1: cron tick passes maxSteps === resolveCronMaxSteps() (not deps.maxSteps=200) (G-A12.1)", () => {
  let savedEnv: string | undefined;

  before(() => {
    savedEnv = process.env.FRONDOSE_CRON_MAX_STEPS;
    delete process.env.FRONDOSE_CRON_MAX_STEPS;
    delete process.env.MAI_CRON_MAX_STEPS;
  });

  after(() => {
    if (savedEnv === undefined) delete process.env.FRONDOSE_CRON_MAX_STEPS;
    else process.env.FRONDOSE_CRON_MAX_STEPS = savedEnv;
  });

  it("when FRONDOSE_CRON_MAX_STEPS unset and deps.maxSteps=200, runOneTurn receives maxSteps===40 (DEFAULT_CRON_MAX_STEPS)", async () => {
    // Given: createCronDriver with deps.maxSteps=200; FRONDOSE_CRON_MAX_STEPS unset; a due schedule entry + active auto_run
    // When:  tick() is called
    // Then:  captured runOneTurn args has maxSteps===40 (not 200; not undefined)
    assert.ok(createCronDriver !== null, "createCronDriver must be importable");
    assert.ok(openSalesDatabase !== null, "openSalesDatabase must be importable");

    const salesDbPath = join(tmpdir(), `cron-mxs-t1-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-mxs-t1-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    writeDueSchedule(schedulePath, "[AUTO_CONNECTS=5] [AUTO_DURATION=30] find leads");
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);

    // Capture runOneTurn args
    // biome-ignore lint/suspicious/noExplicitAny: captured args
    let capturedArgs: any = null;
    const turn = {
      runOneTurn: async (args: unknown) => {
        capturedArgs = args;
      },
    };

    const driver = createCronDriver!(state, deps, turn);
    await driver.tick();

    assert.ok(capturedArgs !== null, "runOneTurn must have been called during tick()");
    assert.equal(
      capturedArgs.maxSteps,
      40,
      `runOneTurn must receive maxSteps===40 (DEFAULT_CRON_MAX_STEPS), not deps.maxSteps=200; got: ${capturedArgs?.maxSteps}`,
    );
    assert.equal(capturedArgs.isCronTurn, true, "runOneTurn must have isCronTurn===true on cron tick");
  });
});

// ─── T-CronMaxSteps.2 ────────────────────────────────────────────────────────

describe("T-CronMaxSteps.2: FRONDOSE_CRON_MAX_STEPS=15 overrides the default 40 (G-A12.2)", () => {
  let savedFrondose: string | undefined;
  let savedMai: string | undefined;

  before(() => {
    savedFrondose = process.env.FRONDOSE_CRON_MAX_STEPS;
    savedMai = process.env.MAI_CRON_MAX_STEPS;
    process.env.FRONDOSE_CRON_MAX_STEPS = "15";
    delete process.env.MAI_CRON_MAX_STEPS;
  });

  after(() => {
    if (savedFrondose === undefined) delete process.env.FRONDOSE_CRON_MAX_STEPS;
    else process.env.FRONDOSE_CRON_MAX_STEPS = savedFrondose;
    if (savedMai === undefined) delete process.env.MAI_CRON_MAX_STEPS;
    else process.env.MAI_CRON_MAX_STEPS = savedMai;
  });

  it("when FRONDOSE_CRON_MAX_STEPS='15', a freshly constructed createCronDriver tick() passes maxSteps===15", async () => {
    // Given: FRONDOSE_CRON_MAX_STEPS='15'; fresh createCronDriver construction; due schedule entry
    // When:  tick() runs
    // Then:  captured runOneTurn args has maxSteps===15
    assert.ok(createCronDriver !== null, "createCronDriver must be importable");
    assert.ok(openSalesDatabase !== null, "openSalesDatabase must be importable");

    const salesDbPath = join(tmpdir(), `cron-mxs-t2-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `sched-mxs-t2-${randomUUID()}.jsonl`);
    const emittedFrames: unknown[] = [];
    const state = makeMockState();

    writeDueSchedule(schedulePath, "[AUTO_CONNECTS=5] [AUTO_DURATION=30] find leads (env-override test)");
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);

    // biome-ignore lint/suspicious/noExplicitAny: captured args
    let capturedArgs: any = null;
    const turn = {
      runOneTurn: async (args: unknown) => {
        capturedArgs = args;
      },
    };

    // IMPORTANT: construct a FRESH driver AFTER setting the env var (env is read at construction time)
    const driver = createCronDriver!(state, deps, turn);
    await driver.tick();

    assert.ok(capturedArgs !== null, "runOneTurn must have been called");
    assert.equal(
      capturedArgs.maxSteps,
      15,
      `runOneTurn must receive maxSteps===15 (FRONDOSE_CRON_MAX_STEPS override); got: ${capturedArgs?.maxSteps}`,
    );
  });
});
