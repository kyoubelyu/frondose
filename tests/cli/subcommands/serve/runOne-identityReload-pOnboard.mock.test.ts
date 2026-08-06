/**
 * Phase P-ONBOARD-CONVERSATIONAL-IDENTITY — BE mock tests.
 *
 * Behavior under test: a tool-driven `identity` write (the onboarding conversation commits
 * via the existing `identity` tool, same as any later correction) must recompose the
 * in-memory system-prompt deps (`deps.system`/`deps.systemResume`/`deps.composeOperatorSystem`)
 * for the NEXT turn — otherwise the Soul band keeps showing the pre-onboarding placeholder
 * identity sentence for the rest of the running session, and the onboarding directive
 * (conditional on identity===null, see soul.test.ts T-Onboard.Soul.1/.2) never retires. This
 * mirrors P-FIX-ICP-STALE-CACHE's fix shape one level up: the Settings-save HTTP route
 * already calls `reloadAgentDeps()` on every save; a tool-driven write never did.
 *
 * Harness mirrors runOne-autoRunCompleted-pWLC.mock.test.ts (mocks the Pi loop, model,
 * audit, overlay; also mocks ../settings.js's reloadAgentDeps to record calls instead of
 * doing real config I/O — this test asserts the CALL happens, not what it computes).
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/cli/subcommands/serve/runOne-identityReload-pOnboard.mock.test.ts
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
  onStepFinish?: (step: { toolCalls: unknown[]; toolResults: unknown[] }) => Promise<void>;
};
type RunOneTurn = (state: ServeState, deps: ServeDeps, args: TurnArgs) => Promise<void>;

let stepToolResults: unknown[] = [];
let reloadCalls: unknown[] = [];
let runOneTurn: RunOneTurn | null = null;

before(async () => {
  const repoRoot = resolve(process.cwd());

  const piLoopUrl = pathToFileURL(join(repoRoot, "src/agent/pi/loop.js")).href;
  mock.module(piLoopUrl, {
    namedExports: {
      runAgentLoopPi: async (opts: LoopOpts) => {
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

  // P-ONBOARD-CONVERSATIONAL-IDENTITY: mock the recompose hook itself — this test asserts
  // runOne.ts CALLS it on a successful identity write, not what it computes (that's
  // reloadAgentDeps's own existing test coverage from P-FIX-ICP-STALE-CACHE / earlier).
  const settingsUrl = pathToFileURL(join(repoRoot, "src/app/backend/settings.js")).href;
  mock.module(settingsUrl, {
    namedExports: {
      reloadAgentDeps: (deps: unknown) => {
        reloadCalls.push(deps);
        return { restartRequired: false };
      },
    },
  });

  const runOneMod = await import("../../../../src/app/backend/turn/runOne.js");
  runOneTurn = runOneMod.runOneTurn as RunOneTurn;
});

beforeEach(() => {
  stepToolResults = [];
  reloadCalls = [];
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

function makeDeps(): ServeDeps {
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
    emitFrame: () => undefined,
    emitOverlayEvent: () => undefined,
    composeOperatorSystem: () => "operator-system",
  } as unknown as ServeDeps;
}

async function runTurn(state: ServeState, deps: ServeDeps): Promise<void> {
  assert.ok(runOneTurn !== null, "runOneTurn imported");
  await runOneTurn(state, deps, {
    turnId: randomUUID(),
    abortController: new AbortController(),
    userPrompt: "hi",
    isRetryable: false,
    isCronTurn: false,
  });
}

describe("P-ONBOARD-CONVERSATIONAL-IDENTITY — runOneTurn recomposes system-prompt deps on a tool-driven identity write", () => {
  it("T-Onboard.Reload.1: a step whose toolResults include a successful `identity` call triggers reloadAgentDeps(deps) exactly once", async () => {
    // Given: the agent's step reports a successful identity-tool write (ok:true)
    // When:  runOneTurn's onStepFinish observes it
    // Then:  reloadAgentDeps is called exactly once, with this turn's deps
    const state = makeState();
    const deps = makeDeps();
    stepToolResults = [{ toolName: "identity", result: { ok: true, command: "identity", data: {} } }];

    await runTurn(state, deps);

    assert.equal(reloadCalls.length, 1, "reloadAgentDeps must be called exactly once");
    assert.equal(reloadCalls[0], deps, "reloadAgentDeps must be called with this turn's deps");
  });

  it("T-Onboard.Reload.2: a failed `identity` call (ok:false) does NOT trigger reloadAgentDeps", async () => {
    // Given: the agent's step reports a FAILED identity-tool write
    // When:  runOneTurn's onStepFinish observes it
    // Then:  reloadAgentDeps is not called (nothing durable changed to recompose from)
    const state = makeState();
    const deps = makeDeps();
    stepToolResults = [{ toolName: "identity", result: { ok: false, command: "identity", error: "bad input" } }];

    await runTurn(state, deps);

    assert.equal(reloadCalls.length, 0, "reloadAgentDeps must NOT be called on a failed identity write");
  });

  it("T-Onboard.Reload.3: an unrelated tool result does NOT trigger reloadAgentDeps", async () => {
    // Given: the agent's step reports an unrelated tool result (no identity write occurred)
    // When:  runOneTurn's onStepFinish observes it
    // Then:  reloadAgentDeps is not called
    const state = makeState();
    const deps = makeDeps();
    stepToolResults = [{ toolName: "score_lead", result: { ok: true, command: "score_lead", data: {} } }];

    await runTurn(state, deps);

    assert.equal(reloadCalls.length, 0, "reloadAgentDeps must NOT be called for a non-identity tool result");
  });

  it("T-Onboard.Reload.4: two successful `identity` results in the SAME step trigger reloadAgentDeps exactly once (dedup — Step-3 Codex critic CONCERN)", async () => {
    // Given: the agent's step reports TWO successful identity-tool writes (e.g. a parallel
    //        tool-call round)
    // When:  runOneTurn's onStepFinish observes both
    // Then:  reloadAgentDeps is still called exactly once (not twice) for this step
    const state = makeState();
    const deps = makeDeps();
    stepToolResults = [
      { toolName: "identity", result: { ok: true, command: "identity", data: {} } },
      { toolName: "identity", result: { ok: true, command: "identity", data: {} } },
    ];

    await runTurn(state, deps);

    assert.equal(
      reloadCalls.length,
      1,
      "reloadAgentDeps must be called exactly once even with 2 identity results in one step",
    );
  });
});
