/**
 * P-THINK — BE serve mock test: runOneTurn wires onReasoning → a `reasoning` SSE frame.
 *
 * Behavior under test: the operator/interactive turn path passes an onReasoning sink into the Pi
 * loop that emits exactly one `{ type: "reasoning", turnId, chunk }` SSE frame per reasoning delta,
 * so the Tauri app can render the gray live-thinking block. (The overlay is not a target here.)
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
import type { ServeDeps, ServeState } from "../../../../src/cli/subcommands/serve/context.js";
import type { TurnArgs } from "../../../../src/cli/subcommands/serve/turn/runOne.js";

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
      },
    },
  });

  const piModelUrl = pathToFileURL(join(repoRoot, "src/agent/pi/model.js")).href;
  mock.module(piModelUrl, {
    namedExports: {
      resolvePiModel: () => ({ model: { id: "deepseek-test" }, apiKey: "test-key", reasoningLevel: "low", timeoutMs: 120_000 }),
    },
  });

  const auditUrl = pathToFileURL(join(repoRoot, "src/persistence/audit.js")).href;
  mock.module(auditUrl, { namedExports: { writeLlmErrorAudit: () => undefined } });

  const injectUrl = pathToFileURL(join(repoRoot, "src/overlay/inject.js")).href;
  mock.module(injectUrl, { namedExports: { callInOverlay: async () => undefined } });

  const runOneMod = await import("../../../../src/cli/subcommands/serve/turn/runOne.js");
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
    session: { setTurnAbortSignal: () => undefined, getClient: () => null },
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

type ReasoningFrame = { type: string; turnId?: string; chunk?: string };
function reasoningFrames(frames: unknown[]): ReasoningFrame[] {
  return frames.filter(
    (f): f is ReasoningFrame => typeof f === "object" && f !== null && (f as { type?: unknown }).type === "reasoning",
  );
}

async function runTurn(frames: unknown[], turnId: string): Promise<void> {
  assert.ok(runOneTurn !== null, "runOneTurn imported");
  await runOneTurn(makeState(), makeDeps(frames), {
    turnId,
    abortController: new AbortController(),
    userPrompt: "go",
    isRetryable: false,
  } as unknown as TurnArgs);
}

describe("P-THINK — runOneTurn emits reasoning SSE frames", () => {
  it("T-ServeReasoning.1: each onReasoning delta emits one reasoning frame with the turnId + chunk", async () => {
    // Given: the loop emits two reasoning deltas for this turn.
    // When: runOneTurn runs the operator turn.
    // Then: two reasoning frames are emitted, in order, tagged with the turnId and delta text.
    reasoningDeltas = ["Let me ", "think..."];
    const frames: unknown[] = [];
    const turnId = randomUUID();
    await runTurn(frames, turnId);

    const rf = reasoningFrames(frames);
    assert.equal(rf.length, 2, "one reasoning frame per delta");
    assert.deepEqual(rf.map((f) => f.chunk), ["Let me ", "think..."]);
    assert.ok(rf.every((f) => f.turnId === turnId), "each reasoning frame carries the turnId");
  });

  it("T-ServeReasoning.2: a turn with no reasoning deltas emits no reasoning frames", async () => {
    // Given: the loop emits zero reasoning deltas.
    // When: runOneTurn runs.
    // Then: no reasoning frames are emitted (thinking is optional).
    reasoningDeltas = [];
    const frames: unknown[] = [];
    await runTurn(frames, randomUUID());
    assert.equal(reasoningFrames(frames).length, 0);
  });
});
