/**
 * Phase WORKFLOW-LIFECYCLE-COMPLETION (P-WLC) — BE mock tests.
 *
 * Behavior under test: an operator-driven (non-cron) Auto turn in which the agent
 * calls `end_auto_run` must emit exactly one terminal `auto-run-completed` SSE frame
 * from the serve layer (the tool body cannot emit SSE — no-bash tool boundary), so the
 * FE Auto stage can finalize. Cron turns are excluded (cron.ts owns that emit) to avoid
 * a double-emit; an idempotent (alreadyEnded) re-call and non-end tool results emit nothing.
 *
 * Harness mirrors runOne-silentHang-pAutoL3fix2.mock.test.ts (mocks the Pi loop, model,
 * audit, overlay; drives the real runOneTurn against a real sqlite auto_runs row).
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/cli/subcommands/serve/runOne-autoRunCompleted-pWLC.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, beforeEach, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { ServeDeps, ServeState } from "../../../../src/app/backend/context.js";
import type { TurnArgs } from "../../../../src/app/backend/turn/runOne.js";

type LoopOpts = {
  abortSignal?: AbortSignal;
  onStepFinish?: (step: { toolCalls: unknown[]; toolResults: unknown[] }) => Promise<void>;
};
type RunOneTurn = (state: ServeState, deps: ServeDeps, args: TurnArgs) => Promise<void>;
type TestStatement = { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown };
type TestDb = { prepare: (sql: string) => TestStatement };

// Per-step injection: the tool results the mocked loop reports, plus a pre-step side
// effect that mimics the real end_auto_run tool mutating the auto_runs row.
let stepToolResults: unknown[] = [];
let preStep: (() => void) | null = null;

let runOneTurn: RunOneTurn | null = null;
let openSalesDatabase: ((path: string) => TestDb) | null = null;
let endAutoRunFn: ((db: TestDb, id: string, input: unknown) => unknown) | null = null;

before(async () => {
  const repoRoot = resolve(process.cwd());
  const piLoopUrl = pathToFileURL(join(repoRoot, "src/agent/pi/loop.js")).href;
  mock.module(piLoopUrl, {
    namedExports: {
      runAgentLoopPi: async (opts: LoopOpts) => {
        preStep?.();
        await opts.onStepFinish?.({ toolCalls: [], toolResults: stepToolResults });
      },
    },
  });

  const piModelUrl = pathToFileURL(join(repoRoot, "src/agent/pi/model.js")).href;
  mock.module(piModelUrl, {
    namedExports: {
      resolvePiModel: () => ({
        model: { id: "deepseek-test" },
        apiKey: "test-key",
        onPayload: (p: unknown) => p,
        timeoutMs: 120_000,
      }),
    },
  });

  const auditUrl = pathToFileURL(join(repoRoot, "src/persistence/audit.js")).href;
  mock.module(auditUrl, { namedExports: { writeLlmErrorAudit: () => undefined } });

  const injectUrl = pathToFileURL(join(repoRoot, "src/overlay/inject.js")).href;
  mock.module(injectUrl, { namedExports: { callInOverlay: async () => undefined } });

  const runOneMod = await import("../../../../src/app/backend/turn/runOne.js");
  runOneTurn = runOneMod.runOneTurn as RunOneTurn;
  const salesDbMod = await import("../../../../src/persistence/salesDb.js");
  openSalesDatabase = salesDbMod.openSalesDatabase as (path: string) => TestDb;
  endAutoRunFn = salesDbMod.endAutoRun as unknown as (db: TestDb, id: string, input: unknown) => unknown;
});

beforeEach(() => {
  stepToolResults = [];
  preStep = null;
});

function makeState(overrides: Partial<ServeState> = {}): ServeState {
  return {
    currentTurn: null,
    overlayContextId: undefined,
    unsubscribeContextId: undefined,
    unsubscribeOverlayEvents: undefined,
    cronEnabled: false,
    passiveEnabled: false,
    autoRunId: null,
    lastEmittedAutoCounters: null,
    lastTurnUserPrompt: null,
    lastFailedTurnPrompt: null,
    retryAttempts: 0,
    messages: [],
    passiveProfileCache: new Map(),
    passiveLimiter: { check: () => ({ ok: true }) },
    sseClients: new Set(),
    ...overrides,
  } as unknown as ServeState;
}

function makeDeps(frames: unknown[], salesDbPath: string): ServeDeps {
  return {
    model: {},
    system: "system",
    systemResume: "resume-system",
    tools: {},
    maxSteps: 5,
    auditWriter: async () => undefined,
    session: { setTurnAbortSignal: () => undefined, clearTurnAbortSignal: () => undefined, getClient: () => null },
    schedulePath: "/dev/null",
    salesDbPath,
    auditPath: "/dev/null",
    expectedToken: Buffer.from("test"),
    workflow: {
      onToolResults: () => ({ abort: false }),
      handleEndpoint: () => ({ status: 200, response: { ok: true } }),
      getState: () => ({ current: null, awaitingApprovalStepId: null }),
    },
    emitFrame: (frame: unknown) => {
      frames.push(frame);
    },
    emitOverlayEvent: () => undefined,
    composeOperatorSystem: () => "operator-system",
  } as unknown as ServeDeps;
}

function seedRun(db: TestDb, runId: string): void {
  db.prepare(
    "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, 480, 20, 'running', NULL, NULL)",
  ).run(runId, Date.now());
}

function endTool(runId: string, alreadyEnded: boolean, status = "completed"): unknown {
  return {
    toolName: "end_auto_run",
    result: { ok: true, command: "end_auto_run", data: { runId, status, alreadyEnded, counters: {} } },
  };
}

function completedFrames(
  frames: unknown[],
  runId: string,
): Array<{ status?: string; summary?: string | null; finalCounters?: unknown }> {
  return frames.filter(
    (f): f is { type: string; runId: string; status?: string; summary?: string | null; finalCounters?: unknown } =>
      typeof f === "object" &&
      f !== null &&
      (f as { type?: unknown }).type === "auto-run-completed" &&
      (f as { runId?: unknown }).runId === runId,
  );
}

async function runTurn(state: ServeState, deps: ServeDeps, args: Partial<TurnArgs> = {}): Promise<void> {
  assert.ok(runOneTurn !== null, "runOneTurn imported");
  await runOneTurn(state, deps, {
    turnId: args.turnId ?? randomUUID(),
    abortController: args.abortController ?? new AbortController(),
    userPrompt: "go",
    isRetryable: false,
    isCronTurn: args.isCronTurn,
    maxSteps: args.maxSteps,
    isWorkflowResume: args.isWorkflowResume,
  });
}

describe("P-WLC — runOneTurn emits auto-run-completed on agent end_auto_run", () => {
  it("WLC.a: an operator (non-cron) turn whose agent calls end_auto_run emits exactly one auto-run-completed frame with the persisted status+summary and clears state.autoRunId", async () => {
    // Given: a running auto_run + a loop step where the agent ends it cleanly.
    // When: runOneTurn observes the end_auto_run tool result on a non-cron turn.
    // Then: exactly one auto-run-completed frame is emitted with the persisted row's status/summary; state.autoRunId cleared.
    assert.ok(openSalesDatabase !== null && endAutoRunFn !== null);
    const salesDbPath = join(tmpdir(), `wlc-a-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(salesDbPath);
    const runId = randomUUID();
    seedRun(db, runId);
    const frames: unknown[] = [];
    const state = makeState({ autoRunId: runId });
    const deps = makeDeps(frames, salesDbPath);
    // Mimic the real end_auto_run tool: it mutates the row, then returns the envelope.
    preStep = () => {
      endAutoRunFn?.(db, runId, {
        status: "completed",
        summary: "Run summary: 3 candidates observed, 2 connect_sent.",
        counters: {},
      });
    };
    stepToolResults = [endTool(runId, false, "completed")];

    await runTurn(state, deps, { isCronTurn: false });

    const emitted = completedFrames(frames, runId);
    assert.equal(emitted.length, 1, "exactly one auto-run-completed frame");
    assert.equal(emitted[0]?.status, "completed");
    assert.match(emitted[0]?.summary ?? "", /3 candidates observed/);
    assert.equal(typeof emitted[0]?.finalCounters, "object");
    assert.notEqual(emitted[0]?.finalCounters, null);
    assert.equal(state.autoRunId, null, "state.autoRunId cleared after emit");
  });

  it("WLC.b: a cron turn whose agent calls end_auto_run emits NO auto-run-completed from runOneTurn (cron.ts owns that emit — no double-emit)", async () => {
    // Given: same clean end, but isCronTurn=true.
    // When: runOneTurn runs the cron turn.
    // Then: runOneTurn emits zero auto-run-completed frames (the guard defers to cron.ts).
    assert.ok(openSalesDatabase !== null && endAutoRunFn !== null);
    const salesDbPath = join(tmpdir(), `wlc-b-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(salesDbPath);
    const runId = randomUUID();
    seedRun(db, runId);
    const frames: unknown[] = [];
    const state = makeState({ autoRunId: runId, cronEnabled: true });
    const deps = makeDeps(frames, salesDbPath);
    preStep = () => {
      endAutoRunFn?.(db, runId, { status: "completed", summary: "Cron run done.", counters: {} });
    };
    stepToolResults = [endTool(runId, false, "completed")];

    await runTurn(state, deps, { isCronTurn: true });

    assert.equal(completedFrames(frames, runId).length, 0, "cron turn must not emit from runOneTurn");
  });

  it("WLC.c: an idempotent end_auto_run re-call (alreadyEnded=true) emits nothing", async () => {
    // Given: the agent re-calls end_auto_run and the tool reports alreadyEnded=true.
    // When: runOneTurn observes it on a non-cron turn.
    // Then: no auto-run-completed frame (avoids a duplicate on repeat calls).
    assert.ok(openSalesDatabase !== null && endAutoRunFn !== null);
    const salesDbPath = join(tmpdir(), `wlc-c-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(salesDbPath);
    const runId = randomUUID();
    seedRun(db, runId);
    endAutoRunFn(db, runId, { status: "completed", summary: "Already ended earlier.", counters: {} });
    const frames: unknown[] = [];
    const state = makeState({ autoRunId: runId });
    const deps = makeDeps(frames, salesDbPath);
    stepToolResults = [endTool(runId, true, "completed")];

    await runTurn(state, deps, { isCronTurn: false });

    assert.equal(completedFrames(frames, runId).length, 0, "alreadyEnded re-call emits nothing");
  });

  it("WLC.d: a turn with no end_auto_run tool result emits no auto-run-completed frame", async () => {
    // Given: the step reports an unrelated tool result.
    // When: runOneTurn observes it.
    // Then: no auto-run-completed frame is emitted.
    assert.ok(openSalesDatabase !== null);
    const salesDbPath = join(tmpdir(), `wlc-d-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(salesDbPath);
    const runId = randomUUID();
    seedRun(db, runId);
    const frames: unknown[] = [];
    const state = makeState({ autoRunId: runId });
    const deps = makeDeps(frames, salesDbPath);
    stepToolResults = [{ toolName: "score_lead", result: { ok: true, command: "score_lead", data: {} } }];

    await runTurn(state, deps, { isCronTurn: false });

    assert.equal(completedFrames(frames, runId).length, 0, "non-end tool result emits nothing");
  });
});
