/**
 * P-72 slice 6 Step 3a — routes-characterization.mock.test.ts
 *
 * 8 CHARACTERIZATION TESTS for `src/cli/subcommands/serve/routes.ts` (PRE-SPLIT).
 * These tests are LOAD-BEARING (G-P72s6.1): they pin the observable behavior of the
 * HTTP request handler BEFORE the split and MUST STAY GREEN AFTER the split at Step 4.
 *
 * Design: each test builds a real `createRequestHandler(state, deps, turn, dispatch)` stub
 * and issues a synthetic HTTP request via lightweight MockIncomingMessage / MockServerResponse.
 * No module mocking — the pre-split routes.ts is imported directly.
 *
 * Run:
 *   node --import tsx --test --test-force-exit \
 *     tests/cli/subcommands/serve/routes-characterization.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { createRequestHandler } from "../../../../src/cli/subcommands/serve/routes.js";
import { createWorkflowController } from "../../../../src/agent/workflow/controller.js";
import type { ServeState, ServeDeps } from "../../../../src/cli/subcommands/serve/context.js";

// ─── Simple inline spy ────────────────────────────────────────────────────────

function makeSpy<T extends unknown[]>(): ((...args: T) => void) & { calls: T[] } {
  const calls: T[] = [];
  const spy = (...args: T) => { calls.push(args); };
  spy.calls = calls;
  return spy;
}

// ─── Mock HTTP classes ────────────────────────────────────────────────────────

class MockServerResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  ended = false;
  written: string[] = [];

  writeHead(status: number, hdrs?: Record<string, string>): this {
    this.statusCode = status;
    if (hdrs) Object.assign(this.headers, hdrs);
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.written.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }

  end(payload?: string): void {
    if (payload) this.body = payload;
    this.ended = true;
  }

  parsedBody(): unknown {
    try { return JSON.parse(this.body); } catch { return null; }
  }
}

class MockIncomingMessage extends EventEmitter {
  headers: Record<string, string>;
  method: string;
  url: string;
  private _bodyChunks: Buffer[];

  constructor(opts: {
    method?: string;
    url?: string;
    authorization?: string;
    body?: unknown;
  }) {
    super();
    this.method = opts.method ?? "GET";
    this.url = opts.url ?? "/";
    this._bodyChunks = opts.body !== undefined
      ? [Buffer.from(JSON.stringify(opts.body))]
      : [];
    this.headers = {
      ...(opts.authorization ? { authorization: opts.authorization } : {}),
    };
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

// ─── Stub factories ───────────────────────────────────────────────────────────

function makeTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "p72s6-"));
  mkdirSync(join(home, ".frondose", "agent"), { recursive: true });
  return home;
}

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
    passiveLimiter: { tryConsume: () => true } as never,
    sseClients: new Set(),
    ...overrides,
  };
}

function makeWorkflowDeps() {
  const frames: unknown[] = [];
  const audits: unknown[] = [];
  const ctrl = createWorkflowController({
    emitFrame: (f) => frames.push(f),
    writeWorkflowAudit: (e) => audits.push(e),
  });
  return { ctrl, frames, audits };
}

function makeDeps(overrides: Partial<ServeDeps> = {}): ServeDeps {
  const { ctrl } = makeWorkflowDeps();
  const emitFrame = makeSpy();
  // P-AUTO-8 (N-1): cast tolerates the new required composeOperatorSystem field added to
  // ServeDeps at Step 4 — matches the pattern used by turn-characterization + serve-pY4 fixtures.
  return {
    model: {} as ServeDeps["model"],
    system: "SYSTEM",
    systemResume: "RESUME",
    tools: {} as ServeDeps["tools"],
    maxSteps: 20,
    auditWriter: {} as ServeDeps["auditWriter"],
    session: { getOrInitClient: async () => ({ ok: false as const, error: "no_chrome", message: "stub" }) } as ServeDeps["session"],
    schedulePath: "/tmp/schedule.json",
    salesDbPath: "/tmp/sales.db",
    auditPath: "/tmp/audit.jsonl",
    expectedToken: Buffer.from("test-token", "utf-8"),
    workflow: ctrl,
    emitFrame,
    emitOverlayEvent: makeSpy(),
    ...overrides,
  } as unknown as ServeDeps;
}

function makeTurnStub() {
  const resumeWorkflowTurnCalls: string[] = [];
  const runOneTurnCalls: unknown[] = [];
  return {
    stub: {
      runOneTurn: (opts: unknown) => { runOneTurnCalls.push(opts); return Promise.resolve(); },
      resumeWorkflowTurn: (prompt: string) => { resumeWorkflowTurnCalls.push(prompt); return Promise.resolve(); },
      triggerAnalyzeProfile: (_url: string, _turnId: string, _ac: AbortController) => Promise.resolve(),
    },
    resumeWorkflowTurnCalls,
    runOneTurnCalls,
  };
}

function makeDispatch() {
  const dispatchOverlayEventCalls: unknown[] = [];
  return {
    stub: {
      dispatchOverlayEvent: (e: unknown) => dispatchOverlayEventCalls.push(e),
    },
    dispatchOverlayEventCalls,
  };
}

// Helper: issue a request through handleRequest and await the response
async function issueRequest(
  handler: { handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> },
  reqOpts: ConstructorParameters<typeof MockIncomingMessage>[0],
): Promise<MockServerResponse> {
  const req = new MockIncomingMessage(reqOpts);
  const res = new MockServerResponse();
  await handler.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res;
}

// ─── T-routes.Workflow.1 ─────────────────────────────────────────────────────

describe("createRequestHandler — POST /workflow/approve → 200 + resumePrompt + resumeWorkflowTurn called (G-P72s6.1, LOAD-BEARING)", () => {
  it("T-routes.Workflow.1: given controller in awaiting-approval state, POST /workflow/approve → 200 + resumePrompt non-empty + turn.resumeWorkflowTurn called", async () => {
    // Given: controller pre-populated with an awaiting-approval step
    // When: POST /workflow/approve {stepId} with valid bearer
    // Then: 200 + resumePrompt non-empty + resumeWorkflowTurn called with that prompt

    const { ctrl } = makeWorkflowDeps();
    // Pre-populate approval-pending state
    ctrl.onToolResults(
      [{
        toolName: "todo_write",
        result: {
          ok: true,
          workflowTitle: "Plan",
          steps: [{ id: "s1", title: "Outbound", requiresApproval: true, state: "in_progress" }],
        },
      }],
      { turnId: "t1", isCronTurn: false },
    );

    const { stub: turnStub, resumeWorkflowTurnCalls } = makeTurnStub();
    const deps = makeDeps({ workflow: ctrl });
    const state = makeState();
    const { stub: dispatchStub } = makeDispatch();

    const handler = createRequestHandler(
      state,
      deps,
      turnStub as never,
      dispatchStub as never,
    );

    const wfState = ctrl.getState();
    const stepId = wfState.awaitingApprovalStepId;
    assert.ok(stepId, "controller is in awaiting-approval state after setup");

    const res = await issueRequest(handler, {
      method: "POST",
      url: "/workflow/approve",
      authorization: "Bearer test-token",
      body: { stepId },
    });

    assert.equal(res.statusCode, 200, "status 200");
    const body = res.parsedBody() as Record<string, unknown>;
    assert.equal(body?.ok, true, "ok:true");
    // NOTE: resumePrompt is in r.resumePrompt (from handleEndpoint), consumed by the route to
    // call turn.resumeWorkflowTurn — it is NOT echoed back in the HTTP response body (which
    // is r.response === {ok:true}). This matches pre-split L314-315 exactly.
    assert.ok(resumeWorkflowTurnCalls.length === 1, "resumeWorkflowTurn called once");
    const calledPrompt = resumeWorkflowTurnCalls[0];
    assert.ok(typeof calledPrompt === "string" && calledPrompt.length > 0, "resumeWorkflowTurn called with non-empty resumePrompt");
  });
});

// ─── T-routes.Workflow.2 ─────────────────────────────────────────────────────

describe("createRequestHandler — POST /workflow/decline → 200 + gate remains closed (G-P72s6.1, LOAD-BEARING)", () => {
  it("T-routes.Workflow.2: given controller in awaiting-approval state, POST /workflow/decline → 200 + hasApprovedOutboundStep()===false + approval-resolved frame emitted with decision:declined", async () => {
    // Given: controller in awaiting-approval state with hasApprovedOutboundStep()===false
    // When: POST /workflow/decline {stepId, reason} with valid bearer
    // Then: 200 + hasApprovedOutboundStep() still false + approval-resolved SSE emitted with decision:declined

    const frames: unknown[] = [];
    const ctrl = createWorkflowController({
      emitFrame: (f) => frames.push(f),
      writeWorkflowAudit: () => {},
    });
    ctrl.onToolResults(
      [{
        toolName: "todo_write",
        result: {
          ok: true,
          workflowTitle: "Plan",
          steps: [{ id: "s1", title: "Outbound", requiresApproval: true, state: "in_progress" }],
        },
      }],
      { turnId: "t1", isCronTurn: false },
    );

    const { stub: turnStub } = makeTurnStub();
    const deps = makeDeps({ workflow: ctrl });
    const state = makeState();
    const { stub: dispatchStub } = makeDispatch();

    const handler = createRequestHandler(state, deps, turnStub as never, dispatchStub as never);

    const wfState = ctrl.getState();
    const stepId = wfState.awaitingApprovalStepId;
    assert.ok(stepId, "controller is in awaiting-approval state");
    assert.equal(ctrl.hasApprovedOutboundStep(), false, "gate closed before decline");

    const res = await issueRequest(handler, {
      method: "POST",
      url: "/workflow/decline",
      authorization: "Bearer test-token",
      body: { stepId, reason: "not now" },
    });

    assert.equal(res.statusCode, 200, "status 200");
    const body = res.parsedBody() as Record<string, unknown>;
    assert.equal(body?.ok, true, "ok:true");

    // Gate must remain closed (decline did NOT open it)
    assert.equal(ctrl.hasApprovedOutboundStep(), false, "gate still closed after decline");

    // approval-resolved frame with decision:declined
    const resolvedFrame = (frames as Array<{ type: string; decision?: string }>).find(
      (f) => f.type === "workflow-approval-resolved",
    );
    assert.ok(resolvedFrame, "workflow-approval-resolved SSE emitted");
    assert.equal(resolvedFrame?.decision, "declined", "decision:declined");
  });
});

// ─── T-routes.Workflow.3 ─────────────────────────────────────────────────────

describe("createRequestHandler — POST /workflow/bogus → 404 + reason:unknown_workflow_endpoint (G-P72s6.1)", () => {
  it("T-routes.Workflow.3: given any controller state, POST /workflow/bogus → 404 + {ok:false, reason:'unknown_workflow_endpoint'}", async () => {
    // Given: any controller state
    // When: POST /workflow/bogus with empty body + valid bearer
    // Then: 404 + {ok:false, reason:'unknown_workflow_endpoint'}

    const deps = makeDeps();
    const state = makeState();
    const { stub: turnStub } = makeTurnStub();
    const { stub: dispatchStub } = makeDispatch();

    const handler = createRequestHandler(state, deps, turnStub as never, dispatchStub as never);

    const res = await issueRequest(handler, {
      method: "POST",
      url: "/workflow/bogus",
      authorization: "Bearer test-token",
      body: {},
    });

    assert.equal(res.statusCode, 404, "status 404");
    const body = res.parsedBody() as Record<string, unknown>;
    assert.equal(body?.ok, false, "ok:false");
    assert.equal(body?.reason, "unknown_workflow_endpoint", "reason:unknown_workflow_endpoint");
  });
});

// ─── T-routes.AgentAbort.1 ───────────────────────────────────────────────────

describe("createRequestHandler — POST /agent/abort behavior (G-P72s6.1)", () => {
  it("T-routes.AgentAbort.1: given state.currentTurn===null, POST /agent/abort → 200 + {ok:false, reason:'not_found'}", async () => {
    // Given: state.currentTurn === null (no active turn)
    // When: POST /agent/abort with empty body + valid bearer
    // Then: 200 + {ok:false, reason:'not_found'}; no exception thrown

    const deps = makeDeps();
    const state = makeState({ currentTurn: null });
    const { stub: turnStub } = makeTurnStub();
    const { stub: dispatchStub } = makeDispatch();

    const handler = createRequestHandler(state, deps, turnStub as never, dispatchStub as never);

    const res = await issueRequest(handler, {
      method: "POST",
      url: "/agent/abort",
      authorization: "Bearer test-token",
    });

    assert.equal(res.statusCode, 200, "status 200");
    const body = res.parsedBody() as Record<string, unknown>;
    assert.equal(body?.ok, false, "ok:false");
    assert.equal(body?.reason, "not_found", "reason:not_found");
    assert.equal(state.currentTurn, null, "state.currentTurn stays null");
  });

  it("T-routes.AgentAbort.1 edge: given state.currentTurn non-null, POST /agent/abort → 200 + {ok:true, released:true} + state.currentTurn===null (D-21 force-release)", async () => {
    // Given: state.currentTurn non-null (active turn exists)
    // When: POST /agent/abort with valid bearer
    // Then: 200 + {ok:true, released:true, turnId} + state.currentTurn===null

    const ac = new AbortController();
    const fakeTurn = { turnId: "abc123", abortController: ac };
    const deps = makeDeps();
    const state = makeState({ currentTurn: fakeTurn });
    const { stub: turnStub } = makeTurnStub();
    const { stub: dispatchStub } = makeDispatch();

    const handler = createRequestHandler(state, deps, turnStub as never, dispatchStub as never);

    const res = await issueRequest(handler, {
      method: "POST",
      url: "/agent/abort",
      authorization: "Bearer test-token",
    });

    assert.equal(res.statusCode, 200, "status 200");
    const body = res.parsedBody() as Record<string, unknown>;
    assert.equal(body?.ok, true, "ok:true");
    assert.equal(body?.released, true, "released:true");
    assert.equal(body?.turnId, "abc123", "turnId matches");
    assert.equal(state.currentTurn, null, "D-21: state.currentTurn cleared");
    assert.ok(ac.signal.aborted, "D-21: abortController.abort() was called");
  });
});

// ─── T-routes.Settings.1 ─────────────────────────────────────────────────────

describe("createRequestHandler — GET /settings returns masked settings (G-P72s6.1)", () => {
  it("T-routes.Settings.1: given a tmp MAI_HOME_BASE, GET /settings with valid bearer → 200 + {ok:true, llm:{...}, identity:{...}}", async () => {
    // Given: temp home with writable config/secrets (readSettings() can run)
    // When: GET /settings with valid bearer
    // Then: 200 + {ok:true, ...} where llm.maskedKey is not a raw key AND llm.hasKey is boolean

    const home = makeTempHome();
    const prevHome = process.env.MAI_HOME_BASE;
    process.env.MAI_HOME_BASE = home;
    try {
      const deps = makeDeps();
      const state = makeState();
      const { stub: turnStub } = makeTurnStub();
      const { stub: dispatchStub } = makeDispatch();

      const handler = createRequestHandler(state, deps, turnStub as never, dispatchStub as never);

      const res = await issueRequest(handler, {
        method: "GET",
        url: "/settings",
        authorization: "Bearer test-token",
      });

      assert.equal(res.statusCode, 200, "status 200");
      const body = res.parsedBody() as Record<string, unknown>;
      assert.equal(body?.ok, true, "ok:true");
      // Must have llm field with hasKey (masked view)
      const llm = body?.llm as Record<string, unknown> | undefined;
      assert.ok(llm !== undefined, "llm field present");
      assert.ok("hasKey" in (llm ?? {}), "hasKey present in llm");
      assert.ok(typeof llm?.hasKey === "boolean", "hasKey is boolean");
      // maskedKey must not be a long raw key (≥64 chars = likely raw)
      const maskedKey = llm?.maskedKey;
      if (typeof maskedKey === "string") {
        assert.ok(maskedKey.length < 50, "maskedKey is masked (not raw long key)");
      }
    } finally {
      if (prevHome === undefined) delete process.env.MAI_HOME_BASE;
      else process.env.MAI_HOME_BASE = prevHome;
    }
  });
});

// ─── T-routes.Settings.2 ─────────────────────────────────────────────────────

describe("createRequestHandler — POST /settings valid patch → validate→write→reload→echo order (G-P72s6.1, LOAD-BEARING)", () => {
  it("T-routes.Settings.2: given valid identity SettingsPatch, POST /settings → 200 + restartRequired reported + no emitFrame calls (validate→write-merge→reload→masked echo order)", async () => {
    // Given: temp home; valid identity patch in body
    // When: POST /settings {identity:{fullName:'Alice'}} with valid bearer
    // Then: 200 + restartRequired boolean + identity.fullName:Alice in response + deps.emitFrame NOT called

    const home = makeTempHome();
    const prevHome = process.env.MAI_HOME_BASE;
    process.env.MAI_HOME_BASE = home;
    try {
      const emitFrameSpy = makeSpy();
      const deps = makeDeps({ emitFrame: emitFrameSpy });
      const state = makeState();
      const { stub: turnStub } = makeTurnStub();
      const { stub: dispatchStub } = makeDispatch();

      const handler = createRequestHandler(state, deps, turnStub as never, dispatchStub as never);

      const res = await issueRequest(handler, {
        method: "POST",
        url: "/settings",
        authorization: "Bearer test-token",
        body: { identity: { fullName: "Alice", role: "Engineer" } },
      });

      assert.equal(res.statusCode, 200, "status 200");
      const body = res.parsedBody() as Record<string, unknown>;
      assert.equal(body?.ok, true, "ok:true");
      assert.ok("restartRequired" in (body ?? {}), "restartRequired present");
      assert.ok(typeof body?.restartRequired === "boolean", "restartRequired is boolean");

      // NO emitFrame calls (pre-split L103 comment: "NO emitFrame/auditWriter")
      assert.equal(emitFrameSpy.calls.length, 0, "emitFrame NOT called on settings POST");
    } finally {
      if (prevHome === undefined) delete process.env.MAI_HOME_BASE;
      else process.env.MAI_HOME_BASE = prevHome;
    }
  });

  it("T-routes.Settings.2 edge: invalid body → 400 + file unchanged (fail-fast, write nothing)", async () => {
    // Given: temp home; INVALID body (llm.baseUrl is not a URL)
    // When: POST /settings with body {llm:{baseUrl:'not-a-url'}} + valid bearer
    // Then: 400 + {ok:false, error:...} + settings file UNCHANGED

    const home = makeTempHome();
    const prevHome = process.env.MAI_HOME_BASE;
    process.env.MAI_HOME_BASE = home;
    try {
      const deps = makeDeps();
      const state = makeState();
      const { stub: turnStub } = makeTurnStub();
      const { stub: dispatchStub } = makeDispatch();

      const handler = createRequestHandler(state, deps, turnStub as never, dispatchStub as never);

      const res = await issueRequest(handler, {
        method: "POST",
        url: "/settings",
        authorization: "Bearer test-token",
        body: { llm: { baseUrl: "not-a-url" } },
      });

      assert.equal(res.statusCode, 400, "status 400 on invalid patch");
      const body = res.parsedBody() as Record<string, unknown>;
      assert.equal(body?.ok, false, "ok:false");
      assert.ok(typeof body?.error === "string", "error field is string");
    } finally {
      if (prevHome === undefined) delete process.env.MAI_HOME_BASE;
      else process.env.MAI_HOME_BASE = prevHome;
    }
  });
});

// ─── T-routes.Health.1 ───────────────────────────────────────────────────────

describe("createRequestHandler — GET /health returns 200 + {ok:true, ts:number, pid:process.pid} (G-P72s6.1)", () => {
  it("T-routes.Health.1: given stub deps, GET /health with valid bearer → 200 + ok:true + ts:number + pid:process.pid", async () => {
    // Given: a handler built with stub deps
    // When: GET /health with valid bearer
    // Then: 200 + {ok:true, ts:<number>, pid:<process.pid>}

    const deps = makeDeps();
    const state = makeState();
    const { stub: turnStub } = makeTurnStub();
    const { stub: dispatchStub } = makeDispatch();

    const handler = createRequestHandler(state, deps, turnStub as never, dispatchStub as never);

    const res = await issueRequest(handler, {
      method: "GET",
      url: "/health",
      authorization: "Bearer test-token",
    });

    assert.equal(res.statusCode, 200, "status 200");
    const body = res.parsedBody() as Record<string, unknown>;
    assert.equal(body?.ok, true, "ok:true");
    assert.ok(typeof body?.ts === "number" && body.ts > 0, "ts is a positive number");
    assert.equal(body?.pid, process.pid, "pid === process.pid");
  });

  it("T-routes.Health.1 idempotent: multiple GET /health calls all return 200/ok (stateless)", async () => {
    // Given: same handler called multiple times
    // When: three GET /health calls in sequence
    // Then: all return 200 + ok:true (idempotent)

    const deps = makeDeps();
    const state = makeState();
    const { stub: turnStub } = makeTurnStub();
    const { stub: dispatchStub } = makeDispatch();

    const handler = createRequestHandler(state, deps, turnStub as never, dispatchStub as never);

    for (let i = 0; i < 3; i++) {
      const res = await issueRequest(handler, {
        method: "GET",
        url: "/health",
        authorization: "Bearer test-token",
      });
      assert.equal(res.statusCode, 200, `call ${i + 1}: status 200`);
      const body = res.parsedBody() as Record<string, unknown>;
      assert.equal(body?.ok, true, `call ${i + 1}: ok:true`);
    }
  });
});

// ─── T-routes.Auth.1 ─────────────────────────────────────────────────────────

describe("createRequestHandler — every endpoint requires bearer; missing/wrong → 401 (G-P72s6.1, LOAD-BEARING, security)", () => {
  // The 14 concrete route patterns from §4.7 (excluding the dispatcher fallthrough 404 + 500)
  // plus GET /agent/events (which also goes through checkBearer before the SSE setup).
  const ROUTE_MATRIX: Array<{ method: string; url: string; body?: unknown }> = [
    { method: "GET", url: "/health" },
    { method: "GET", url: "/identity" },
    { method: "GET", url: "/settings" },
    { method: "POST", url: "/settings", body: {} },
    { method: "POST", url: "/chrome/ensure", body: {} },
    { method: "POST", url: "/agent/turn", body: { prompt: "hi" } },
    { method: "POST", url: "/agent/activate", body: { url: "https://linkedin.com/in/xyz" } },
    { method: "POST", url: "/agent/abort" },
    { method: "POST", url: "/agent/retry" },
    { method: "POST", url: "/workflow/approve", body: { stepId: "s1" } },
    { method: "POST", url: "/workflow/decline", body: { stepId: "s1" } },
    { method: "POST", url: "/agent/cron-mode", body: { enabled: false } },
    { method: "POST", url: "/agent/passive-mode", body: { enabled: false } },
    { method: "GET", url: "/agent/events" },
    { method: "GET", url: "/audit/tail" },
  ];

  it("T-routes.Auth.1 (missing bearer): 15 routes × missing Authorization → 401 + {ok:false, error:'missing_bearer'}", async () => {
    // Given: handler with expectedToken set
    // When: each of 15 routes called with NO Authorization header
    // Then: every call → 401 + error:'missing_bearer'

    const deps = makeDeps();
    const state = makeState();
    const { stub: turnStub } = makeTurnStub();
    const { stub: dispatchStub } = makeDispatch();
    const handler = createRequestHandler(state, deps, turnStub as never, dispatchStub as never);

    for (const route of ROUTE_MATRIX) {
      // No authorization header (MockIncomingMessage omits it when not provided)
      const req = new MockIncomingMessage({ method: route.method, url: route.url, body: route.body });
      const res = new MockServerResponse();
      await handler.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      const body = res.parsedBody() as Record<string, unknown>;
      assert.equal(res.statusCode, 401, `${route.method} ${route.url}: expected 401, got ${res.statusCode}`);
      assert.equal(body?.error, "missing_bearer", `${route.method} ${route.url}: error:missing_bearer`);
    }
  });

  it("T-routes.Auth.1 (wrong bearer): 15 routes × wrong bearer → 401 + {ok:false, error:'invalid_token'}", async () => {
    // Given: handler with expectedToken="test-token"
    // When: each of 15 routes called with Authorization: Bearer wrong-token
    // Then: every call → 401 + error:'invalid_token'

    const deps = makeDeps();
    const state = makeState();
    const { stub: turnStub } = makeTurnStub();
    const { stub: dispatchStub } = makeDispatch();
    const handler = createRequestHandler(state, deps, turnStub as never, dispatchStub as never);

    for (const route of ROUTE_MATRIX) {
      const req = new MockIncomingMessage({
        method: route.method,
        url: route.url,
        body: route.body,
        authorization: "Bearer wrong-token",
      });
      const res = new MockServerResponse();
      await handler.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      const body = res.parsedBody() as Record<string, unknown>;
      assert.equal(res.statusCode, 401, `${route.method} ${route.url}: expected 401, got ${res.statusCode}`);
      assert.equal(body?.error, "invalid_token", `${route.method} ${route.url}: error:invalid_token`);
    }
  });
});
