/**
 * P-AUTO-L3FIX-2 — W2 mock tests: runOneTurn closes silent-hang auto_runs.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/cli/subcommands/serve/runOne-silentHang-pAutoL3fix2.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, beforeEach, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { ServeDeps, ServeState } from "../../../../src/cli/subcommands/serve/context.js";
import type { TurnArgs } from "../../../../src/cli/subcommands/serve/turn/runOne.js";

type LoopMode = "resolve" | "hang-until-abort";
type LoopOpts = {
  abortSignal?: AbortSignal;
  onStepFinish?: (step: { toolCalls: unknown[]; toolResults: unknown[] }) => Promise<void>;
};
type RunOneTurn = (state: ServeState, deps: ServeDeps, args: TurnArgs) => Promise<void>;
type TestStatement = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
};
type TestDb = {
  prepare: (sql: string) => TestStatement;
};

let loopMode: LoopMode = "resolve";
let runOneTurn: RunOneTurn | null = null;
let openSalesDatabase: ((path: string) => TestDb) | null = null;
const llmErrors: unknown[] = [];
let resolveLoopStarted: (() => void) | null = null;

before(async () => {
  const repoRoot = resolve(process.cwd());
  const piLoopUrl = pathToFileURL(join(repoRoot, "src/agent/pi/loop.js")).href;
  mock.module(piLoopUrl, {
    namedExports: {
      runAgentLoopPi: async (opts: LoopOpts) => {
        resolveLoopStarted?.();
        resolveLoopStarted = null;
        if (loopMode === "resolve") {
          await opts.onStepFinish?.({ toolCalls: [], toolResults: [] });
          return;
        }
        await new Promise<void>((resolveAbort) => {
          if (opts.abortSignal?.aborted) {
            resolveAbort();
            return;
          }
          opts.abortSignal?.addEventListener("abort", () => resolveAbort(), { once: true });
        });
      },
    },
  });

  const piModelUrl = pathToFileURL(join(repoRoot, "src/agent/pi/model.js")).href;
  mock.module(piModelUrl, {
    namedExports: {
      resolvePiModel: () => ({
        model: { id: "deepseek-test" },
        apiKey: "test-key",
        onPayload: (payload: unknown) => payload,
        timeoutMs: 120_000,
      }),
    },
  });

  const auditUrl = pathToFileURL(join(repoRoot, "src/persistence/audit.js")).href;
  mock.module(auditUrl, {
    namedExports: {
      writeLlmErrorAudit: (_auditPath: string, row: unknown) => {
        llmErrors.push(row);
      },
    },
  });

  const injectUrl = pathToFileURL(join(repoRoot, "src/overlay/inject.js")).href;
  mock.module(injectUrl, {
    namedExports: {
      callInOverlay: async () => undefined,
    },
  });

  const runOneMod = await import("../../../../src/cli/subcommands/serve/turn/runOne.js");
  runOneTurn = runOneMod.runOneTurn as RunOneTurn;
  const salesDbMod = await import("../../../../src/persistence/salesDb.js");
  openSalesDatabase = salesDbMod.openSalesDatabase as (path: string) => TestDb;
});

beforeEach(() => {
  loopMode = "resolve";
  llmErrors.length = 0;
  resolveLoopStarted = null;
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
    system: "cron-system",
    systemResume: "resume-system",
    tools: {},
    maxSteps: 5,
    auditWriter: async () => undefined,
    session: {
      setTurnAbortSignal: () => undefined,
      getClient: () => null,
    },
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

function seedRun(
  db: TestDb,
  input: { runId?: string; startedAt: number; maxDurationMinutes: number },
): string {
  const runId = input.runId ?? randomUUID();
  db.prepare(
    "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, ?, 20, 'running', NULL, NULL)",
  ).run(runId, input.startedAt, input.maxDurationMinutes);
  return runId;
}

function readRun(db: TestDb, runId: string): { status: string; summary: string | null; endedAt: number | null } {
  return db
    .prepare("SELECT status, summary, ended_at AS endedAt FROM auto_runs WHERE id = ?")
    .get(runId) as { status: string; summary: string | null; endedAt: number | null };
}

async function runTurn(state: ServeState, deps: ServeDeps, args: Partial<TurnArgs> = {}): Promise<void> {
  assert.ok(runOneTurn !== null, "runOneTurn must be imported");
  await runOneTurn(state, deps, {
    turnId: args.turnId ?? randomUUID(),
    abortController: args.abortController ?? new AbortController(),
    userPrompt: args.userPrompt ?? "go",
    isRetryable: args.isRetryable ?? false,
    isCronTurn: args.isCronTurn,
    maxSteps: args.maxSteps,
    isWorkflowResume: args.isWorkflowResume,
  });
}

function waitForLoopStart(): Promise<void> {
  return new Promise((resolve) => {
    resolveLoopStarted = resolve;
  });
}

function completedFrames(frames: unknown[], runId: string): Array<{ summary?: string; status?: string }> {
  return frames.filter(
    (frame): frame is { type: string; runId: string; summary?: string; status?: string } =>
      typeof frame === "object" &&
      frame !== null &&
      (frame as { type?: unknown }).type === "auto-run-completed" &&
      (frame as { runId?: unknown }).runId === runId,
  );
}

describe("W2 — runOneTurn silent-hang auto_run closure", () => {
  it("W2.a: D-27 silent-hang abort closes a still-running auto_run as stopped_by_agent with silent_hang_abort summary", async () => {
    // Given: a running auto_run and a Pi loop that makes no progress until the D-27 watcher aborts.
    // When: fake time advances past the 180s silent-hang threshold.
    // Then: runOneTurn closes the row and emits one non-cron auto-run-completed frame.
    mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 1_000_000 });
    try {
      assert.ok(openSalesDatabase !== null, "openSalesDatabase must be imported");
      const salesDbPath = join(tmpdir(), `w2-silent-${randomUUID()}.sqlite`);
      const db = openSalesDatabase(salesDbPath);
      const runId = seedRun(db, { startedAt: Date.now(), maxDurationMinutes: 480 });
      const frames: unknown[] = [];
      const state = makeState({ autoRunId: runId });
      const deps = makeDeps(frames, salesDbPath);
      loopMode = "hang-until-abort";

      const loopStarted = waitForLoopStart();
      const pending = runTurn(state, deps);
      await loopStarted;
      mock.timers.tick(180_000);
      await pending;

      const row = readRun(db, runId);
      assert.equal(row.status, "stopped_by_agent");
      assert.match(row.summary ?? "", /silent_hang_abort/);
      assert.equal(completedFrames(frames, runId).length, 1, "non-cron teardown must emit one closed-row frame");
      assert.equal(state.autoRunId, null, "non-cron teardown clears state.autoRunId after emitting");
      assert.equal(llmErrors.length, 1, "D-27 still writes the llm_error audit row");
    } finally {
      mock.timers.reset();
    }
  });

  it("W2.b: normal cron turn-end with more work pending leaves the auto_run running", async () => {
    // Given: a running auto_run under the duration cap and a loop that completes normally.
    // When: runOneTurn finishes a cron turn.
    // Then: the row remains running and no auto-run-completed frame is emitted.
    assert.ok(openSalesDatabase !== null, "openSalesDatabase must be imported");
    const salesDbPath = join(tmpdir(), `w2-normal-${randomUUID()}.sqlite`);
    const db = openSalesDatabase(salesDbPath);
    const runId = seedRun(db, { startedAt: Date.now(), maxDurationMinutes: 480 });
    const frames: unknown[] = [];
    const state = makeState({ autoRunId: runId, cronEnabled: true });
    const deps = makeDeps(frames, salesDbPath);

    await runTurn(state, deps, { isCronTurn: true });

    const row = readRun(db, runId);
    assert.equal(row.status, "running");
    assert.equal(row.endedAt, null);
    assert.equal(completedFrames(frames, runId).length, 0, "normal turn-end must not close or emit completion");
  });

  it("W2.c: duration-cap abort is closed by the existing reaper and is not double-closed by silent-hang logic", async () => {
    // Given: a running auto_run already past its duration cap and a loop waiting for abort.
    // When: the D-16 cap watcher aborts the turn.
    // Then: the existing duration reaper closes it once with the duration summary, not silent_hang_abort.
    mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 2_000_000 });
    try {
      assert.ok(openSalesDatabase !== null, "openSalesDatabase must be imported");
      const salesDbPath = join(tmpdir(), `w2-cap-${randomUUID()}.sqlite`);
      const db = openSalesDatabase(salesDbPath);
      const runId = seedRun(db, { startedAt: Date.now() - 61_000, maxDurationMinutes: 1 });
      const frames: unknown[] = [];
      const state = makeState({ autoRunId: runId });
      const deps = makeDeps(frames, salesDbPath);
      loopMode = "hang-until-abort";

      const loopStarted = waitForLoopStart();
      const pending = runTurn(state, deps);
      await loopStarted;
      mock.timers.tick(15_000);
      await pending;

      const row = readRun(db, runId);
      assert.equal(row.status, "stopped_by_agent");
      assert.match(row.summary ?? "", /Duration cap reached/);
      assert.doesNotMatch(row.summary ?? "", /silent_hang_abort/);
      assert.equal(completedFrames(frames, runId).length, 1, "duration reaper should emit exactly one completion frame");
    } finally {
      mock.timers.reset();
    }
  });
});
