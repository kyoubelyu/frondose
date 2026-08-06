/**
 * P-UI-THINK-COMPACT — provider reasoning remains private at the serve boundary.
 *
 * Behavior under test: runOneTurn keeps onReasoning for heartbeat progress, but reasoning bytes
 * never become SSE frames or caller-owned history.
 *
 * Harness mirrors runOne-autoRunCompleted-pWLC.mock.test.ts (mocks the Pi loop, model, audit, overlay).
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/cli/subcommands/serve/runOne-reasoning-pThink.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { before, beforeEach, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { ServeDeps, ServeState } from "../../../../src/app/backend/context.js";
import type { TurnArgs } from "../../../../src/app/backend/turn/runOne.js";

type LoopOpts = {
  abortSignal?: AbortSignal;
  onReasoning?: (delta: string) => void;
  onText?: (delta: string) => void;
  onStepFinish?: (step: { toolCalls: unknown[]; toolResults: unknown[] }) => Promise<void>;
};
type RunOneTurn = (state: ServeState, deps: ServeDeps, args: TurnArgs) => Promise<void>;

// Reasoning deltas the mocked loop emits for the current turn.
let reasoningDeltas: string[] = [];
let runOneTurn: RunOneTurn | null = null;

before(async () => {
  const repoRoot = resolve(process.cwd());
  const piLoopUrl = pathToFileURL(join(repoRoot, "src/agent/pi/loop.js")).href;
  mock.module(piLoopUrl, {
    namedExports: {
      runAgentLoopPi: async (opts: LoopOpts) => {
        for (const d of reasoningDeltas) opts.onReasoning?.(d);
        await opts.onStepFinish?.({ toolCalls: [], toolResults: [] });
        return { finishReason: "stop" };
      },
    },
  });

  const piModelUrl = pathToFileURL(join(repoRoot, "src/agent/pi/model.js")).href;
  mock.module(piModelUrl, {
    namedExports: {
      resolvePiModel: () => ({
        model: { id: "deepseek-test" },
        apiKey: "test-key",
        reasoningLevel: "low",
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
});

beforeEach(() => {
  reasoningDeltas = [];
});

function makeState(): ServeState {
  return {
    currentTurn: null,
    overlayContextId: undefined,
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
  } as unknown as ServeState;
}

function makeDeps(frames: unknown[]): ServeDeps {
  return {
    model: {},
    system: "system",
    systemResume: "resume-system",
    tools: {},
    maxSteps: 5,
    auditWriter: async () => undefined,
    session: { setTurnAbortSignal: () => undefined, clearTurnAbortSignal: () => undefined, getClient: () => null },
    schedulePath: "/dev/null",
    salesDbPath: "/dev/null",
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

async function runTurn(frames: unknown[], turnId: string): Promise<ServeState> {
  assert.ok(runOneTurn !== null, "runOneTurn imported");
  const state = makeState();
  await runOneTurn(state, makeDeps(frames), {
    turnId,
    abortController: new AbortController(),
    userPrompt: "go",
    isRetryable: false,
  } as unknown as TurnArgs);
  return state;
}

describe("P-UI-THINK-COMPACT — runOneTurn keeps provider reasoning private", () => {
  it("T-ServeReasoning.1: reasoning deltas produce no public frame or history bytes", async () => {
    // Given private reasoning deltas, when runOneTurn completes, then neither SSE nor history exposes them.
    reasoningDeltas = ["Let me ", "think..."];
    const frames: unknown[] = [];
    const turnId = randomUUID();
    const state = await runTurn(frames, turnId);
    assert.equal(
      frames.some((frame) => JSON.stringify(frame).includes("Let me")),
      false,
    );
    assert.equal(
      frames.some((frame) => JSON.stringify(frame).includes("think...")),
      false,
    );
    assert.equal(JSON.stringify(state.messages).includes("Let me"), false);
    assert.equal(JSON.stringify(state.messages).includes("think..."), false);
    assert.equal(
      frames.some((frame) => (frame as { type?: string }).type === "reasoning"),
      false,
    );
  });

  it("T-ServeReasoning.2: a turn without reasoning still emits the normal terminal", async () => {
    // Given no reasoning deltas, when runOneTurn completes, then the ordinary done frame remains.
    reasoningDeltas = [];
    const frames: unknown[] = [];
    await runTurn(frames, randomUUID());
    assert.equal(
      frames.some((frame) => (frame as { type?: string }).type === "reasoning"),
      false,
    );
    assert.equal(
      frames.some((frame) => (frame as { type?: string }).type === "done"),
      true,
    );
  });
});
