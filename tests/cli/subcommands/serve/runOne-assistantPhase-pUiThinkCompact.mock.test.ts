/**
 * P-UI-THINK-COMPACT — Step 3a RED: runOneTurn privacy, mapping, and terminals.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/cli/subcommands/serve/runOne-assistantPhase-pUiThinkCompact.mock.test.ts
 */

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { before, beforeEach, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { ServeDeps, ServeState } from "../../../../src/cli/subcommands/serve/context.js";
import type { TurnArgs } from "../../../../src/cli/subcommands/serve/turn/runOne.js";

type Phase = "intermediate" | "final";
type Completion = { finishReason: "stop" | "max_steps" | "aborted" };
type Scenario = "normal" | "max_steps" | "aborted" | "error";
type LoopOpts = {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onAssistantPhaseText?: (text: string, phase: Phase) => void;
  onStepFinish?: (step: { toolCalls: unknown[]; toolResults: unknown[] }) => Promise<void>;
  assistantHistory?: "all" | "final-only";
};
type RunOneTurn = (state: ServeState, deps: ServeDeps, args: TurnArgs) => Promise<void>;

let runOneTurn: RunOneTurn | null = null;
let scenario: Scenario = "normal";
let capturedOpts: LoopOpts | null = null;
let reasoningHeartbeatCount: number | null = null;
const overlayCalls: string[] = [];
const heartbeatBumps: number[] = [];

before(async () => {
  const root = resolve(process.cwd());
  const pathsUrl = pathToFileURL(join(root, "src/persistence/paths.js")).href;
  const actualPaths = await import(pathsUrl);
  mock.module(pathsUrl, {
    namedExports: {
      ...actualPaths,
      writeTurnHeartbeat: () => undefined,
      bumpTurnHeartbeat: (now: number) => heartbeatBumps.push(now),
      removeTurnHeartbeat: () => undefined,
    },
  });
  mock.module(pathToFileURL(join(root, "src/agent/pi/loop.js")).href, {
    namedExports: {
      runAgentLoopPi: async (opts: LoopOpts): Promise<Completion> => {
        capturedOpts = opts;
        opts.onReasoning?.("PRIVATE_REASONING");
        reasoningHeartbeatCount = heartbeatBumps.length;
        opts.onAssistantPhaseText?.("TEMPORARY_ASSISTANT", "intermediate");
        // Behave like real Pi if the legacy callback is accidentally still wired.
        opts.onText?.("TEMPORARY_ASSISTANT");
        await opts.onStepFinish?.({ toolCalls: [{ toolName: "inspect" }], toolResults: [] });
        if (scenario === "error") throw new Error("PROVIDER_FAILURE");
        if (scenario === "max_steps") return { finishReason: "max_steps" };
        if (scenario === "aborted") return { finishReason: "aborted" };
        opts.onAssistantPhaseText?.("Final **answer**. Second block.", "final");
        opts.onText?.("Final **answer**.");
        opts.onText?.(" Second block.");
        return { finishReason: "stop" };
      },
    },
  });
  mock.module(pathToFileURL(join(root, "src/agent/pi/model.js")).href, {
    namedExports: {
      resolvePiModel: () => ({
        model: { id: "deepseek-test" },
        apiKey: "test-key",
        reasoningLevel: "low",
        timeoutMs: 120_000,
      }),
    },
  });
  mock.module(pathToFileURL(join(root, "src/persistence/audit.js")).href, {
    namedExports: { writeLlmErrorAudit: () => undefined },
  });
  mock.module(pathToFileURL(join(root, "src/overlay/inject.js")).href, {
    namedExports: {
      callInOverlay: async (_handle: unknown, _contextId: number, source: string) => {
        overlayCalls.push(source);
      },
    },
  });
  const mod = await import("../../../../src/cli/subcommands/serve/turn/runOne.js");
  runOneTurn = mod.runOneTurn as RunOneTurn;
});

beforeEach(() => {
  scenario = "normal";
  capturedOpts = null;
  reasoningHeartbeatCount = null;
  overlayCalls.length = 0;
  heartbeatBumps.length = 0;
});

function state(): ServeState {
  return {
    currentTurn: null,
    overlayContextId: 7,
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

function deps(frames: unknown[]): ServeDeps {
  return {
    model: {},
    system: "system",
    systemResume: "resume",
    tools: {},
    maxSteps: 5,
    auditWriter: async () => undefined,
    session: {
      setTurnAbortSignal: () => undefined,
      clearTurnAbortSignal: () => undefined,
      getClient: () => ({ handle: {} }),
    },
    schedulePath: "/dev/null",
    salesDbPath: "/dev/null",
    auditPath: "/dev/null",
    expectedToken: Buffer.from("test"),
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

async function execute(turnId: string): Promise<{ frames: unknown[]; turnState: ServeState }> {
  assert.ok(runOneTurn, "real runOneTurn must import");
  const frames: unknown[] = [];
  const turnState = state();
  await runOneTurn(turnState, deps(frames), {
    turnId,
    abortController: new AbortController(),
    userPrompt: "go",
    isRetryable: false,
  });
  return { frames, turnState };
}

describe("runOneTurn exposes classified assistant text without reasoning or duplicates", () => {
  it("T-Serve.1/2: only progress and one final cross serve; app history mode is final-only", async () => {
    // Given a Pi mock that fires both new and legacy callbacks, when runOneTurn maps it, then legacy is unwired and private content never leaks.
    const turnId = "turn-normal";
    const { frames, turnState } = await execute(turnId);
    assert.equal(
      capturedOpts?.onReasoning === undefined,
      false,
      "reasoning must retain its private heartbeat callback",
    );
    assert.equal(reasoningHeartbeatCount, 1, "reasoning must refresh the heartbeat before any other progress hook");
    const serialized = JSON.stringify(frames);
    assert.doesNotMatch(serialized, /PRIVATE_REASONING/);
    assert.doesNotMatch(
      JSON.stringify(turnState.messages),
      /PRIVATE_REASONING/,
      "private reasoning must not enter the real serve-owned post-turn history",
    );
    assert.deepEqual(
      turnState.messages,
      [],
      "the mocked Pi loop must not synthesize serve history outside Pi ownership",
    );
    assert.equal(frames.filter((frame) => (frame as { type?: string }).type === "reasoning").length, 0);
    assert.deepEqual(
      frames.filter((frame) =>
        ["assistant-progress", "text", "done"].includes((frame as { type?: string }).type ?? ""),
      ),
      [
        { type: "assistant-progress", turnId, text: "TEMPORARY_ASSISTANT" },
        { type: "text", turnId, chunk: "Final **answer**. Second block." },
        { type: "done", turnId, finishReason: "stop", aborted: false },
      ],
    );
    assert.equal(capturedOpts?.onText, undefined, "serve must not retain the duplicate legacy callback");
    assert.equal(capturedOpts?.assistantHistory, "final-only");
    const overlay = overlayCalls.join("\n");
    assert.doesNotMatch(overlay, /PRIVATE_REASONING|TEMPORARY_ASSISTANT/);
    assert.equal((overlay.match(/Final \*\*answer\*\*\. Second block\./g) ?? []).length, 1);
  });
});

describe("runOneTurn preserves distinct terminal outcomes after visible progress", () => {
  it("T-Serve.3: max-step clears via a distinct done and has no final text", async () => {
    // Given progress followed by Pi cap exhaustion, when the turn ends, then max_steps is explicit and no final text is fabricated.
    scenario = "max_steps";
    const { frames } = await execute("turn-max");
    assert.deepEqual(
      frames.filter((frame) =>
        ["assistant-progress", "text", "done"].includes((frame as { type?: string }).type ?? ""),
      ),
      [
        { type: "assistant-progress", turnId: "turn-max", text: "TEMPORARY_ASSISTANT" },
        { type: "done", turnId: "turn-max", finishReason: "max_steps", aborted: false },
      ],
    );
  });

  it("T-Serve.3: settled abort emits aborted done and has no final text", async () => {
    // Given progress followed by an aborted Pi result, when the turn ends, then the done frame is owned and explicitly aborted.
    scenario = "aborted";
    const { frames } = await execute("turn-abort");
    assert.deepEqual(
      frames.filter((frame) =>
        ["assistant-progress", "text", "done"].includes((frame as { type?: string }).type ?? ""),
      ),
      [
        { type: "assistant-progress", turnId: "turn-abort", text: "TEMPORARY_ASSISTANT" },
        { type: "done", turnId: "turn-abort", finishReason: "aborted", aborted: true },
      ],
    );
  });

  it("T-Serve.3: provider error after progress emits error without final text", async () => {
    // Given progress followed by a provider throw, when runOneTurn catches it, then only the owned error terminates presentation.
    scenario = "error";
    const { frames } = await execute("turn-error");
    assert.deepEqual(
      frames.filter((frame) =>
        ["assistant-progress", "text", "done", "error"].includes((frame as { type?: string }).type ?? ""),
      ),
      [
        { type: "assistant-progress", turnId: "turn-error", text: "TEMPORARY_ASSISTANT" },
        { type: "error", turnId: "turn-error", message: "PROVIDER_FAILURE", retryable: false },
      ],
    );
  });
});
