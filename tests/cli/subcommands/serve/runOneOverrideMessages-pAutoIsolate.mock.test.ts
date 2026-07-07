/**
 * P-AUTO-ISOLATE Step 2 — Test Scaffold — runOne.ts `overrideMessages` selection
 * + the `stop_auto` post-step hook.
 *
 * Covers (plan §5): T-Iso.3, T-StopAuto.3, T-StopAuto.6 (ADDED at Step 3a — plan §10.3).
 *
 * Per outside-in TDD + BDD-light: ALL assertion bodies are
 * `assert.fail("TODO Step 5: …")` — this whole file is RED at Step 2/3/4a.
 * Validator fills real assertions at Step 5 once Codex's Step 4b lands:
 *   - `TurnArgs.overrideMessages?: CoreMessage[]` (plan §6.4)
 *   - `messages: args.overrideMessages ?? state.messages` at runOne.ts:172
 *   - a `tr.toolName === "stop_auto"` branch alongside the existing
 *     `end_auto_run` branch (runOne.ts ~:209) per plan §6.4.
 *
 * Harness mirrors tests/cli/subcommands/serve/runOne-autoRunCompleted-pWLC.mock.test.ts:
 * `mock.module()` stubs runAgentLoopPi to capture `opts` + drive `onStepFinish`
 * with injected toolResults, against a REAL runOneTurn + REAL persistence.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/cli/subcommands/serve/runOneOverrideMessages-pAutoIsolate.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { before, beforeEach, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { ServeDeps, ServeState } from "../../../../src/cli/subcommands/serve/context.js";
import type { TurnArgs } from "../../../../src/cli/subcommands/serve/turn/runOne.js";

type LoopOpts = {
  messages?: unknown[];
  abortSignal?: AbortSignal;
  onStepFinish?: (step: { toolCalls: unknown[]; toolResults: unknown[] }) => Promise<void>;
};
type RunOneTurn = (state: ServeState, deps: ServeDeps, args: TurnArgs) => Promise<void>;

let stepToolResults: unknown[] = [];
let capturedLoopOpts: LoopOpts | null = null;

let runOneTurn: RunOneTurn | null = null;

before(async () => {
  const repoRoot = resolve(process.cwd());
  const piLoopUrl = pathToFileURL(resolve(repoRoot, "src/agent/pi/loop.js")).href;
  mock.module(piLoopUrl, {
    namedExports: {
      runAgentLoopPi: async (opts: LoopOpts) => {
        capturedLoopOpts = opts;
        await opts.onStepFinish?.({ toolCalls: [], toolResults: stepToolResults });
      },
    },
  });

  const piModelUrl = pathToFileURL(resolve(repoRoot, "src/agent/pi/model.js")).href;
  mock.module(piModelUrl, {
    namedExports: {
      resolvePiModel: () => ({ model: { id: "deepseek-test" }, apiKey: "test-key", onPayload: (p: unknown) => p, timeoutMs: 120_000 }),
    },
  });

  const auditUrl = pathToFileURL(resolve(repoRoot, "src/persistence/audit.js")).href;
  mock.module(auditUrl, { namedExports: { writeLlmErrorAudit: () => undefined } });

  const injectUrl = pathToFileURL(resolve(repoRoot, "src/overlay/inject.js")).href;
  mock.module(injectUrl, { namedExports: { callInOverlay: async () => undefined } });

  const runOneMod = await import("../../../../src/cli/subcommands/serve/turn/runOne.js");
  runOneTurn = runOneMod.runOneTurn as RunOneTurn;
});

beforeEach(() => {
  stepToolResults = [];
  capturedLoopOpts = null;
});

function makeState(overrides: Partial<ServeState> = {}): ServeState {
  return {
    currentTurn: null,
    overlayContextId: undefined,
    unsubscribeContextId: undefined,
    unsubscribeOverlayEvents: undefined,
    cronEnabled: true,
    passiveEnabled: false,
    autoRunId: null,
    autoSessionId: "session-under-test", // P-AUTO-ISOLATE: additive field, not yet on ServeState at Step 2
    lastEmittedAutoCounters: null,
    lastTurnUserPrompt: null,
    lastFailedTurnPrompt: null,
    retryAttempts: 0,
    messages: [{ role: "user", content: "Y — the pre-existing shared conversation" }],
    passiveProfileCache: new Map(),
    passiveLimiter: { check: () => ({ ok: true }) },
    sseClients: new Set(),
    ...overrides,
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

async function runTurn(state: ServeState, deps: ServeDeps, args: Partial<TurnArgs> = {}): Promise<void> {
  assert.ok(runOneTurn !== null, "runOneTurn imported");
  await runOneTurn(state, deps, {
    turnId: args.turnId ?? randomUUID(),
    abortController: args.abortController ?? new AbortController(),
    userPrompt: args.userPrompt ?? "go",
    isRetryable: false,
    isCronTurn: args.isCronTurn ?? true,
    maxSteps: args.maxSteps,
    // biome-ignore lint/suspicious/noExplicitAny: overrideMessages not yet on TurnArgs at Step 2
    ...(args as any),
  });
}

// ─── T-Iso.3 — runOne selects overrideMessages over state.messages ──────────

describe("runOneTurn — selects args.overrideMessages over state.messages when present (T-Iso.3, LOCKED-1)", () => {
  it("T-Iso.3: given TurnArgs.overrideMessages=[{role:'user',content:'X'}] and state.messages=[{role:'user',content:'Y'}], when runOneTurn calls runAgentLoopPi, then opts.messages===args.overrideMessages (identity) and opts.messages does NOT contain 'Y'", async () => {
    // Given: state.messages carries the pre-existing shared conversation ("Y");
    //        args.overrideMessages carries a fresh single-message array ("X")
    // When:  runOneTurn(state, deps, args) runs (mocked runAgentLoopPi captures opts)
    // Then:  opts.messages === args.overrideMessages (same reference) and does NOT
    //        contain "Y" anywhere — runOne.ts:172 must become
    //        `messages: args.overrideMessages ?? state.messages`
    const frames: unknown[] = [];
    const state = makeState();
    const deps = makeDeps(frames);
    const overrideMessages = [{ role: "user" as const, content: "X" }];

    // biome-ignore lint/suspicious/noExplicitAny: overrideMessages not yet on TurnArgs at Step 2
    await runTurn(state, deps, { overrideMessages } as any);

    const opts = capturedLoopOpts;
    const optsMessages = opts?.messages;
    const identityMatch = optsMessages === (overrideMessages as unknown[]);
    const containsY = JSON.stringify(optsMessages ?? null).includes("Y — the pre-existing shared conversation");

    assert.fail(
      `TODO Step 5: assert identityMatch===true (opts.messages === args.overrideMessages) AND ` +
        `containsY===false; currently identityMatch=${identityMatch}, containsY=${containsY}, ` +
        `optsMessages=${JSON.stringify(optsMessages)} (runOne.ts:172 still reads state.messages unconditionally at Step 2)`,
    );
  });
});

// ─── T-StopAuto.3 — runOne detects stop_auto in step results ────────────────

describe("runOneTurn — the stop_auto post-step hook disables cronEnabled + clears autoSessionId + emits SSE (T-StopAuto.3, LOCKED-3)", () => {
  it("T-StopAuto.3: given a stubbed step result containing toolResults:[{toolName:'stop_auto', result:{ok:true, data:{sessionsDisabled:1}}}], when runOne's onStepFinish handler processes it, then state.cronEnabled===false, state.autoSessionId===null, and emitFrame received exactly one auto-session-completed{reason:'stop_auto'} frame AND one cron-mode{cronEnabled:false} frame", async () => {
    // Given: state.cronEnabled=true, state.autoSessionId='session-under-test' (pre-condition);
    //        the mocked loop reports a stop_auto toolResult on its one step
    // When:  runOneTurn processes onStepFinish (mirrors the existing end_auto_run branch at
    //        runOne.ts ~:209 — plan §6.4 adds a parallel tr.toolName==='stop_auto' branch)
    // Then:  state.cronEnabled===false; state.autoSessionId===null; exactly one
    //        {type:'auto-session-completed', reason:'stop_auto'} frame AND one
    //        {type:'cron-mode', cronEnabled:false} frame were emitted
    const frames: unknown[] = [];
    const state = makeState({ cronEnabled: true, autoSessionId: "session-under-test" } as unknown as Partial<ServeState>);
    const deps = makeDeps(frames);
    stepToolResults = [
      { toolName: "stop_auto", result: { ok: true, command: "stop_auto", data: { sessionsDisabled: 1, summary: null } } },
    ];

    await runTurn(state, deps, { isCronTurn: true });

    const autoSessionCompleted = frames.filter(
      (f) => typeof f === "object" && f !== null && (f as { type?: unknown }).type === "auto-session-completed",
    );
    const cronModeOff = frames.filter(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        (f as { type?: unknown }).type === "cron-mode" &&
        (f as { cronEnabled?: unknown }).cronEnabled === false,
    );

    assert.fail(
      `TODO Step 5: assert state.cronEnabled===false (currently ${(state as unknown as { cronEnabled: boolean }).cronEnabled}), ` +
        `state.autoSessionId===null (currently ${JSON.stringify((state as unknown as { autoSessionId: unknown }).autoSessionId)}), ` +
        `autoSessionCompleted.length===1 with reason:'stop_auto' (currently ${JSON.stringify(autoSessionCompleted)}), ` +
        `cronModeOff.length===1 (currently ${JSON.stringify(cronModeOff)}) — runOne.ts has no stop_auto branch yet at Step 2. ` +
        "ALSO assert emitFrame calls order: the auto-session-completed frame's array index is BEFORE the " +
        "cron-mode{cronEnabled:false} frame's array index (canonical SSE order per plan §10.4/§4.5) — " +
        `currently completedIdx=${frames.findIndex((f) => typeof f === "object" && f !== null && (f as { type?: unknown }).type === "auto-session-completed")}, ` +
        `cronModeIdx=${frames.findIndex((f) => typeof f === "object" && f !== null && (f as { type?: unknown }).type === "cron-mode" && (f as { cronEnabled?: unknown }).cronEnabled === false)}`,
    );
  });
});

// ─── T-StopAuto.6 — stop_auto returning ok:false does NOT complete the session ─
// (ADDED at Step 3a, NEGATIVE case — plan §10.3, §6.4, §4.5.)

describe("runOneTurn — the stop_auto post-step hook is a no-op when the tool envelope is ok:false (T-StopAuto.6, LOCKED-3, NEGATIVE)", () => {
  it("T-StopAuto.6: given state.cronEnabled===true and state.autoSessionId==='s-1', when a stubbed step result carries toolResults:[{toolName:'stop_auto', result:{ok:false, error:{...}}}], then state.cronEnabled UNCHANGED (true), state.autoSessionId UNCHANGED ('s-1'), and emitFrame received ZERO auto-session-completed AND ZERO cron-mode frames from this branch", async () => {
    // Given: state.cronEnabled=true, state.autoSessionId='s-1' (pre-condition); the mocked
    //        loop reports a stop_auto toolResult whose envelope is {ok:false, error:{...}}
    //        (e.g. writeSchedule threw — plan §10.3's motivating failure mode)
    // When:  runOneTurn processes onStepFinish (the tr.toolName==='stop_auto' branch per
    //        plan §6.4, gated on `tr.result.ok === true`)
    // Then:  state.cronEnabled stays true (schedule was never actually disabled — cron
    //        MUST keep firing); state.autoSessionId stays 's-1'; NO auto-session-completed
    //        frame and NO cron-mode frame are emitted from this branch (emitting either
    //        would desync the FE — "completed" when nothing was actually disabled). The
    //        tool's error envelope is surfaced to the LLM through the normal tool-result
    //        channel; the LLM can retry stop_auto on a later step.
    const frames: unknown[] = [];
    const state = makeState({ cronEnabled: true, autoSessionId: "s-1" } as unknown as Partial<ServeState>);
    const deps = makeDeps(frames);
    stepToolResults = [
      {
        toolName: "stop_auto",
        result: { ok: false, error: { kind: "envelope_error", message: "writeSchedule failed" } },
      },
    ];

    await runTurn(state, deps, { isCronTurn: true });

    const autoSessionCompleted = frames.filter(
      (f) => typeof f === "object" && f !== null && (f as { type?: unknown }).type === "auto-session-completed",
    );
    const cronModeFrames = frames.filter(
      (f) => typeof f === "object" && f !== null && (f as { type?: unknown }).type === "cron-mode",
    );

    assert.fail(
      `TODO Step 5: assert state.cronEnabled===true UNCHANGED (currently ${(state as unknown as { cronEnabled: boolean }).cronEnabled}), ` +
        `state.autoSessionId==='s-1' UNCHANGED (currently ${JSON.stringify((state as unknown as { autoSessionId: unknown }).autoSessionId)}), ` +
        `autoSessionCompleted.length===0 (currently ${JSON.stringify(autoSessionCompleted)}), ` +
        `cronModeFrames.length===0 (currently ${JSON.stringify(cronModeFrames)}) — runOne.ts has no ok:false-gating on the ` +
        "stop_auto branch yet at Step 2/3a",
    );
  });
});
