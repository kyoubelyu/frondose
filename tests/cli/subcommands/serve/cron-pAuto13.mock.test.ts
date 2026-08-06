/**
 * P-AUTO-13 Step 3 — Test Scaffold — T-A13.Cron.1..3 (G-A13.9)
 *
 * Covers:
 *   G-A13.9 — cron driver prompt CONNECTS_USED injects the SUCCESS-ONLY connect count,
 *   NOT the all-rows count. After P-AUTO-13 round-2 amendment 1 (cron.ts:116 switched to
 *   countSuccessfulConnects), CONNECTS_USED must agree with the hard click-cap and the
 *   advisory connectsRemaining returned by get_auto_run_state.
 *
 * Design: seeds a temp-file salesDb with a running auto_run and a mix of connect_sent
 * rows (success/skipped/failed), then drives one cron tick and asserts the injected
 * [CONNECTS_USED=N/cap] prompt segment via the turn stub's captured `userPrompt` arg.
 *
 * UPDATED (P-AUTO-ISOLATE, Step 5): cron.ts no longer pushes the cronPrompt into
 * `state.messages` (that seam was DELETED — the isolation guarantee this later phase
 * introduced). The cronPrompt is now only observable via the args passed to
 * `turn.runOneTurn({ userPrompt, overrideMessages, ... })`. The turn stub below was
 * changed from a bare no-op to a capturing stub so this pre-existing characterization
 * test keeps working against the new seam. This is a MECHANICAL update (read the
 * cronPrompt from a different place) — the actual G-A13.9 behavior under test
 * (CONNECTS_USED success-only counting) is untouched by P-AUTO-ISOLATE.
 *
 * Follows the tests/serve/cronAutoRunLifecycle.mock.test.ts pattern:
 *   createCronDriver(state, deps, turn) → driver.tick() → read the captured turn call's userPrompt.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/cli/subcommands/serve/cron-pAuto13.mock.test.ts
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
let insertAutoRun: AnyFn | null = null;

before(async () => {
  const cronMod = await import("../../../../src/app/backend/cron.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  createCronDriver = (cronMod as any)?.createCronDriver ?? null;

  const dbMod = await import("../../../../src/persistence/salesDb.js").catch(() => null);
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  openSalesDatabase = (dbMod as any)?.openSalesDatabase ?? null;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  insertAutoRun = (dbMod as any)?.insertAutoRun ?? null;
});

/** Write a JSONL schedule file with one due auto-run task (mirrors cronAutoRunLifecycle pattern). */
function writeDueSchedule(schedulePath: string, taskText = "[AUTO_CONNECTS=5] [AUTO_DURATION=30] test"): void {
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
    ...extra,
  };
}

function makeMockDeps(schedulePath: string, salesDbPath: string, emittedFrames: unknown[]): MockRecord {
  return {
    model: null,
    system: "test-system",
    systemResume: "test-resume",
    tools: {},
    maxSteps: 1,
    auditWriter: { write: () => {} },
    session: {
      getClient: () => null,
      getOrInitClient: async () => ({ ok: false, error: "chrome_unavailable", message: "no chrome" }),
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

/**
 * Capturing turn runner — cron driver calls turn.runOneTurn(args).
 * P-AUTO-ISOLATE (Step 5): captures args so the cronPrompt (args.userPrompt) can be
 * inspected directly, since cron.ts no longer pushes it into state.messages.
 */
function makeCapturingTurn(): { runOneTurn: AnyFn; calls: MockRecord[] } {
  const calls: MockRecord[] = [];
  return {
    calls,
    runOneTurn: async (args: MockRecord) => {
      calls.push(args);
    },
  };
}

/** Insert a connect_sent ledger row with the given result into the given DB. */
// biome-ignore lint/suspicious/noExplicitAny: test DB handle
function insertConnectRow(db: any, runId: string, result: string): void {
  db.prepare(
    "INSERT INTO auto_run_ledger (id, run_id, action_type, lead_id, result, ts) VALUES (?, ?, 'connect_sent', NULL, ?, ?)",
  ).run(randomUUID(), runId, result, Date.now());
}

/**
 * Extract the cronPrompt from the captured turn.runOneTurn call's userPrompt arg.
 * P-AUTO-ISOLATE (Step 5): cron.ts no longer pushes into state.messages (that push
 * was DELETED as part of the per-tick isolation guarantee) — the cronPrompt is
 * threaded through TurnArgs.userPrompt (and TurnArgs.overrideMessages) instead.
 */
function extractCronPrompt(turnStub: { calls: MockRecord[] }): string | null {
  const last = turnStub.calls.at(-1);
  if (!last) return null;
  return typeof last.userPrompt === "string" ? last.userPrompt : null;
}

describe("T-A13.Cron — cron CONNECTS_USED uses success-only count (G-A13.9, P-AUTO-13)", () => {
  // ─── T-A13.Cron.1 — main scenario: 1 success + 2 skipped + 1 failed ────────
  it("T-A13.Cron.1: 1 success + 2 skipped + 1 failed connect_sent rows, maxConnects=5 → cronPrompt contains [CONNECTS_USED=1/5] NOT [CONNECTS_USED=4/5]", async () => {
    // Given: a running auto_run R with maxConnects=5;
    //        auto_run_ledger: 1 connect_sent/success + 2 connect_sent/skipped + 1 connect_sent/failed
    //        (4 total connect_sent rows, 1 successful send)
    // When:  the cron driver tick fires (a due schedule entry with [AUTO_CONNECTS=5])
    // Then:  the cronPrompt (in state.messages) contains [CONNECTS_USED=1/5]
    //        NOT [CONNECTS_USED=4/5] — failed + skipped rows MUST NOT inflate CONNECTS_USED.
    //        FAIL at Step 3: cron.ts still uses all-rows count, emitting CONNECTS_USED=4/5.

    assert.ok(createCronDriver !== null, "T-A13.Cron.1: createCronDriver must be importable");
    assert.ok(openSalesDatabase !== null, "T-A13.Cron.1: openSalesDatabase must be importable");
    assert.ok(insertAutoRun !== null, "T-A13.Cron.1: insertAutoRun must be importable");

    const salesDbPath = join(tmpdir(), `cron-pAuto13-t1-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `cron-pAuto13-t1-schedule-${randomUUID()}.jsonl`);

    const db = openSalesDatabase!(salesDbPath);
    // Pre-seed an active auto_run so cron resumes it instead of starting a new one
    const runRow = insertAutoRun!(db, { maxDurationMinutes: 30, maxConnects: 5 });

    // Insert 1 success + 2 skipped + 1 failed (4 connect_sent rows total, 1 success)
    insertConnectRow(db, runRow.id, "success");
    insertConnectRow(db, runRow.id, "skipped");
    insertConnectRow(db, runRow.id, "skipped");
    insertConnectRow(db, runRow.id, "failed");

    writeDueSchedule(schedulePath, "[AUTO_CONNECTS=5] [AUTO_DURATION=30] test run");

    const emittedFrames: unknown[] = [];
    const state = makeMockState({ autoRunId: runRow.id });
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);

    const turnStub = makeCapturingTurn();
    const driver = createCronDriver!(state, deps, turnStub);
    await driver.tick();

    const cronPrompt = extractCronPrompt(turnStub);
    assert.ok(
      typeof cronPrompt === "string" && cronPrompt.length > 0,
      "T-A13.Cron.1: cronPrompt must be pushed to state.messages after tick",
    );

    // TODO (assertion body — filled at Step 5):
    // assert.ok(
    //   /\[CONNECTS_USED=1\/5\]/.test(cronPrompt!),
    //   `cronPrompt must contain [CONNECTS_USED=1/5]; got: ${cronPrompt!.slice(0, 300)}`
    // );

    assert.ok(
      /\[CONNECTS_USED=1\/5\]/.test(cronPrompt!),
      `T-A13.Cron.1: cronPrompt must contain [CONNECTS_USED=1/5] (success-only, not all-rows=4); ` +
        `got cronPrompt slice: ${cronPrompt!.slice(0, 400)}`,
    );
  });

  // ─── T-A13.Cron.2 — 0 success rows: CONNECTS_USED=0 ─────────────────────
  it("T-A13.Cron.2: 3 skipped connect_sent rows, maxConnects=5 → cronPrompt contains [CONNECTS_USED=0/5]", async () => {
    // Given: running auto_run R with maxConnects=5;
    //        auto_run_ledger: 3 connect_sent/skipped (no success)
    // When:  cron tick fires
    // Then:  cronPrompt contains [CONNECTS_USED=0/5] (0 success sends = 0 connects used)
    //        FAIL at Step 3: CONNECTS_USED=3/5 (all-rows count)

    assert.ok(createCronDriver !== null, "T-A13.Cron.2: createCronDriver must be importable");
    assert.ok(openSalesDatabase !== null, "T-A13.Cron.2: openSalesDatabase must be importable");
    assert.ok(insertAutoRun !== null, "T-A13.Cron.2: insertAutoRun must be importable");

    const salesDbPath = join(tmpdir(), `cron-pAuto13-t2-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `cron-pAuto13-t2-schedule-${randomUUID()}.jsonl`);

    const db = openSalesDatabase!(salesDbPath);
    const runRow = insertAutoRun!(db, { maxDurationMinutes: 30, maxConnects: 5 });
    insertConnectRow(db, runRow.id, "skipped");
    insertConnectRow(db, runRow.id, "skipped");
    insertConnectRow(db, runRow.id, "skipped");

    writeDueSchedule(schedulePath, "[AUTO_CONNECTS=5] [AUTO_DURATION=30] test run");

    const emittedFrames: unknown[] = [];
    const state = makeMockState({ autoRunId: runRow.id });
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);

    const turnStub = makeCapturingTurn();
    const driver = createCronDriver!(state, deps, turnStub);
    await driver.tick();

    const cronPrompt = extractCronPrompt(turnStub);
    assert.ok(
      typeof cronPrompt === "string" && cronPrompt.length > 0,
      "T-A13.Cron.2: cronPrompt must be pushed to state.messages",
    );

    // TODO (assertion body — filled at Step 5):
    assert.ok(
      /\[CONNECTS_USED=0\/5\]/.test(cronPrompt!),
      `T-A13.Cron.2: cronPrompt must contain [CONNECTS_USED=0/5] (no success rows); ` +
        `got: ${cronPrompt!.slice(0, 400)}`,
    );
  });

  // ─── T-A13.Cron.3 — all success: CONNECTS_USED matches all-rows (agreement case) ─
  it("T-A13.Cron.3: 2 success connect_sent rows, maxConnects=5 → cronPrompt contains [CONNECTS_USED=2/5] (all-rows and success-only agree)", async () => {
    // Given: running auto_run R with maxConnects=5; ledger: 2 connect_sent/success
    // When:  cron tick fires
    // Then:  cronPrompt contains [CONNECTS_USED=2/5]
    //        This case should PASS at Step 3 (all-rows === success-only when all rows are success)
    //        and remain passing after Step 4.

    assert.ok(createCronDriver !== null, "T-A13.Cron.3: createCronDriver must be importable");
    assert.ok(openSalesDatabase !== null, "T-A13.Cron.3: openSalesDatabase must be importable");
    assert.ok(insertAutoRun !== null, "T-A13.Cron.3: insertAutoRun must be importable");

    const salesDbPath = join(tmpdir(), `cron-pAuto13-t3-${randomUUID()}.sqlite`);
    const schedulePath = join(tmpdir(), `cron-pAuto13-t3-schedule-${randomUUID()}.jsonl`);

    const db = openSalesDatabase!(salesDbPath);
    const runRow = insertAutoRun!(db, { maxDurationMinutes: 30, maxConnects: 5 });
    insertConnectRow(db, runRow.id, "success");
    insertConnectRow(db, runRow.id, "success");

    writeDueSchedule(schedulePath, "[AUTO_CONNECTS=5] [AUTO_DURATION=30] test run");

    const emittedFrames: unknown[] = [];
    const state = makeMockState({ autoRunId: runRow.id });
    const deps = makeMockDeps(schedulePath, salesDbPath, emittedFrames);

    const turnStub = makeCapturingTurn();
    const driver = createCronDriver!(state, deps, turnStub);
    await driver.tick();

    const cronPrompt = extractCronPrompt(turnStub);
    assert.ok(
      typeof cronPrompt === "string" && cronPrompt.length > 0,
      "T-A13.Cron.3: cronPrompt must be pushed to state.messages",
    );

    // TODO (assertion body — filled at Step 5):
    assert.ok(
      /\[CONNECTS_USED=2\/5\]/.test(cronPrompt!),
      `T-A13.Cron.3: cronPrompt must contain [CONNECTS_USED=2/5] (2 success rows); ` +
        `got: ${cronPrompt!.slice(0, 400)}`,
    );
  });
});
