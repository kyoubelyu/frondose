/**
 * P-57a Step 4a — T-Serve.9, T-Serve.10, T-Serve.11, T-Serve.12
 * (G-P57a.3, G-P57a.4, G-P57a.5, G-P57a.6)
 *
 * Mock tests for P-57a additions to `src/cli/subcommands/serve.ts`:
 *   T-Serve.9  — currentTurn 409 guard preserved from P-56b (regression check)
 *   T-Serve.10 — suggest_card / suggest_next_actions tool result →
 *                'suggestion-card' / 'next-actions' SSE event + overlay
 *                __frondoseShowCard / __frondoseShowNextActions callInOverlay invocation
 *                (CONCERN-MR-1 fix from critics: paired serve-layer assertion)
 *   T-Serve.11 — POST /agent/activate → triggerAnalyzeProfile fires a turn with
 *                the LOCKED prompt substring "Analyze this profile against the
 *                operator's ICP"; returns {ok:true, turnId, status:"queued"}
 *   T-Serve.12 — POST /agent/cron-mode → flips cronEnabled flag + emits
 *                {type:"cron-mode", cronEnabled:<new>} on SSE; bad body → 400
 *
 * Gate coverage:
 *   G-P57a.3 — /agent/turn currentTurn 409 (T-Serve.9, regression)
 *   G-P57a.4 — suggest_card → SSE + overlay (T-Serve.10)
 *   G-P57a.5 — /agent/activate endpoint (T-Serve.11)
 *   G-P57a.6 — /agent/cron-mode flag flip + SSE (T-Serve.12)
 *
 * Mock strategy:
 *   - Mirrors P-56b serve-p56b.mock.test.ts before() hook pattern: mock
 *     session.js + loop.js + modelResolver.js BEFORE importing serve.ts.
 *   - For T-Serve.10: mockRunAgentLoop receives `onStepFinish` and invokes it
 *     synchronously with a synthetic `step` whose `toolResults` includes a
 *     suggest_card result. Per D-P56b-01 lesson: we DO NOT need to register
 *     the suggest_card tool schema here because we're mocking runAgentLoop's
 *     OUTPUT (the step), not driving the SDK through streamText. The SDK
 *     mock-schema requirement only applies when calling streamText with a
 *     MockLanguageModelV1; here we bypass the SDK entirely.
 *   - For T-Serve.11: mockRunAgentLoop captures the `messages[]` array; test
 *     asserts the last user message contains the LOCKED triggerAnalyzeProfile
 *     prompt substring.
 *   - For T-Serve.12: open SSE listener; POST /agent/cron-mode; assert SSE frame.
 *   - All tmp dirs via mkdtempSync; ZERO ~/.mai/ reads in mock tests.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/cli/subcommands/serve-p57a.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { request as httpReq } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

// ─── Mock state ───────────────────────────────────────────────────────────────

/** Captures the last `messages[]` passed to mockRunAgentLoop. Reassigned per test. */
// biome-ignore lint/suspicious/noExplicitAny: per-test capture array — type does not need to match CoreMessage
let mockCapturedMessages: any[] | null = null;

/** Captures the last `onStepFinish` callback. Test bodies may invoke it
 *  synthetically with a fake `step` payload (T-Serve.10). */
// biome-ignore lint/suspicious/noExplicitAny: stub StepResult
let mockOnStepFinish: ((step: any) => void | Promise<void>) | null = null;

/** Controls how long the mocked runAgentLoop sleeps (ms). Default short — most
 *  tests want fast resolution. T-Serve.9 sleeps long (1500ms) to verify 409. */
let mockTurnSleepMs = 50;
let mockPiMode: "sleep" | "abort-latched" | "hold" = "sleep";
let mockPiCallCount = 0;
let mockPiResolveCount = 0;
let mockPiSignals: AbortSignal[] = [];
let installedTurnSignal: AbortSignal | null = null;
let sessionClearCalls: AbortSignal[] = [];
let abortObservedResolve: (() => void) | null = null;
let maySettle: Promise<void> = Promise.resolve();
let secondEnteredResolve: (() => void) | null = null;

// ─── runServeSubcommand handle (loaded after mocks are wired) ─────────────────

let runServeSubcommand: (opts: { portFile: string; bearerToken: string }) => Promise<void>;

// ─── File-level setup: mock session.js + loop.js + modelResolver BEFORE serve.ts ─

before(async () => {
  // 1. Mock createLinkedinSession
  const sessionUrl = pathToFileURL(resolve(process.cwd(), "src/linkedin/session.js")).href;
  mock.module(sessionUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub — type does not need to match LinkedinSession exactly
      createLinkedinSession: (_opts: any) => ({
        inputMode: "cdp",
        setTurnAbortSignal(signal: AbortSignal) {
          installedTurnSignal = signal;
        },
        clearTurnAbortSignal(signal: AbortSignal) {
          sessionClearCalls.push(signal);
          if (installedTurnSignal === signal) installedTurnSignal = null;
        },
        async getOrInitClient() {
          return { ok: true as const, client: { isConnected: () => true, handle: {} } };
        },
        getClient() {
          return null;
        },
      }),
    },
  });

  const piModelUrl = pathToFileURL(resolve(process.cwd(), "src/agent/pi/model.js")).href;
  mock.module(piModelUrl, {
    namedExports: {
      resolvePiModel: () => {
        mockPiResolveCount++;
        return { model: "mock", apiKey: "mock" };
      },
    },
  });

  const piLoopUrl = pathToFileURL(resolve(process.cwd(), "src/agent/pi/loop.js")).href;
  mock.module(piLoopUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: controlled Pi seam
      runAgentLoopPi: async (opts: any) => {
        mockCapturedMessages = opts?.messages ?? null;
        mockOnStepFinish = opts?.onStepFinish ?? null;
        mockPiCallCount++;
        mockPiSignals.push(opts.abortSignal);
        const mode = mockPiMode;
        if (mode === "abort-latched") {
          await new Promise<void>((done) => {
            if (opts.abortSignal.aborted) return done();
            opts.abortSignal.addEventListener("abort", () => done(), { once: true });
          });
          abortObservedResolve?.();
          await maySettle;
          return;
        }
        if (mode === "hold") {
          secondEnteredResolve?.();
          await new Promise<void>((done) => {
            if (opts.abortSignal.aborted) return done();
            opts.abortSignal.addEventListener("abort", () => done(), { once: true });
          });
          return;
        }
        await new Promise<void>((done) => setTimeout(done, mockTurnSleepMs));
      },
    },
  });

  // 2. Keep the passive delegate mock importable.
  const loopUrl = pathToFileURL(resolve(process.cwd(), "src/agent/loop.js")).href;
  mock.module(loopUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub AgentLoopOpts
      runAgentLoop: async (opts: any) => {
        mockCapturedMessages = opts?.messages ?? null;
        mockOnStepFinish = opts?.onStepFinish ?? null;
        const sleepMs = mockTurnSleepMs;
        if (opts?.abortSignal) {
          await new Promise<void>((res) => {
            if (opts.abortSignal.aborted) {
              res();
              return;
            }
            opts.abortSignal.addEventListener("abort", () => res(), { once: true });
            setTimeout(() => res(), sleepMs);
          });
        } else {
          await new Promise<void>((r) => setTimeout(r, sleepMs));
        }
      },
      // [P-PI-followup] Pi loop transitive imports from loop.js — see _loopMockHelper.ts.
      STALL_STEP_THRESHOLD: 4,
      lastAssistantMessageHasNoToolCalls: () => false,
      lastAssistantMessageMissedExecute: () => false,
      narrationContinueMessage: () => ({ role: "user" as const, content: "" }),
      stalledContinueMessage: () => ({ role: "user" as const, content: "" }),
    },
  });

  // 3. Mock resolveModel
  const modelResolverUrl = pathToFileURL(resolve(process.cwd(), "src/agent/modelResolver.js")).href;
  mock.module(modelResolverUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: minimal LanguageModel stub
      resolveModel: (): any => ({}),
      resolveModelSpec: () => "mock:stub",
      resolveModelOrNull: () => ({}) as never,
    },
  });

  // 4. Import serve.js AFTER mocks are set
  const serveMod = await import("../../../src/cli/subcommands/serve.js");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  runServeSubcommand = (serveMod as any).runServeSubcommand;
});

// ─── TCP HTTP helpers (WIN-1: UDS → loopback TCP + port-file) ────────────────

interface TcpReqOpts {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}
interface TcpResult {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test result body type varies
  body: any;
}

/** Make an HTTP request over TCP loopback; resolve with status + parsed JSON. */
async function udsReq(opts: TcpReqOpts): Promise<TcpResult> {
  return new Promise<TcpResult>((resolveP, rejectP) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
    if (bodyStr) headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
    const r = httpReq({ host: "127.0.0.1", port: opts.port, method: opts.method, path: opts.path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          resolveP({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) });
        } catch (e) {
          rejectP(new Error(`JSON parse error in TCP response: ${e}`));
        }
      });
    });
    r.on("error", rejectP);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

/** Collect SSE bytes for `collectMs`. */
async function udsSSECollect(opts: {
  port: number;
  headers?: Record<string, string>;
  collectMs: number;
}): Promise<{ statusCode: number; text: string }> {
  return new Promise((resolveP, rejectP) => {
    const r = httpReq(
      {
        host: "127.0.0.1",
        port: opts.port,
        method: "GET",
        path: "/agent/events",
        headers: { Accept: "text/event-stream", ...(opts.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        setTimeout(() => {
          r.destroy();
          resolveP({
            statusCode: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf-8"),
          });
        }, opts.collectMs);
      },
    );
    r.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code === "ECONNRESET") return;
      rejectP(e);
    });
    r.end();
  });
}

/** Poll until portFile contains a valid port, OR deadline_ms expires. */
async function pollForPort(portFile: string, deadline_ms: number): Promise<number | null> {
  const end = Date.now() + deadline_ms;
  while (Date.now() < end) {
    try {
      if (existsSync(portFile)) {
        const content = readFileSync(portFile, "utf-8").trim();
        const port = parseInt(content, 10);
        if (!Number.isNaN(port) && port > 0) return port;
      }
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

// ─── T-Serve.9 — D-21 delayed cleanup ownership ────────────────────────────

describe("runServeSubcommand — D-21 delayed cleanup preserves replacement ownership", () => {
  it("T-Serve.9: D-21 late T1 cleanup cannot clear T2's HTTP or session owner", async () => {
    // Given: T1 observes abort but cannot settle until T2 owns both domains
    // When:  T1 settles late and /agent/abort runs
    // Then:  the response and exact aborted signal still belong to T2
    const tmpDir = mkdtempSync(join(tmpdir(), "mai-p57a-t9-"));
    const portFile = join(tmpDir, "frondose.port");
    const bearer = "tok";
    const origHome = process.env.FRONDOSE_HOME_BASE;
    process.env.FRONDOSE_HOME_BASE = tmpDir;
    mkdirSync(join(tmpDir, ".frondose", "agent"), { recursive: true });

    mockPiCallCount = 0;
    mockPiResolveCount = 0;
    mockPiSignals = [];
    installedTurnSignal = null;
    sessionClearCalls = [];
    let releaseFirst!: () => void;
    maySettle = new Promise<void>((resolveP) => {
      releaseFirst = resolveP;
    });
    const abortObserved = new Promise<void>((resolveP) => {
      abortObservedResolve = resolveP;
    });
    const secondEntered = new Promise<void>((resolveP) => {
      secondEnteredResolve = resolveP;
    });
    void runServeSubcommand({ portFile, bearerToken: bearer });
    const port = await pollForPort(portFile, 5000);
    assert.ok(port !== null, "server port-file must be ready within 5000ms");

    const authHeader = { Authorization: `Bearer ${bearer}` };

    mockPiMode = "abort-latched";
    const r1 = await udsReq({
      port,
      method: "POST",
      path: "/agent/turn",
      headers: authHeader,
      body: { prompt: "first" },
    });
    while (mockPiCallCount < 1) await new Promise((r) => setTimeout(r, 10));
    const firstSignal = mockPiSignals[0];
    mockPiMode = "hold";
    const r2 = await udsReq({
      port,
      method: "POST",
      path: "/agent/turn",
      headers: authHeader,
      body: { prompt: "second" },
    });
    await Promise.all([abortObserved, secondEntered]);
    const secondSignal = mockPiSignals[1];
    assert.equal(r2.status, 200, "replacement must be accepted");
    assert.notEqual(r2.body.turnId, r1.body.turnId, "replacement must get a new id");
    assert.equal(firstSignal?.aborted, true, "T1's exact signal must abort");
    assert.equal(installedTurnSignal, secondSignal, "T2 must install the session signal");

    releaseFirst();
    const deadline = Date.now() + 1000;
    while (!sessionClearCalls.includes(firstSignal) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(sessionClearCalls.includes(firstSignal), "T1's late finally must execute");
    assert.equal(installedTurnSignal, secondSignal, "late T1 clear must not erase T2");

    const abortSecond = await udsReq({ port, method: "POST", path: "/agent/abort", headers: authHeader });
    assert.equal(abortSecond.body.turnId, r2.body.turnId, "HTTP owner must still be T2");
    assert.equal(abortSecond.body.released, true, "T2 must release");
    assert.equal(secondSignal?.aborted, true, "abort must target T2's exact signal");
    assert.equal(mockPiCallCount, 2, "both turns must enter Pi");
    assert.equal(mockPiResolveCount, 2, "both turns must resolve Pi");

    process.env.FRONDOSE_HOME_BASE = origHome;
  });
});

// ─── T-Serve.10 — suggest_card / suggest_next_actions tool result → SSE + overlay ──

describe("runServeSubcommand — suggest_card / suggest_next_actions tool result → SSE + overlay callInOverlay (G-P57a.4)", () => {
  it("T-Serve.10: Pi onStepFinish composition emits suggestion-card and next-actions SSE", async () => {
    // Given: tmp UDS pattern; mockRunAgentLoop captures opts.onStepFinish into mockOnStepFinish;
    //        SSE listener opened BEFORE POST /agent/turn.
    // When:  POST /agent/turn → server invokes mocked runAgentLoop → mockOnStepFinish captured;
    //        test body invokes captured onStepFinish(step1) (suggest_card) then onStepFinish(step2)
    //        (suggest_next_actions); SSE collect.
    // Then:  SSE text contains data lines for both 'suggestion-card' + 'next-actions' frames
    //        with the matching payload fields.

    const tmpDir = mkdtempSync(join(tmpdir(), "mai-p57a-t10-"));
    const portFile = join(tmpDir, "frondose.port");
    const bearer = "tok";
    const origHome = process.env.FRONDOSE_HOME_BASE;
    process.env.FRONDOSE_HOME_BASE = tmpDir;
    mkdirSync(join(tmpDir, ".frondose", "agent"), { recursive: true });

    // mockRunAgentLoop captures onStepFinish + then resolves after 500ms (so we have
    // a window to invoke the captured callback before the server cleans up currentTurn).
    mockTurnSleepMs = 1000;
    mockPiMode = "sleep";
    mockOnStepFinish = null;

    void runServeSubcommand({ portFile, bearerToken: bearer });
    const port = await pollForPort(portFile, 5000);
    assert.ok(port !== null, "server port-file must be ready within 5000ms");

    const authHeader = { Authorization: `Bearer ${bearer}` };

    // Open SSE listener BEFORE firing the turn (concurrent collect)
    const ssePromise = udsSSECollect({ port, headers: authHeader, collectMs: 1500 });
    await new Promise((r) => setTimeout(r, 100)); // SSE handshake settle

    // POST /agent/turn → captures onStepFinish into mockOnStepFinish
    const r1 = await udsReq({
      port,
      method: "POST",
      path: "/agent/turn",
      headers: authHeader,
      body: { prompt: "trigger card" },
    });
    assert.equal(r1.status, 200, `(post-turn) expected 200 got ${r1.status}`);
    const turnId: string = r1.body.turnId;

    // Wait a beat for runAgentLoop to be invoked + capture onStepFinish
    await new Promise((r) => setTimeout(r, 100));
    // Snapshot mockOnStepFinish into a local so TS narrows the type past the null check
    const capturedOnStepFinish = mockOnStepFinish;
    assert.ok(capturedOnStepFinish !== null, "mockOnStepFinish must have been captured by mocked runAgentLoop");

    // Synthesize step 1 — suggest_card tool result
    const cardPayload = {
      ok: true,
      title: "John Doe — VP Engineering",
      icpMatch: { qualified: true, matched: ["role"], missing: [] },
      painChainHypothesis: "Pain hypothesis text",
    };
    const step1 = {
      toolCalls: [{ toolName: "suggest_card", toolCallId: "tc1" }],
      toolResults: [{ toolCallId: "tc1", toolName: "suggest_card", result: cardPayload }],
    };
    await capturedOnStepFinish(step1);

    // Synthesize step 2 — suggest_next_actions tool result
    const nextPayload = {
      ok: true,
      summary: "Recommended next actions",
      actions: [{ id: "a1", label: "Send message", prompt: "Send a connection request to John" }],
    };
    const step2 = {
      toolCalls: [{ toolName: "suggest_next_actions", toolCallId: "tc2" }],
      toolResults: [{ toolCallId: "tc2", toolName: "suggest_next_actions", result: nextPayload }],
    };
    await capturedOnStepFinish(step2);

    const sse = await ssePromise;
    assert.equal(sse.statusCode, 200, "SSE handshake should be 200");
    // suggestion-card SSE frame
    assert.ok(
      sse.text.includes('"type":"suggestion-card"'),
      `SSE must contain 'suggestion-card' frame; got: ${sse.text.slice(0, 500)}`,
    );
    assert.ok(sse.text.includes(`"turnId":"${turnId}"`), "SSE frame must carry the active turnId");
    assert.ok(sse.text.includes('"title":"John Doe'), "suggestion-card frame must carry the card.title payload");
    // next-actions SSE frame
    assert.ok(
      sse.text.includes('"type":"next-actions"'),
      `SSE must contain 'next-actions' frame; got: ${sse.text.slice(0, 500)}`,
    );
    assert.ok(
      sse.text.includes('"summary":"Recommended next actions"'),
      "next-actions frame must carry the nextActions.summary payload",
    );

    process.env.FRONDOSE_HOME_BASE = origHome;
  });
});

// ─── T-Serve.11 — POST /agent/activate → triggerAnalyzeProfile prompt ─────────

describe("runServeSubcommand — POST /agent/activate triggers analyzeProfile with locked prompt (G-P57a.5)", () => {
  it("T-Serve.11: POST /agent/activate queues the locked analyze-profile prompt into Pi", async () => {
    // Given: tmp UDS pattern; mockRunAgentLoop captures opts.messages
    // When:  (1) POST /agent/activate {} (no url) → 400 missing_url
    //        (2) POST /agent/activate {url:'https://www.linkedin.com/in/williamhgates/'} → 200+turnId
    //        (3) immediately POST /agent/activate {url:'...'} while #2 still running → 409 turn_in_progress
    // Then:  all 3 status codes correct;
    //        mockCapturedMessages last content contains locked prompt substring.

    const tmpDir = mkdtempSync(join(tmpdir(), "mai-p57a-t11-"));
    const portFile = join(tmpDir, "frondose.port");
    const bearer = "tok";
    const origHome = process.env.FRONDOSE_HOME_BASE;
    process.env.FRONDOSE_HOME_BASE = tmpDir;
    mkdirSync(join(tmpDir, ".frondose", "agent"), { recursive: true });

    // 500ms sleep gives time for #2→#3 overlap
    mockTurnSleepMs = 500;
    mockPiMode = "sleep";
    mockCapturedMessages = null;

    void runServeSubcommand({ portFile, bearerToken: bearer });
    const port = await pollForPort(portFile, 5000);
    assert.ok(port !== null, "server port-file must be ready within 5000ms");

    const authHeader = { Authorization: `Bearer ${bearer}` };

    // (1) Missing url → 400 missing_url
    const r1 = await udsReq({
      port,
      method: "POST",
      path: "/agent/activate",
      headers: authHeader,
      body: {},
    });
    assert.equal(r1.status, 400, `(r1) expected 400 got ${r1.status}: ${JSON.stringify(r1.body)}`);
    assert.equal(r1.body.ok, false, "(r1) ok must be false");
    assert.equal(r1.body.reason, "missing_url", "(r1) reason must be missing_url");

    // (2) Valid activate → 200 + turnId
    const targetUrl = "https://www.linkedin.com/in/williamhgates/";
    const r2 = await udsReq({
      port,
      method: "POST",
      path: "/agent/activate",
      headers: authHeader,
      body: { url: targetUrl },
    });
    assert.equal(r2.status, 200, `(r2) expected 200 got ${r2.status}: ${JSON.stringify(r2.body)}`);
    assert.equal(r2.body.ok, true, "(r2) ok must be true");
    assert.equal(r2.body.status, "queued", "(r2) status must be queued");
    const turnId2: string = r2.body.turnId;
    assert.ok(
      typeof turnId2 === "string" && /^[0-9a-f]{8}$/.test(turnId2),
      `(r2) turnId must be 8-char hex; got: ${String(turnId2)}`,
    );

    // (3) Concurrent activate while #2 sleeping → 409 turn_in_progress
    const r3 = await udsReq({
      port,
      method: "POST",
      path: "/agent/activate",
      headers: authHeader,
      body: { url: targetUrl },
    });
    assert.equal(r3.status, 409, `(r3) expected 409 got ${r3.status}: ${JSON.stringify(r3.body)}`);
    assert.equal(r3.body.ok, false, "(r3) ok must be false");
    assert.equal(r3.body.reason, "turn_in_progress", "(r3) reason must be turn_in_progress");

    // Wait briefly for runAgentLoop to capture messages
    await new Promise((r) => setTimeout(r, 200));
    // Snapshot to local so TS narrows past the null check
    const capturedMsgs = mockCapturedMessages;
    assert.ok(capturedMsgs !== null, "mockCapturedMessages must have been captured");
    assert.ok(
      Array.isArray(capturedMsgs) && capturedMsgs.length >= 1,
      "mockCapturedMessages must be a non-empty array",
    );
    // biome-ignore lint/suspicious/noExplicitAny: message shape varies; we just need .content
    const last = capturedMsgs[capturedMsgs.length - 1] as any;
    assert.ok(last && typeof last.content === "string", "last message must have string content");
    assert.ok(
      last.content.includes("Analyze this profile against the operator's ICP"),
      `last user message must contain locked triggerAnalyzeProfile prompt; got: ${last.content.slice(0, 200)}`,
    );
    // Sanity: prompt also includes the URL
    assert.ok(last.content.includes(targetUrl), "last user message must include the target URL");

    process.env.FRONDOSE_HOME_BASE = origHome;
  });
});

// ─── T-Serve.12 — POST /agent/cron-mode flips cronEnabled + emits SSE ────────

describe("runServeSubcommand — POST /agent/cron-mode flips cronEnabled flag + emits 'cron-mode' SSE (G-P57a.6)", () => {
  it("T-Serve.12: given tmp UDS sock + bearer 'tok' + open SSE listener, WHEN POST /agent/cron-mode {enabled:false} THEN response 200 {ok:true, cronEnabled:false} AND SSE stream receives {type:'cron-mode', cronEnabled:false} AND subsequent POST {enabled:true} flips back AND emits matching SSE", async () => {
    // Given: tmp UDS pattern; SSE listener opened BEFORE POST /agent/cron-mode.
    // When:  (1) POST {enabled:false} → 200; (2) POST {enabled:true} → 200; (3) POST {} → 400
    // Then:  SSE text contains both 'cron-mode cronEnabled:false' and 'cron-mode cronEnabled:true' frames.

    const tmpDir = mkdtempSync(join(tmpdir(), "mai-p57a-t12-"));
    const portFile = join(tmpDir, "frondose.port");
    const bearer = "tok";
    const origHome = process.env.FRONDOSE_HOME_BASE;
    process.env.FRONDOSE_HOME_BASE = tmpDir;
    mkdirSync(join(tmpDir, ".frondose", "agent"), { recursive: true });

    void runServeSubcommand({ portFile, bearerToken: bearer });
    const port = await pollForPort(portFile, 5000);
    assert.ok(port !== null, "server port-file must be ready within 5000ms");

    const authHeader = { Authorization: `Bearer ${bearer}` };

    // Open SSE listener BEFORE POSTs
    const ssePromise = udsSSECollect({ port, headers: authHeader, collectMs: 800 });
    await new Promise((r) => setTimeout(r, 100));

    // (1) POST {enabled:false} → 200 + cronEnabled:false
    const r1 = await udsReq({
      port,
      method: "POST",
      path: "/agent/cron-mode",
      headers: authHeader,
      body: { enabled: false },
    });
    assert.equal(r1.status, 200, `(r1) expected 200 got ${r1.status}: ${JSON.stringify(r1.body)}`);
    assert.equal(r1.body.ok, true, "(r1) ok must be true");
    assert.equal(r1.body.cronEnabled, false, "(r1) cronEnabled must be false");

    // (2) POST {enabled:true} → flips back
    const r2 = await udsReq({
      port,
      method: "POST",
      path: "/agent/cron-mode",
      headers: authHeader,
      body: { enabled: true },
    });
    assert.equal(r2.status, 200, `(r2) expected 200 got ${r2.status}: ${JSON.stringify(r2.body)}`);
    assert.equal(r2.body.ok, true, "(r2) ok must be true");
    assert.equal(r2.body.cronEnabled, true, "(r2) cronEnabled must be true");

    // (3) POST {} (no enabled field) → 400 missing_enabled
    const r3 = await udsReq({
      port,
      method: "POST",
      path: "/agent/cron-mode",
      headers: authHeader,
      body: {},
    });
    assert.equal(r3.status, 400, `(r3) expected 400 got ${r3.status}: ${JSON.stringify(r3.body)}`);
    assert.equal(r3.body.ok, false, "(r3) ok must be false");
    assert.equal(r3.body.reason, "missing_enabled", "(r3) reason must be missing_enabled");

    // SSE assertions
    const sse = await ssePromise;
    assert.equal(sse.statusCode, 200, "SSE handshake should be 200");
    assert.ok(
      sse.text.includes('"type":"cron-mode"') && sse.text.includes('"cronEnabled":false'),
      `SSE must contain cron-mode frame with cronEnabled:false; got: ${sse.text.slice(0, 500)}`,
    );
    assert.ok(
      sse.text.includes('"cronEnabled":true'),
      `SSE must contain cron-mode frame with cronEnabled:true; got: ${sse.text.slice(0, 500)}`,
    );

    process.env.FRONDOSE_HOME_BASE = origHome;
  });
});
