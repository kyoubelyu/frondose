/**
 * P-AUTO-ISOLATE Step 2 — Test Scaffold — POST /agent/auto/start + POST /agent/auto/stop
 * (the new HTTP routes per plan §4.5 FE↔BE contract).
 *
 * Covers (plan §5): T-Start.1..6, T-Terminate.1..4.
 *
 * Per outside-in TDD + BDD-light: ALL assertion bodies are
 * `assert.fail("TODO Step 5: …")` — RED at Step 2/3/4a. Neither route exists yet
 * in routes.ts's dispatch table (src/cli/subcommands/serve/routes.ts), so every
 * request in this file currently 404s — that IS the intentional Step-2 RED state.
 * Validator fills real assertions at Step 5 once Codex's Step 4b lands the routes
 * per plan §6.5 + wires them into routes.ts + persistence/schedule.ts helpers.
 *
 * T-Start.3 and T-Terminate.2 were TIGHTENED at Step 3a (plan §10.4 NIT response):
 * they now compute the emittedFrames array index of each SSE frame and assert
 * canonical ORDER (auto-session-started BEFORE cron-mode on start; auto-session-
 * completed BEFORE cron-mode on terminate) — not just presence.
 *
 * Harness mirrors tests/cli/subcommands/serve/routes-characterization.mock.test.ts
 * (local MockIncomingMessage/MockServerResponse + createRequestHandler + a
 * bearer-token round trip). No dynamic-import guard needed — createRequestHandler
 * ALREADY exists; only its dispatch table + the new handlers are Step 4b work.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/cli/subcommands/serve/routes/autoStartStop-pAutoIsolate.mock.test.ts
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createWorkflowController } from "../../../../../src/agent/workflow/controller.js";
import type { ServeDeps, ServeState } from "../../../../../src/cli/subcommands/serve/context.js";
import { createRequestHandler } from "../../../../../src/cli/subcommands/serve/routes.js";
import type { createTurnRunner } from "../../../../../src/cli/subcommands/serve/turn.js";
import { readSchedule } from "../../../../../src/persistence/schedule.js";

// ─── Mock HTTP classes (mirrors routes-characterization.mock.test.ts) ────────

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
  parsedBody(): unknown {
    try {
      return JSON.parse(this.body);
    } catch {
      return null;
    }
  }
}

class MockIncomingMessage extends EventEmitter {
  headers: Record<string, string>;
  method: string;
  url: string;
  private _bodyChunks: Buffer[];
  constructor(opts: { method?: string; url?: string; authorization?: string; body?: unknown }) {
    super();
    this.method = opts.method ?? "POST";
    this.url = opts.url ?? "/";
    this._bodyChunks = opts.body !== undefined ? [Buffer.from(JSON.stringify(opts.body))] : [];
    this.headers = { ...(opts.authorization ? { authorization: opts.authorization } : {}) };
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
    autoSessionId: null, // P-AUTO-ISOLATE: additive field, not yet on ServeState at Step 2
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

function makeDeps(schedulePath: string, salesDbPath: string, emittedFrames: unknown[]): ServeDeps {
  const ctrl = createWorkflowController({ emitFrame: () => undefined, writeWorkflowAudit: () => undefined });
  return {
    model: {},
    system: "system",
    systemResume: "resume-system",
    tools: {},
    maxSteps: 5,
    auditWriter: async () => undefined,
    session: { getOrInitClient: async () => ({ ok: false as const, error: "no_chrome", message: "stub" }), getClient: () => null },
    schedulePath,
    salesDbPath,
    auditPath: "/dev/null",
    expectedToken: Buffer.from("test-token", "utf-8"),
    workflow: ctrl,
    emitFrame: (frame: unknown) => {
      emittedFrames.push(frame);
    },
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

function makeDispatch() {
  return { dispatchOverlayEvent: () => undefined } as unknown as Parameters<typeof createRequestHandler>[3];
}

function makeTmpPaths(prefix: string): { schedulePath: string; salesDbPath: string } {
  const id = randomUUID();
  return {
    schedulePath: join(tmpdir(), `${prefix}-schedule-${id}.jsonl`),
    salesDbPath: join(tmpdir(), `${prefix}-sales-${id}.sqlite`),
  };
}

/** Seed an already-active kind:auto_session record for the already-active tests. */
function seedActiveAutoSession(schedulePath: string): string {
  const sessionId = randomUUID();
  const record = {
    id: randomUUID(),
    task: "existing standing task",
    cronExpr: "*/15 * * * *",
    type: "recurring",
    nextRunAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    lastRunAt: null,
    createdAt: new Date().toISOString(),
    enabled: true,
    kind: "auto_session",
    sessionId,
  };
  writeFileSync(schedulePath, `${JSON.stringify(record)}\n`);
  return sessionId;
}

async function issue(
  handler: { handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> },
  opts: { url: string; body?: unknown },
): Promise<MockServerResponse> {
  const req = new MockIncomingMessage({ method: "POST", url: opts.url, authorization: "Bearer test-token", body: opts.body });
  const res = new MockServerResponse();
  await handler.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res;
}

// ═══════════════════════════ T-Start ═══════════════════════════════════════

describe("POST /agent/auto/start — empty/whitespace prompt rejected (T-Start.1, T-Start.2, LOCKED-5)", () => {
  it("T-Start.1: given body {prompt:''}, then 400 {ok:false, reason:'missing_prompt'}; no new schedule record; state.cronEnabled unchanged", async () => {
    // Given: fresh schedule.jsonl (no records); body prompt=""
    // When:  POST /agent/auto/start
    // Then:  400 missing_prompt; readSchedule shows no new record; state.cronEnabled unchanged (false)
    const { schedulePath, salesDbPath } = makeTmpPaths("start1");
    const emittedFrames: unknown[] = [];
    const state = makeState();
    const deps = makeDeps(schedulePath, salesDbPath, emittedFrames);
    const handler = createRequestHandler(state, deps, makeTurnStub(), makeDispatch());

    const res = await issue(handler, { url: "/agent/auto/start", body: { prompt: "" } });

    assert.equal(res.statusCode, 400, "empty prompt must be rejected with HTTP 400");
    assert.deepEqual(res.parsedBody(), { ok: false, reason: "missing_prompt" });
    assert.equal((state as unknown as { cronEnabled: boolean }).cronEnabled, false, "state.cronEnabled must stay unchanged");
    assert.equal(readSchedule(schedulePath).length, 0, "no schedule record must be written");
  });

  it("T-Start.2: given body {prompt:'   \\n  '} (whitespace-only), then 400 {ok:false, reason:'missing_prompt'}", async () => {
    // Given: fresh schedule.jsonl; body prompt is whitespace-only
    // When:  POST /agent/auto/start
    // Then:  400 missing_prompt (trim() must reduce it to empty)
    const { schedulePath, salesDbPath } = makeTmpPaths("start2");
    const emittedFrames: unknown[] = [];
    const state = makeState();
    const deps = makeDeps(schedulePath, salesDbPath, emittedFrames);
    const handler = createRequestHandler(state, deps, makeTurnStub(), makeDispatch());

    const res = await issue(handler, { url: "/agent/auto/start", body: { prompt: "   \n  " } });

    assert.equal(res.statusCode, 400, "whitespace-only prompt must be rejected with HTTP 400");
    assert.deepEqual(res.parsedBody(), { ok: false, reason: "missing_prompt" });
  });
});

describe("POST /agent/auto/start — non-empty prompt writes a record + flips cron (T-Start.3, LOCKED-2)", () => {
  it("T-Start.3: given body {prompt:'Prospect HK founders'}, then 200 {ok:true, sessionId, intervalMinutes:15, cronExpr:'*/15 * * * *'}; a new kind:auto_session record exists; state.cronEnabled===true; state.autoSessionId===sessionId; SSE auto-session-started + cron-mode{cronEnabled:true} emitted", async () => {
    // Given: fresh schedule.jsonl; body prompt is a real standing task
    // When:  POST /agent/auto/start
    // Then:  200 + sessionId + intervalMinutes:15 + cronExpr:'*/15 * * * *';
    //        readSchedule shows the new record (kind:auto_session, enabled:true, task, sessionId match);
    //        state.cronEnabled===true; state.autoSessionId===sessionId;
    //        emittedFrames contains {type:'auto-session-started',...} AND {type:'cron-mode',cronEnabled:true}
    const { schedulePath, salesDbPath } = makeTmpPaths("start3");
    const emittedFrames: unknown[] = [];
    const state = makeState();
    const deps = makeDeps(schedulePath, salesDbPath, emittedFrames);
    const handler = createRequestHandler(state, deps, makeTurnStub(), makeDispatch());

    const res = await issue(handler, { url: "/agent/auto/start", body: { prompt: "Prospect HK founders" } });

    const startedIdx = emittedFrames.findIndex(
      (f) => typeof f === "object" && f !== null && (f as { type?: unknown }).type === "auto-session-started",
    );
    const cronModeOnIdx = emittedFrames.findIndex(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        (f as { type?: unknown }).type === "cron-mode" &&
        (f as { cronEnabled?: unknown }).cronEnabled === true,
    );
    const body = res.parsedBody() as { ok?: unknown; sessionId?: unknown; intervalMinutes?: unknown; cronExpr?: unknown };

    assert.equal(res.statusCode, 200, "non-empty prompt must succeed with HTTP 200");
    assert.equal(body.ok, true);
    assert.equal(typeof body.sessionId, "string", "response must carry a sessionId");
    assert.equal(body.intervalMinutes, 15, "response must carry intervalMinutes:15 per plan §4.5 contract");
    assert.equal(body.cronExpr, "*/15 * * * *", "response must carry cronExpr per plan §4.5 contract");
    const records = readSchedule(schedulePath);
    const newRecord = records.find((r) => (r as unknown as { sessionId?: unknown }).sessionId === body.sessionId);
    assert.ok(newRecord, "a new kind:auto_session record must exist matching the returned sessionId");
    assert.equal((newRecord as unknown as { kind?: unknown })?.kind, "auto_session");
    assert.equal(newRecord?.enabled, true);
    assert.equal(newRecord?.task, "Prospect HK founders");
    assert.equal((state as unknown as { cronEnabled: boolean }).cronEnabled, true, "state.cronEnabled must flip to true");
    assert.equal(
      (state as unknown as { autoSessionId: unknown }).autoSessionId,
      body.sessionId,
      "state.autoSessionId must equal the returned sessionId",
    );
    assert.ok(startedIdx >= 0, "auto-session-started frame must be emitted");
    assert.ok(cronModeOnIdx >= 0, "cron-mode{cronEnabled:true} frame must be emitted");
    assert.ok(
      startedIdx < cronModeOnIdx,
      `auto-session-started (idx ${startedIdx}) must be emitted BEFORE cron-mode (idx ${cronModeOnIdx}) — canonical SSE order`,
    );
  });
});

describe("POST /agent/auto/start — interval override honored + clamped (T-Start.4, LOCKED-6)", () => {
  it("T-Start.4a: given {prompt:'X', intervalMinutes:30}, then cronExpr==='*/30 * * * *'", async () => {
    // Given: body carries an explicit intervalMinutes=30 (>= the 15-min floor)
    // When:  POST /agent/auto/start
    // Then:  200 with cronExpr==='*/30 * * * *'
    const { schedulePath, salesDbPath } = makeTmpPaths("start4a");
    const emittedFrames: unknown[] = [];
    const state = makeState();
    const deps = makeDeps(schedulePath, salesDbPath, emittedFrames);
    const handler = createRequestHandler(state, deps, makeTurnStub(), makeDispatch());

    const res = await issue(handler, { url: "/agent/auto/start", body: { prompt: "X", intervalMinutes: 30 } });
    const body = res.parsedBody() as { cronExpr?: unknown; intervalMinutes?: unknown };

    assert.equal(res.statusCode, 200);
    assert.equal(body.cronExpr, "*/30 * * * *");
    assert.equal(body.intervalMinutes, 30);
  });

  it("T-Start.4b: given {prompt:'X', intervalMinutes:5} (below the 15-min floor), then 400 {ok:false, reason:'invalid_interval'}", async () => {
    // Given: body carries intervalMinutes=5 (< 15, the LinkedIn-safety floor per locked design #6)
    // When:  POST /agent/auto/start
    // Then:  400 invalid_interval; no schedule record written
    const { schedulePath, salesDbPath } = makeTmpPaths("start4b");
    const emittedFrames: unknown[] = [];
    const state = makeState();
    const deps = makeDeps(schedulePath, salesDbPath, emittedFrames);
    const handler = createRequestHandler(state, deps, makeTurnStub(), makeDispatch());

    const res = await issue(handler, { url: "/agent/auto/start", body: { prompt: "X", intervalMinutes: 5 } });

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.parsedBody(), { ok: false, reason: "invalid_interval" });
    assert.equal(readSchedule(schedulePath).length, 0, "no schedule record must be written on rejection");
  });
});

describe("POST /agent/auto/start — already-active rejected (T-Start.5, non-goal: multi-concurrent auto sessions)", () => {
  it("T-Start.5: given a live enabled kind:auto_session record already exists, when start is called again, then 409 {ok:false, reason:'already_active', sessionId}; no second record written", async () => {
    // Given: schedule.jsonl already has one enabled kind:auto_session record (seedActiveAutoSession)
    // When:  POST /agent/auto/start with a new prompt
    // Then:  409 already_active carrying the EXISTING sessionId; schedule.jsonl still has exactly 1 record
    const { schedulePath, salesDbPath } = makeTmpPaths("start5");
    const existingSessionId = seedActiveAutoSession(schedulePath);
    const emittedFrames: unknown[] = [];
    const state = makeState();
    const deps = makeDeps(schedulePath, salesDbPath, emittedFrames);
    const handler = createRequestHandler(state, deps, makeTurnStub(), makeDispatch());

    const res = await issue(handler, { url: "/agent/auto/start", body: { prompt: "a second task" } });

    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.parsedBody(), { ok: false, reason: "already_active", sessionId: existingSessionId });
    assert.equal(readSchedule(schedulePath).length, 1, "no second record must be written");
  });
});

describe("POST /agent/auto/start — default interval when omitted (T-Start.6)", () => {
  it("T-Start.6: given {prompt:'X'} with no intervalMinutes, then intervalMinutes===15 (config.auto.intervalMinutes default) and cronExpr==='*/15 * * * *'", async () => {
    // Given: body has no intervalMinutes field
    // When:  POST /agent/auto/start
    // Then:  200 with intervalMinutes===15 and cronExpr==='*/15 * * * *' (the config-schema default)
    const { schedulePath, salesDbPath } = makeTmpPaths("start6");
    const emittedFrames: unknown[] = [];
    const state = makeState();
    const deps = makeDeps(schedulePath, salesDbPath, emittedFrames);
    const handler = createRequestHandler(state, deps, makeTurnStub(), makeDispatch());

    const res = await issue(handler, { url: "/agent/auto/start", body: { prompt: "X" } });
    const body = res.parsedBody() as { intervalMinutes?: unknown; cronExpr?: unknown };

    assert.equal(res.statusCode, 200);
    assert.equal(body.intervalMinutes, 15);
    assert.equal(body.cronExpr, "*/15 * * * *");
  });
});

// ═══════════════════════════ T-Terminate ═══════════════════════════════════

describe("POST /agent/auto/stop — aborts a live tick (T-Terminate.1, LOCKED-4)", () => {
  it("T-Terminate.1: given state.currentTurn={turnId, abortController} with an unaborted controller, when POST /agent/auto/stop runs, then abortController.signal.aborted===true", async () => {
    // Given: state.currentTurn is a live in-flight tick with a fresh AbortController
    // When:  POST /agent/auto/stop (no body)
    // Then:  the SAME abortController's signal.aborted===true (side effect #1 of §4.5)
    const { schedulePath, salesDbPath } = makeTmpPaths("terminate1");
    const abortController = new AbortController();
    const emittedFrames: unknown[] = [];
    const state = makeState();
    (state as unknown as { currentTurn: unknown }).currentTurn = { turnId: "live-tick", abortController };
    const deps = makeDeps(schedulePath, salesDbPath, emittedFrames);
    const handler = createRequestHandler(state, deps, makeTurnStub(), makeDispatch());

    await issue(handler, { url: "/agent/auto/stop" });

    assert.equal(abortController.signal.aborted, true, "the live tick's AbortController must be aborted");
  });
});

describe("POST /agent/auto/stop — disables all auto_session records + flips cron (T-Terminate.2, LOCKED-4)", () => {
  it("T-Terminate.2: given schedule.jsonl has one enabled kind:auto_session record, when terminate runs, then that record's enabled===false; state.cronEnabled===false; state.autoSessionId===null; SSE auto-session-completed{reason:'terminated'} + cron-mode{cronEnabled:false} emitted in that order", async () => {
    // Given: one enabled auto_session record; state.cronEnabled=true, state.autoSessionId=sessionId
    // When:  POST /agent/auto/stop
    // Then:  record.enabled===false; state.cronEnabled===false; state.autoSessionId===null;
    //        emittedFrames = [..., {type:'auto-session-completed',reason:'terminated'}, {type:'cron-mode',cronEnabled:false}]
    //        in that ORDER (§4.5 side-effect ordering)
    const { schedulePath, salesDbPath } = makeTmpPaths("terminate2");
    const sessionId = seedActiveAutoSession(schedulePath);
    const emittedFrames: unknown[] = [];
    const state = makeState();
    (state as unknown as { cronEnabled: boolean }).cronEnabled = true;
    (state as unknown as { autoSessionId: string | null }).autoSessionId = sessionId;
    const deps = makeDeps(schedulePath, salesDbPath, emittedFrames);
    const handler = createRequestHandler(state, deps, makeTurnStub(), makeDispatch());

    const res = await issue(handler, { url: "/agent/auto/stop" });

    const completedIdx = emittedFrames.findIndex(
      (f) => typeof f === "object" && f !== null && (f as { type?: unknown }).type === "auto-session-completed",
    );
    const cronModeOffIdx = emittedFrames.findIndex(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        (f as { type?: unknown }).type === "cron-mode" &&
        (f as { cronEnabled?: unknown }).cronEnabled === false,
    );

    assert.equal(res.statusCode, 200);
    const records = readSchedule(schedulePath);
    const record = records.find((r) => (r as unknown as { sessionId?: unknown }).sessionId === sessionId);
    assert.equal(record?.enabled, false, "the auto_session record must be disabled");
    assert.equal((state as unknown as { cronEnabled: boolean }).cronEnabled, false, "state.cronEnabled must flip to false");
    assert.equal((state as unknown as { autoSessionId: unknown }).autoSessionId, null, "state.autoSessionId must be cleared");
    assert.ok(completedIdx >= 0, "auto-session-completed frame must be emitted");
    assert.equal(
      (emittedFrames[completedIdx] as { reason?: unknown }).reason,
      "terminated",
      "auto-session-completed's reason must be 'terminated'",
    );
    assert.ok(cronModeOffIdx >= 0, "cron-mode{cronEnabled:false} frame must be emitted");
    assert.ok(
      completedIdx < cronModeOffIdx,
      `auto-session-completed (idx ${completedIdx}) must be emitted BEFORE cron-mode (idx ${cronModeOffIdx}) — canonical SSE order`,
    );
  });
});

describe("POST /agent/auto/stop — idempotent when nothing active (T-Terminate.3)", () => {
  it("T-Terminate.3: given no auto_session records + state.cronEnabled===false, when terminate runs, then 200 {ok:true, sessionsDisabled:0}; SSE auto-session-completed{reason:'schedule_gone'} still fires", async () => {
    // Given: fresh schedule.jsonl (no records); state.cronEnabled already false
    // When:  POST /agent/auto/stop
    // Then:  200 sessionsDisabled:0; a auto-session-completed{reason:'schedule_gone'} frame STILL fires
    //        (so any stuck FE resyncs — §4.5)
    const { schedulePath, salesDbPath } = makeTmpPaths("terminate3");
    const emittedFrames: unknown[] = [];
    const state = makeState();
    const deps = makeDeps(schedulePath, salesDbPath, emittedFrames);
    const handler = createRequestHandler(state, deps, makeTurnStub(), makeDispatch());

    const res = await issue(handler, { url: "/agent/auto/stop" });
    const body = res.parsedBody() as { sessionsDisabled?: unknown };

    assert.equal(res.statusCode, 200);
    assert.equal(body.sessionsDisabled, 0);
    const completedFrame = emittedFrames.find(
      (f) => typeof f === "object" && f !== null && (f as { type?: unknown }).type === "auto-session-completed",
    ) as { reason?: unknown } | undefined;
    assert.ok(completedFrame, "auto-session-completed frame must still fire so a stuck FE resyncs");
    assert.equal(completedFrame?.reason, "schedule_gone");
  });
});

describe("POST /agent/auto/stop — no cross-mode side effects (T-Terminate.4)", () => {
  it("T-Terminate.4: given state.passiveEnabled===true (Magical mode), when terminate runs, then state.passiveEnabled is unchanged", async () => {
    // Given: state.passiveEnabled=true (operator has Magical mode active alongside Auto)
    // When:  POST /agent/auto/stop
    // Then:  state.passiveEnabled remains true — terminate must not touch Magical's toggle
    const { schedulePath, salesDbPath } = makeTmpPaths("terminate4");
    const emittedFrames: unknown[] = [];
    const state = makeState();
    (state as unknown as { passiveEnabled: boolean }).passiveEnabled = true;
    const deps = makeDeps(schedulePath, salesDbPath, emittedFrames);
    const handler = createRequestHandler(state, deps, makeTurnStub(), makeDispatch());

    await issue(handler, { url: "/agent/auto/stop" });

    assert.equal(
      (state as unknown as { passiveEnabled: boolean }).passiveEnabled,
      true,
      "terminate must not touch state.passiveEnabled (Magical mode toggle)",
    );
  });
});
