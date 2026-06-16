/**
 * P-Y3 Step 4a scaffold — createTurnRunner present_summary routing.
 *
 * C-Y3-1 handling: this test mocks runAgentLoop and callInOverlay, then
 * dynamically imports createTurnRunner directly. It avoids runServeSubcommand,
 * UDS bootstrapping, and createLinkedinSession mocking.
 *
 * Expected-red before Step 4b: turn.ts does not route present_summary to
 * window.__frondoseShowSummaryCard(...).
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/cli/subcommands/serve-present-summary-pY3.mock.test.ts
 */

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { ServeDeps, ServeState } from "../../../src/cli/subcommands/serve/context.js";

type CallInOverlayCall = { handle: unknown; contextId: number; functionDeclaration: string };

const overlayCalls: CallInOverlayCall[] = [];
const presentSummaryPayload = {
  ok: true,
  title: "Turn summary",
  summary: "The agent found one relevant lead signal and should keep the next move concise.",
  bullets: ["Relevant role", "No outbound action taken"],
  nextStep: "Ask before sending anything.",
};
const suggestionCardPayload = {
  ok: true,
  title: "Jane Doe - VP Engineering",
  icpMatch: { qualified: true, matched: ["role"], missing: [] },
  painChainHypothesis: "Likely owns engineering scaling decisions.",
};
const nextActionsPayload = {
  ok: true,
  summary: "Choose a low-risk next action.",
  actions: [{ id: "a1", label: "Draft", prompt: "Draft a message" }],
};

let createTurnRunner:
  | ((state: ServeState, deps: ServeDeps) => { runOneTurn: (args: unknown) => Promise<void> })
  | null = null;

before(async () => {
  const loopUrl = pathToFileURL(resolve(process.cwd(), "src/agent/loop.js")).href;
  mock.module(loopUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: mock runAgentLoop captures only the callback contract.
      runAgentLoop: async (opts: any) => {
        await opts.onStepFinish({
          toolCalls: [
            { toolCallId: "tc-present", toolName: "present_summary" },
            { toolCallId: "tc-card", toolName: "suggest_card" },
            { toolCallId: "tc-next", toolName: "suggest_next_actions" },
          ],
          toolResults: [
            { toolCallId: "tc-present", toolName: "present_summary", result: presentSummaryPayload },
            { toolCallId: "tc-card", toolName: "suggest_card", result: suggestionCardPayload },
            { toolCallId: "tc-next", toolName: "suggest_next_actions", result: nextActionsPayload },
          ],
        });
      },
      // [P-PI-followup] Pi loop transitive imports from loop.js — see _loopMockHelper.ts.
      STALL_STEP_THRESHOLD: 4,
      lastAssistantMessageHasNoToolCalls: () => false,
      lastAssistantMessageMissedExecute: () => false,
      narrationContinueMessage: () => ({ role: "user" as const, content: "" }),
      stalledContinueMessage: () => ({ role: "user" as const, content: "" }),
    },
  });

  const injectUrl = pathToFileURL(resolve(process.cwd(), "src/overlay/inject.js")).href;
  mock.module(injectUrl, {
    namedExports: {
      OVERLAY_BOOTSTRAP_JS: "",
      installOverlay: async () => "id-overlay",
      subscribeContextId: async () => () => undefined,
      callInOverlay: async (handle: unknown, contextId: number, functionDeclaration: string) => {
        overlayCalls.push({ handle, contextId, functionDeclaration });
      },
    },
  });

  const turnMod = await import("../../../src/cli/subcommands/serve/turn.js");
  createTurnRunner = turnMod.createTurnRunner as typeof createTurnRunner;
});

function makeState(): ServeState {
  return {
    currentTurn: null,
    overlayContextId: 81,
    unsubscribeContextId: undefined,
    unsubscribeOverlayEvents: undefined,
    cronEnabled: false,
    passiveEnabled: false,
    autoRunId: null,
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
  const fakeClient = { handle: { id: "fake-cdp-handle" } };
  return {
    model: {},
    system: "system",
    systemResume: "system resume",
    tools: {},
    maxSteps: 5,
    auditWriter: async () => undefined,
    session: { getClient: () => fakeClient },
    schedulePath: "/dev/null",
    salesDbPath: "/dev/null",
    auditPath: "/dev/null",
    expectedToken: Buffer.from("token"),
    workflow: {
      onToolResults: () => ({ abort: false }),
      handleEndpoint: () => ({ status: 200, response: { ok: true } }),
      getState: () => ({ current: null, awaitingApprovalStepId: null }),
    },
    emitFrame: (frame: unknown) => frames.push(frame),
    emitOverlayEvent: () => undefined,
  } as unknown as ServeDeps;
}

function parseJsonArgument(call: CallInOverlayCall, fnName: string): unknown {
  const match = call.functionDeclaration.match(new RegExp(`${fnName}\\((.*)\\)`));
  assert.ok(match?.[1], `overlay call must invoke ${fnName}(...)`);
  const jsonString = JSON.parse(match[1]) as string;
  return JSON.parse(jsonString);
}

describe("createTurnRunner — present_summary routes directly to overlay summary card", () => {
  it.skip("T-PY3.Turn.1: synthetic present_summary tool result calls __frondoseShowSummaryCard once, emits no new SSE frame, and leaves existing card/action routing intact", async () => {
    // Given: createTurnRunner loaded after runAgentLoop/callInOverlay mocks and an active overlay context.
    // When: runAgentLoop reports present_summary, suggest_card, and suggest_next_actions results in one step.
    // Then: exactly one summary-card overlay push occurs; no present-summary SSE frame is emitted;
    //       existing suggestion-card and next-actions frames and overlay calls still occur.
    assert.ok(createTurnRunner, "createTurnRunner must be dynamically imported after mocks");
    overlayCalls.length = 0;
    const frames: unknown[] = [];
    const state = makeState();
    const deps = makeDeps(frames);
    const turn = createTurnRunner(state, deps);

    await turn.runOneTurn({
      turnId: "turn-py3",
      abortController: new AbortController(),
      userPrompt: "summarize",
      isRetryable: false,
      isCronTurn: false,
    });

    const frameTypes = frames.map((frame) => (frame as { type?: string }).type);
    assert.equal(frameTypes.includes("present-summary"), false, "overlay-only P-Y3 must not emit present-summary SSE");
    assert.equal(frameTypes.includes("summary-card"), false, "overlay-only P-Y3 must not emit summary-card SSE");

    assert.ok(frameTypes.includes("suggestion-card"), "existing suggest_card SSE routing must remain");
    assert.ok(frameTypes.includes("next-actions"), "existing suggest_next_actions SSE routing must remain");
    assert.equal(
      overlayCalls.some((call) => call.functionDeclaration.includes("__frondoseShowCard")),
      true,
      "existing suggest_card overlay routing must remain",
    );
    assert.equal(
      overlayCalls.some((call) => call.functionDeclaration.includes("__frondoseShowNextActions")),
      true,
      "existing suggest_next_actions overlay routing must remain",
    );

    const summaryCalls = overlayCalls.filter((call) => call.functionDeclaration.includes("__frondoseShowSummaryCard"));
    assert.equal(
      summaryCalls.length,
      1,
      `present_summary must invoke exactly one __frondoseShowSummaryCard overlay call; got ${summaryCalls.length}: ` +
        overlayCalls.map((call) => call.functionDeclaration).join("\n"),
    );
    assert.deepEqual(parseJsonArgument(summaryCalls[0], "__frondoseShowSummaryCard"), presentSummaryPayload);
  });
});
