/**
 * P-AUTO-ISOLATE Step 2 — Test Scaffold — manual-turn path regression guard.
 *
 * Covers (plan §5): T-Iso.5.
 *
 * Per outside-in TDD + BDD-light: the assertion body is
 * `assert.fail("TODO Step 5: …")` — RED at Step 2/3/4a, even though this is a
 * pure regression guard on code this phase does NOT change (plan §2 non-goals:
 * "Changing manual-turn state.messages behavior" is explicitly OUT of scope —
 * `handlePostAgentTurn` (routes/agent.ts:54) keeps pushing to state.messages).
 * Filled for real at Step 5 uniformly with the rest of the suite.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/cli/subcommands/serve/agentTurnManualIso-pAutoIsolate.mock.test.ts
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it } from "node:test";
import type { ServeDeps, ServeState } from "../../../../src/app/backend/context.js";
import { handlePostAgentTurn } from "../../../../src/app/backend/routes/agent.js";
import type { createTurnRunner } from "../../../../src/app/backend/turn.js";

class MockServerResponse extends EventEmitter {
  statusCode = 200;
  body = "";
  ended = false;
  writeHead(status: number): this {
    this.statusCode = status;
    return this;
  }
  write(): boolean {
    return true;
  }
  end(payload?: string): void {
    if (payload) this.body = payload;
    this.ended = true;
  }
}

class MockIncomingMessage extends EventEmitter {
  headers: Record<string, string> = {};
  method = "POST";
  url = "/agent/turn";
  private _bodyChunks: Buffer[];
  constructor(body: unknown) {
    super();
    this._bodyChunks = [Buffer.from(JSON.stringify(body))];
  }
  [Symbol.asyncIterator]() {
    let i = 0;
    const chunks = this._bodyChunks;
    return {
      next() {
        if (i < chunks.length) return Promise.resolve({ value: chunks[i++], done: false as const });
        return Promise.resolve({ value: undefined as never, done: true as const });
      },
    };
  }
}

function makeState(): ServeState {
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
      getState: () => ({ current: null, awaitingApprovalStepId: null }),
    },
    emitFrame: () => undefined,
    emitOverlayEvent: () => undefined,
    composeOperatorSystem: () => "operator-system",
  } as unknown as ServeDeps;
}

function makeTurnStub(): ReturnType<typeof createTurnRunner> {
  return {
    runOneTurn: () => Promise.resolve(),
    triggerAnalyzeProfile: () => Promise.resolve(),
    resumeWorkflowTurn: () => Promise.resolve(),
  } as unknown as ReturnType<typeof createTurnRunner>;
}

describe("handlePostAgentTurn — manual-turn path keeps pushing to state.messages (T-Iso.5, regression guard on the OUT-OF-SCOPE manual path per plan §2)", () => {
  it("T-Iso.5: given the operator invokes POST /agent/turn, then state.messages receives the pushed user message — manual chat continuity is UNCHANGED by this phase", async () => {
    // Given: state.messages=[]; a POST /agent/turn body {prompt:'hello manual'}
    // When:  handlePostAgentTurn(state, deps, turn, req, res) runs
    // Then:  state.messages contains a pushed {role:'user', content:'hello manual'} entry —
    //        this is a REGRESSION GUARD; plan §2 explicitly keeps manual-turn behavior
    //        untouched, so this SHOULD already pass once real assertions land at Step 5
    const state = makeState();
    const deps = makeDeps();
    const turn = makeTurnStub();
    const req = new MockIncomingMessage({ prompt: "hello manual" });
    const res = new MockServerResponse();

    await handlePostAgentTurn(state, deps, turn, req as unknown as IncomingMessage, res as unknown as ServerResponse);

    const pushed = state.messages.some(
      (m) => (m as { role?: string }).role === "user" && (m as { content?: unknown }).content === "hello manual",
    );

    assert.equal(
      pushed,
      true,
      "manual-turn path must still push {role:'user',content:'hello manual'} into state.messages (out of scope for this phase)",
    );
  });
});
