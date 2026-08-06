/**
 * P-AUTO-L3FIX-8 — runOneTurn tool-progress deadline mock tests.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/cli/subcommands/serve/runOne-toolProgress-pAutoL3fix8.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, beforeEach, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { ServeDeps, ServeState } from "../../../../src/app/backend/context.js";
import type { TurnArgs } from "../../../../src/app/backend/turn/runOne.js";
import { cleanupTmpDir, makeTmpDir } from "../../../_helpers/tmp.js";

type LoopStep = { toolCalls: Array<{ toolName: string }>; toolResults: unknown[] };
type LoopOpts = {
  abortSignal?: AbortSignal;
  onStepFinish?: (step: LoopStep) => Promise<void>;
  onText?: (delta: string) => void;
  // P-UI-THINK-COMPACT: runOne feeds the silent-hang watchdog from
  // onAssistantPhaseText (the current Pi-loop text seam), not onText.
  onAssistantPhaseText?: (delta: string, phase: string) => void;
  onToolCall?: (toolName: string) => void;
};
type LoopScript = (opts: LoopOpts) => Promise<void>;
type RunOneTurn = (state: ServeState, deps: ServeDeps, args: TurnArgs) => Promise<void>;
type TestStatement = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
};
type TestDb = {
  prepare: (sql: string) => TestStatement;
};
type LlmErrorRow = {
  turnId?: string;
  errorMessage?: string;
  errorName?: string;
  turnKind?: string;
  status?: number;
};

let loopScript: LoopScript = async (opts) => {
  await opts.onStepFinish?.({ toolCalls: [], toolResults: [] });
};
let runOneTurn: RunOneTurn | null = null;
let openSalesDatabase: ((path: string) => TestDb) | null = null;
const llmErrors: LlmErrorRow[] = [];
let resolveLoopStarted: (() => void) | null = null;

before(async () => {
  const repoRoot = resolve(process.cwd());
  const piLoopUrl = pathToFileURL(join(repoRoot, "src/agent/pi/loop.js")).href;
  mock.module(piLoopUrl, {
    namedExports: {
      runAgentLoopPi: async (opts: LoopOpts) => {
        resolveLoopStarted?.();
        resolveLoopStarted = null;
        await loopScript(opts);
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
      writeLlmErrorAudit: (_auditPath: string, row: LlmErrorRow) => {
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

  const runOneMod = await import("../../../../src/app/backend/turn/runOne.js");
  runOneTurn = runOneMod.runOneTurn as RunOneTurn;
  const salesDbMod = await import("../../../../src/persistence/salesDb.js");
  openSalesDatabase = salesDbMod.openSalesDatabase as (path: string) => TestDb;
});

beforeEach(() => {
  loopScript = async (opts) => {
    await opts.onStepFinish?.({ toolCalls: [], toolResults: [] });
  };
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
    cronNoProgressRunId: null,
    cronNoProgressTurns: 0,
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

function makeDeps(frames: unknown[], salesDbPath = join(tmpdir(), `l3f8-empty-${randomUUID()}.sqlite`)): ServeDeps {
  return {
    model: {},
    system: "cron-system",
    systemResume: "resume-system",
    tools: {},
    maxSteps: 5,
    auditWriter: async () => undefined,
    session: {
      setTurnAbortSignal: () => undefined,
      clearTurnAbortSignal: () => undefined,
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

function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolveAbort) => {
    signal?.addEventListener("abort", () => resolveAbort(), { once: true });
  });
}

function waitForLoopStart(): Promise<void> {
  return new Promise((resolve) => {
    resolveLoopStarted = resolve;
  });
}

function pendingTextOnlyScript(increments: number[]): LoopScript {
  return async (opts) => {
    for (const increment of increments) {
      mock.timers.tick(increment);
      if (opts.abortSignal?.aborted) return;
      opts.onAssistantPhaseText?.("still planning", "intermediate");
      await Promise.resolve();
    }
    await waitForAbort(opts.abortSignal);
  };
}

function pendingNoProgressScript(): LoopScript {
  return async (opts) => {
    await waitForAbort(opts.abortSignal);
  };
}

function regularToolProgressScript(): LoopScript {
  return async (opts) => {
    for (const toolName of ["inspect_page", "click_profile", "present_summary"]) {
      mock.timers.tick(120_000);
      opts.onToolCall?.(toolName);
      await opts.onStepFinish?.({ toolCalls: [{ toolName }], toolResults: [] });
    }
    mock.timers.tick(150_000);
  };
}

async function runTurn(state: ServeState, deps: ServeDeps, args: Partial<TurnArgs> = {}): Promise<AbortController> {
  assert.ok(runOneTurn !== null, "runOneTurn must be imported");
  const abortController = args.abortController ?? new AbortController();
  await runOneTurn(state, deps, {
    turnId: args.turnId ?? randomUUID(),
    abortController,
    userPrompt: args.userPrompt ?? "go",
    isRetryable: args.isRetryable ?? false,
    maxSteps: args.maxSteps,
    isCronTurn: args.isCronTurn,
    isWorkflowResume: args.isWorkflowResume,
  });
  return abortController;
}

function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const tmpDir = makeTmpDir("frondose-l3f8-");
  const prevHomeBase = process.env.FRONDOSE_HOME_BASE;
  process.env.FRONDOSE_HOME_BASE = tmpDir;
  return fn().finally(() => {
    if (prevHomeBase === undefined) delete process.env.FRONDOSE_HOME_BASE;
    else process.env.FRONDOSE_HOME_BASE = prevHomeBase;
    cleanupTmpDir(tmpDir);
  });
}

function seedRun(db: TestDb, input: { runId?: string; startedAt: number; maxDurationMinutes: number }): string {
  const runId = input.runId ?? randomUUID();
  db.prepare(
    "INSERT INTO auto_runs (id, started_at, ended_at, max_duration_minutes, max_connects, status, summary, counters) VALUES (?, ?, NULL, ?, 20, 'running', NULL, NULL)",
  ).run(runId, input.startedAt, input.maxDurationMinutes);
  return runId;
}

function readRun(db: TestDb, runId: string): { status: string; summary: string | null; endedAt: number | null } {
  return db.prepare("SELECT status, summary, ended_at AS endedAt FROM auto_runs WHERE id = ?").get(runId) as {
    status: string;
    summary: string | null;
    endedAt: number | null;
  };
}

function completedFrames(
  frames: unknown[],
  runId?: string,
): Array<{ runId?: string; summary?: string; status?: string }> {
  return frames.filter(
    (frame): frame is { type: string; runId?: string; summary?: string; status?: string } =>
      typeof frame === "object" &&
      frame !== null &&
      (frame as { type?: unknown }).type === "auto-run-completed" &&
      (runId === undefined || (frame as { runId?: unknown }).runId === runId),
  );
}

function errorFrames(frames: unknown[]): Array<{ message?: string; turnId?: string }> {
  return frames.filter(
    (frame): frame is { type: string; message?: string; turnId?: string } =>
      typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "error",
  );
}

describe("P-AUTO-L3FIX-8 runOneTurn tool-progress deadline", () => {
  it("T-L3F8.1: when no tool or step progress reaches 210s, runOneTurn aborts, audits LlmNoToolProgress, and emits an error frame", async () => {
    // Given a pending Pi loop that only keeps D-27 fresh with text and never calls onToolCall/onStepFinish, when fake time reaches 210s, then no-tool-progress abort is audited and emitted.
    mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
    try {
      await withTempHome(async () => {
        const frames: unknown[] = [];
        const ac = new AbortController();
        loopScript = pendingTextOnlyScript([60_000, 60_000, 60_000, 30_000]);

        await runTurn(makeState(), makeDeps(frames), { abortController: ac, turnId: "l3f8-1" });

        assert.equal(ac.signal.aborted, true, "watcher must abort the active turn controller");
        assert.equal(llmErrors.length, 1, "exactly one llm_error audit row must be written");
        assert.equal(llmErrors[0]?.errorName, "LlmNoToolProgress");
        assert.equal(llmErrors[0]?.turnKind, "operator");
        assert.equal(errorFrames(frames).filter((frame) => /llm-no-tool-progress/.test(frame.message ?? "")).length, 1);
      });
    } finally {
      mock.timers.reset();
    }
  });

  it("T-L3F8.2: tool and step progress reset the deadline, while text-only progress does not count as tool progress", async () => {
    // Given one turn with repeated tool/step progress and another text-only pending turn, when watchers tick, then only the text-only turn aborts as no-tool-progress.
    mock.timers.enable({ apis: ["setInterval", "Date"], now: 2_000_000 });
    try {
      await withTempHome(async () => {
        const progressFrames: unknown[] = [];
        loopScript = regularToolProgressScript();

        await runTurn(makeState(), makeDeps(progressFrames), { turnId: "l3f8-2-progress" });

        assert.equal(
          llmErrors.filter((row) => row.errorName === "LlmNoToolProgress").length,
          0,
          "regular tool/step progress must not trip the new watcher",
        );
        assert.equal(errorFrames(progressFrames).length, 0, "regular tool/step progress must not emit an error frame");

        const textOnlyFrames: unknown[] = [];
        loopScript = pendingTextOnlyScript([60_000, 60_000, 60_000, 30_000]);

        await runTurn(makeState(), makeDeps(textOnlyFrames), { turnId: "l3f8-2-text-only" });

        assert.equal(
          llmErrors.filter((row) => row.errorName === "LlmNoToolProgress").length,
          1,
          "text progress must not reset lastToolProgressAt",
        );
        assert.equal(
          errorFrames(textOnlyFrames).filter((frame) => /llm-no-tool-progress/.test(frame.message ?? "")).length,
          1,
        );
      });
    } finally {
      mock.timers.reset();
    }
  });

  it("T-L3F8.3: the no-tool-progress deadline starts at turn start even before any tool call exists", async () => {
    // Given a text-only pending turn whose first visible progress arrives after start, when 210s elapses from turn start, then the watcher aborts without waiting for a first tool call.
    mock.timers.enable({ apis: ["setInterval", "Date"], now: 3_000_000 });
    try {
      await withTempHome(async () => {
        const frames: unknown[] = [];
        let capturedOpts: LoopOpts | null = null;
        loopScript = async (opts) => {
          capturedOpts = opts;
          await waitForAbort(opts.abortSignal);
        };

        const loopStarted = waitForLoopStart();
        const pending = runTurn(makeState(), makeDeps(frames), { turnId: "l3f8-3" });
        await loopStarted;
        assert.ok(capturedOpts !== null, "loop opts must be captured");
        mock.timers.tick(60_000);
        capturedOpts.onAssistantPhaseText?.("first visible text after start", "intermediate");
        mock.timers.tick(60_000);
        capturedOpts.onAssistantPhaseText?.("still planning", "intermediate");
        mock.timers.tick(60_000);
        capturedOpts.onAssistantPhaseText?.("still planning", "intermediate");
        mock.timers.tick(29_999);
        assert.equal(llmErrors.length, 0, "the deadline must not fire before the 210s boundary");

        mock.timers.tick(1);
        await pending;

        assert.equal(
          llmErrors.filter((row) => row.errorName === "LlmNoToolProgress").length,
          1,
          "a turn with no first tool/step progress must abort at the start-based 210s deadline",
        );
      });
    } finally {
      mock.timers.reset();
    }
  });

  it("T-L3F8.4: turn teardown clears the tool-progress watcher so later fake time cannot abort an ended turn", async () => {
    // Given a normally completed turn, when fake time advances past 210s after teardown, then no stale tool-progress interval writes an error.
    mock.timers.enable({ apis: ["setInterval", "Date"], now: 4_000_000 });
    try {
      await withTempHome(async () => {
        const frames: unknown[] = [];

        await runTurn(makeState(), makeDeps(frames), { turnId: "l3f8-4" });
        mock.timers.tick(240_000);

        assert.equal(llmErrors.length, 0, "cleared watcher must not write a late llm_error row");
        assert.equal(errorFrames(frames).length, 0, "cleared watcher must not emit a late error frame");
      });
    } finally {
      mock.timers.reset();
    }
  });

  it("T-L3F8.5: a pure no-text/no-tool stall still classifies as D-27 LlmSilentHang before no-tool-progress", async () => {
    // Given a pending Pi loop with no text, tool call, or step finish, when fake time reaches 180s, then D-27 wins with LlmSilentHang.
    mock.timers.enable({ apis: ["setInterval", "Date"], now: 5_000_000 });
    try {
      await withTempHome(async () => {
        const frames: unknown[] = [];
        loopScript = pendingNoProgressScript();

        const loopStarted = waitForLoopStart();
        const pending = runTurn(makeState(), makeDeps(frames), { turnId: "l3f8-5" });
        await loopStarted;
        mock.timers.tick(180_000);
        await pending;

        assert.equal(llmErrors.length, 1);
        assert.equal(llmErrors[0]?.errorName, "LlmSilentHang");
        assert.equal(
          llmErrors.filter((row) => row.errorName === "LlmNoToolProgress").length,
          0,
          "the 210s watcher must not reclassify a pure D-27 stall",
        );
      });
    } finally {
      mock.timers.reset();
    }
  });

  it("T-L3F8.6: a no-tool-progress abort closes a running Auto run once and preserves cron exactly-once handoff", async () => {
    // Given running Auto rows for non-cron and cron turns, when no-tool-progress aborts each turn, then both rows close and only the non-cron path emits completion.
    mock.timers.enable({ apis: ["setInterval", "Date"], now: 6_000_000 });
    try {
      await withTempHome(async () => {
        assert.ok(openSalesDatabase !== null, "openSalesDatabase must be imported");
        const nonCronDbPath = join(tmpdir(), `l3f8-6-noncron-${randomUUID()}.sqlite`);
        const nonCronDb = openSalesDatabase(nonCronDbPath);
        const nonCronRunId = seedRun(nonCronDb, { startedAt: Date.now(), maxDurationMinutes: 480 });
        const nonCronFrames: unknown[] = [];
        loopScript = pendingTextOnlyScript([60_000, 60_000, 60_000, 30_000]);

        await runTurn(makeState({ autoRunId: nonCronRunId }), makeDeps(nonCronFrames, nonCronDbPath), {
          turnId: "l3f8-6-noncron",
          isCronTurn: false,
        });

        const nonCronRow = readRun(nonCronDb, nonCronRunId);
        assert.equal(nonCronRow.status, "stopped_by_agent");
        assert.match(nonCronRow.summary ?? "", /no_tool_progress_abort/);
        assert.equal(completedFrames(nonCronFrames, nonCronRunId).length, 1, "non-cron teardown emits exactly once");

        const cronDbPath = join(tmpdir(), `l3f8-6-cron-${randomUUID()}.sqlite`);
        const cronDb = openSalesDatabase(cronDbPath);
        const cronRunId = seedRun(cronDb, { startedAt: Date.now(), maxDurationMinutes: 480 });
        const cronFrames: unknown[] = [];
        loopScript = pendingTextOnlyScript([60_000, 60_000, 60_000, 30_000]);

        await runTurn(makeState({ autoRunId: cronRunId, cronEnabled: true }), makeDeps(cronFrames, cronDbPath), {
          turnId: "l3f8-6-cron",
          isCronTurn: true,
        });

        const cronRow = readRun(cronDb, cronRunId);
        assert.equal(cronRow.status, "stopped_by_agent");
        assert.match(cronRow.summary ?? "", /no_tool_progress_abort/);
        assert.equal(
          completedFrames(cronFrames, cronRunId).length,
          0,
          "cron teardown must hand completion emission to cron rather than double-emitting",
        );
      });
    } finally {
      mock.timers.reset();
    }
  });

  it("T-L3F8.8: LlmNoToolProgress audit rows carry the cron and workflow_resume turnKind values", async () => {
    // Given cron and workflow-resume turns with text-only pending loops, when no-tool-progress aborts, then the audit rows use the existing turnKind ternary.
    mock.timers.enable({ apis: ["setInterval", "Date"], now: 7_000_000 });
    try {
      await withTempHome(async () => {
        loopScript = pendingTextOnlyScript([60_000, 60_000, 60_000, 30_000]);
        await runTurn(makeState({ cronEnabled: true }), makeDeps([]), { turnId: "l3f8-8-cron", isCronTurn: true });

        loopScript = pendingTextOnlyScript([60_000, 60_000, 60_000, 30_000]);
        await runTurn(makeState(), makeDeps([]), {
          turnId: "l3f8-8-resume",
          isWorkflowResume: true,
        });

        const noToolRows = llmErrors.filter((row) => row.errorName === "LlmNoToolProgress");
        assert.equal(noToolRows.length, 2);
        assert.deepEqual(
          noToolRows.map((row) => row.turnKind),
          ["cron", "workflow_resume"],
        );
      });
    } finally {
      mock.timers.reset();
    }
  });
});
