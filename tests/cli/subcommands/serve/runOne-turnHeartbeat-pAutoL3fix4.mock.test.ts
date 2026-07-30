/**
 * P-AUTO-L3FIX-4 — turn heartbeat mock tests.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/cli/subcommands/serve/runOne-turnHeartbeat-pAutoL3fix4.mock.test.ts
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { ServeDeps, ServeState } from "../../../../src/cli/subcommands/serve/context.js";
import type { TurnArgs } from "../../../../src/cli/subcommands/serve/turn/runOne.js";
import { HEARTBEAT_PATH } from "../../../../src/persistence/paths.js";
import { cleanupTmpDir, makeTmpDir } from "../../../_helpers/tmp.js";

type LoopMode = "resolve" | "capture-start" | "progress-throttle" | "fs-error";
type LoopOpts = {
  onStepFinish?: (step: { toolCalls: unknown[]; toolResults: unknown[] }) => Promise<void>;
  onText?: (delta: string) => void;
  onToolCall?: (toolName: string) => void;
};
type RunOneTurn = (state: ServeState, deps: ServeDeps, args: TurnArgs) => Promise<void>;

let loopMode: LoopMode = "resolve";
let runOneTurn: RunOneTurn | null = null;
let startSawHeartbeat = false;
let startHeartbeatPath = "";
let progressStats: {
  startMtimeMs: number;
  afterFirstWindowMtimeMs: number;
  afterRapidMtimeMs: number;
} | null = null;

before(async () => {
  const repoRoot = resolve(process.cwd());
  const piLoopUrl = pathToFileURL(`${repoRoot}/src/agent/pi/loop.js`).href;
  mock.module(piLoopUrl, {
    namedExports: {
      runAgentLoopPi: async (opts: LoopOpts) => {
        if (loopMode === "capture-start") {
          startHeartbeatPath = HEARTBEAT_PATH();
          startSawHeartbeat = fs.existsSync(startHeartbeatPath);
        }
        if (loopMode === "progress-throttle") {
          const heartbeatPath = HEARTBEAT_PATH();
          const startMtimeMs = fs.statSync(heartbeatPath).mtimeMs;
          mock.timers.tick(5_000);
          opts.onText?.("first-window-progress");
          const afterFirstWindowMtimeMs = fs.statSync(heartbeatPath).mtimeMs;
          opts.onText?.("rapid-1");
          opts.onText?.("rapid-2");
          opts.onToolCall?.("inspect_page");
          const afterRapidMtimeMs = fs.statSync(heartbeatPath).mtimeMs;
          progressStats = { startMtimeMs, afterFirstWindowMtimeMs, afterRapidMtimeMs };
        }
        if (loopMode === "fs-error") {
          mock.timers.tick(5_000);
          opts.onText?.("progress-after-start-write-failure");
        }
        await opts.onStepFinish?.({ toolCalls: [], toolResults: [] });
      },
    },
  });

  const piModelUrl = pathToFileURL(`${repoRoot}/src/agent/pi/model.js`).href;
  mock.module(piModelUrl, {
    namedExports: {
      resolvePiModel: () => ({
        model: { id: "deepseek-test" },
        apiKey: "test-key",
        onPayload: (payload: unknown) => payload,
      }),
    },
  });

  const auditUrl = pathToFileURL(`${repoRoot}/src/persistence/audit.js`).href;
  mock.module(auditUrl, {
    namedExports: {
      writeLlmErrorAudit: () => undefined,
    },
  });

  const injectUrl = pathToFileURL(`${repoRoot}/src/overlay/inject.js`).href;
  mock.module(injectUrl, {
    namedExports: {
      callInOverlay: async () => undefined,
    },
  });

  const salesDbUrl = pathToFileURL(`${repoRoot}/src/persistence/salesDb.js`).href;
  mock.module(salesDbUrl, {
    namedExports: {
      countAutoLedgerByAction: () => ({}),
      endAutoRun: () => ({ alreadyEnded: false }),
      getAutoRun: () => null,
      getCurrentAutoRun: () => null,
      initSalesDb: () => ({
        run: () => undefined,
        prepare: () => ({ all: () => [], get: () => null, run: () => undefined }),
      }),
    },
  });

  const dbHandleUrl = pathToFileURL(`${repoRoot}/src/tools/sales/_dbHandle.js`).href;
  mock.module(dbHandleUrl, {
    namedExports: {
      getSalesDb: () => ({
        run: () => undefined,
        prepare: () => ({ all: () => [], get: () => null, run: () => undefined }),
      }),
    },
  });

  const reaperUrl = pathToFileURL(`${repoRoot}/src/cli/subcommands/serve/turn/reaper.js`).href;
  mock.module(reaperUrl, {
    namedExports: {
      reapExpiredAutoRun: () => undefined,
    },
  });

  const runOneMod = await import("../../../../src/cli/subcommands/serve/turn/runOne.js");
  runOneTurn = runOneMod.runOneTurn as RunOneTurn;
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

function makeDeps(frames: unknown[]): ServeDeps {
  return {
    model: {},
    system: "sys",
    systemResume: "sysResume",
    tools: {},
    maxSteps: 5,
    auditWriter: async () => undefined,
    session: {
      setTurnAbortSignal: () => undefined,
      clearTurnAbortSignal: () => undefined,
      getClient: () => null,
    },
    schedulePath: "/dev/null",
    salesDbPath: "/dev/null",
    auditPath: "/dev/null",
    expectedToken: Buffer.from("t"),
    workflow: {
      onToolResults: () => ({ abort: false }),
      handleEndpoint: () => ({ status: 200, response: { ok: true } }),
      getState: () => ({ current: null, awaitingApprovalStepId: null }),
    },
    emitFrame: (frame: unknown) => frames.push(frame),
    emitOverlayEvent: () => undefined,
    composeOperatorSystem: () => "operator-system",
  } as unknown as ServeDeps;
}

async function runTurn(frames: unknown[] = []): Promise<void> {
  assert.ok(runOneTurn !== null, "runOneTurn must be imported");
  await runOneTurn(makeState(), makeDeps(frames), {
    turnId: "heartbeat-turn",
    abortController: new AbortController(),
    userPrompt: "go",
    isRetryable: false,
    isCronTurn: false,
  });
}

function withTempHome<T>(fn: () => Promise<T>): Promise<T> {
  const tmpDir = makeTmpDir("frondose-turn-heartbeat-");
  const prevHomeBase = process.env.FRONDOSE_HOME_BASE;
  process.env.FRONDOSE_HOME_BASE = tmpDir;
  return fn().finally(() => {
    if (prevHomeBase === undefined) delete process.env.FRONDOSE_HOME_BASE;
    else process.env.FRONDOSE_HOME_BASE = prevHomeBase;
    cleanupTmpDir(tmpDir);
  });
}

function resetState(): void {
  loopMode = "resolve";
  startSawHeartbeat = false;
  startHeartbeatPath = "";
  progressStats = null;
}

describe("P-AUTO-L3FIX-4 turn heartbeat", () => {
  it("T-AUTO-L3FIX4.1: turn start creates the heartbeat and turn end removes it", async () => {
    // Given: FRONDOSE_HOME_BASE points at an isolated temp home.
    // When: runOneTurn starts and then completes normally.
    // Then: the heartbeat exists during the turn and is removed in teardown.
    resetState();
    await withTempHome(async () => {
      loopMode = "capture-start";
      await runTurn();

      assert.equal(startHeartbeatPath, HEARTBEAT_PATH());
      assert.equal(startSawHeartbeat, true, "heartbeat must exist while runAgentLoopPi is active");
      assert.equal(fs.existsSync(HEARTBEAT_PATH()), false, "heartbeat must be removed after runOneTurn finishes");
    });
  });

  it("T-AUTO-L3FIX4.2: progress bumps heartbeat mtime at most once per five-second window", async () => {
    // Given: fake time and a heartbeat created at turn start.
    // When: one text delta arrives after 5s, followed by rapid text/tool-call progress.
    // Then: the first window bumps mtime and rapid progress in the same window does not bump it again.
    resetState();
    mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
    try {
      await withTempHome(async () => {
        loopMode = "progress-throttle";
        await runTurn();

        assert.ok(progressStats, "progress stats must be captured by the loop stub");
        assert.ok(
          progressStats.afterFirstWindowMtimeMs > progressStats.startMtimeMs,
          "first progress after the throttle window must bump the heartbeat mtime",
        );
        assert.equal(
          progressStats.afterRapidMtimeMs,
          progressStats.afterFirstWindowMtimeMs,
          "rapid text/tool progress inside the same window must not bump mtime again",
        );
        assert.equal(fs.existsSync(HEARTBEAT_PATH()), false, "heartbeat must still be removed at turn end");
      });
    } finally {
      mock.timers.reset();
    }
  });

  it("T-AUTO-L3FIX4.3: heartbeat fs errors on start, progress, and removal never escape the turn", async () => {
    // Given: the configured home has a file where the heartbeat directory tree must be.
    // When: runOneTurn starts, receives progress, and finishes.
    // Then: runOneTurn resolves normally and still emits the final done frame.
    resetState();
    mock.timers.enable({ apis: ["Date", "setInterval"], now: 2_000_000 });
    try {
      await withTempHome(async () => {
        fs.writeFileSync(join(process.env.FRONDOSE_HOME_BASE!, ".frondose"), "not-a-directory", "utf8");
        const frames: unknown[] = [];
        loopMode = "fs-error";
        await assert.doesNotReject(runTurn(frames));

        const done = frames.find((frame): frame is { type: string; finishReason: string } => {
          return typeof frame === "object" && frame !== null && (frame as { type?: unknown }).type === "done";
        });
        assert.equal(done?.finishReason, "stop", "turn must complete normally despite heartbeat fs errors");
      });
    } finally {
      mock.timers.reset();
    }
  });
});
