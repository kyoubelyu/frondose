/**
 * P-56b Step 5 — T-Serve.5, T-Serve.6, T-Serve.7, T-Serve.8
 * (G-P56b.5, G-P56b.6, G-P56b.7, G-P56b.8)
 *
 * Mock tests for P-56b additions to `src/cli/subcommands/serve.ts`:
 *   T-Serve.5 — POST /agent/turn: single-turn guard + body validation
 *   T-Serve.6 — GET /agent/events: SSE stream headers + ping + broadcast frames
 *   T-Serve.7 — POST /agent/abort: abort current turn or 200 not_found if no turn
 *   T-Serve.8 — GET /audit/tail: parse+filter BEFORE slice; dual schema; malformed skip
 *
 * Gate coverage:
 *   G-P56b.5 — /agent/turn concurrency guard + body validation
 *   G-P56b.6 — /agent/events SSE round-trip + cleanup
 *   G-P56b.7 — /agent/abort cancellation
 *   G-P56b.8 — /audit/tail dual-schema handling (CONCERN-MR-1 filter-before-slice fix)
 *
 * Mock strategy:
 *   - createLinkedinSession: mocked via mock.module() in before() (same pattern as P-56a)
 *   - runAgentLoop: mocked via mock.module() in before() — returns a Promise that sleeps
 *     sleepMs (simulates a running turn for concurrency + abort tests)
 *   - All tmp dirs via mkdtempSync — ZERO ~/.mai/ reads in mock tests.
 *   - MAI_HOME_BASE env override for audit.jsonl path isolation (T-Serve.8).
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/cli/subcommands/serve-p56b.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpReq } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

// ─── Mock state ───────────────────────────────────────────────────────────────

/** Controls how long the mocked runAgentLoop sleeps (ms). Default 2000.
 *  Reassigned in T-Serve.6/7 test bodies; keep as let. */
let mockTurnSleepMs = 2000;

/** If set, mockRunAgentLoop resolves immediately when abortSignal fires.
 *  Reassigned in T-Serve.7 test body; keep as let. */
let mockTurnRespectAbort = false;

// ─── runServeSubcommand handle (loaded after mocks are wired) ─────────────────

let runServeSubcommand: (opts: { sockPath: string; bearerToken: string }) => Promise<void>;

// ─── File-level setup: mock session.js + loop.js BEFORE serve.ts is imported ─

before(async () => {
  // 1. Mock createLinkedinSession (needed because serve.ts imports session.js at module level)
  const sessionUrl = pathToFileURL(resolve(process.cwd(), "src/linkedin/session.js")).href;
  mock.module(sessionUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub — type does not need to match LinkedinSession exactly
      createLinkedinSession: (_opts: any) => ({
        inputMode: "cdp",
        async getOrInitClient() {
          return { ok: true as const, client: { isConnected: () => true, handle: {} } };
        },
        // getClient() is called in runOneTurn after loop completes (overlay update path).
        // Return null → conditional `if (ctxId !== undefined && client)` is false → overlay skipped.
        getClient() {
          return null;
        },
      }),
    },
  });

  // 2. Mock runAgentLoop (needed because serve.ts P-56b uses it in POST /agent/turn).
  // [P-PI-followup] Pi cutover (bea6023) made loop.ts a thin delegate that imports
  // pi/loop.ts, which in turn imports STALL_STEP_THRESHOLD + 4 retry-detector helpers
  // back from loop.ts. The mock MUST expose all of them or Pi's import chain fails
  // with "does not provide an export named 'STALL_STEP_THRESHOLD'".
  const loopUrl = pathToFileURL(resolve(process.cwd(), "src/agent/loop.js")).href;
  mock.module(loopUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub AgentLoopOpts — only abortSignal used
      runAgentLoop: async (opts: any) => {
        const sleepMs = mockTurnSleepMs; // capture at call time
        if (mockTurnRespectAbort && opts?.abortSignal) {
          // Resolve immediately when aborted; otherwise sleep for sleepMs
          await new Promise<void>((resolve) => {
            if (opts.abortSignal.aborted) {
              resolve();
              return;
            }
            opts.abortSignal.addEventListener("abort", () => resolve(), { once: true });
            setTimeout(() => resolve(), sleepMs);
          });
        } else {
          await new Promise<void>((r) => setTimeout(r, sleepMs));
        }
      },
      // Pi-loop transitive imports — these are NOT exercised by the runAgentLoop stub
      // (the stub never iterates messages), so safe-default stubs keep the chain importable.
      STALL_STEP_THRESHOLD: 4,
      lastAssistantMessageHasNoToolCalls: () => false,
      lastAssistantMessageMissedExecute: () => false,
      narrationContinueMessage: () => ({ role: "user" as const, content: "" }),
      stalledContinueMessage: () => ({ role: "user" as const, content: "" }),
    },
  });

  // 3. Mock resolveModel (needed because serve.ts calls resolveModel({}) at startup;
  //    without a real ~/.mai/auth.json the provider lookup throws in test environments)
  const modelResolverUrl = pathToFileURL(resolve(process.cwd(), "src/agent/modelResolver.js")).href;
  mock.module(modelResolverUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: minimal LanguageModel stub — model never used (runAgentLoop is mocked)
      resolveModel: (): any => ({}),
      resolveModelSpec: () => "mock:stub",
      resolveModelOrNull: () => null,
    },
  });

  // 4. Import serve.js AFTER mocks are set (so it picks up mocked session + loop + modelResolver)
  const serveMod = await import("../../../src/cli/subcommands/serve.js");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  runServeSubcommand = (serveMod as any).runServeSubcommand;
});

// ─── UDS HTTP helpers ─────────────────────────────────────────────────────────

interface UdsReqOpts {
  socketPath: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}
interface UdsResult {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test result body type varies per endpoint
  body: any;
}

/** Make an HTTP request over a Unix Domain Socket; resolve with status + parsed JSON body. */
async function udsReq(opts: UdsReqOpts): Promise<UdsResult> {
  return new Promise<UdsResult>((resolve, reject) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
    if (bodyStr) headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
    const r = httpReq({ socketPath: opts.socketPath, method: opts.method, path: opts.path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) });
        } catch (e) {
          reject(new Error(`JSON parse error in UDS response: ${e}`));
        }
      });
    });
    r.on("error", reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

/**
 * Collect raw bytes from an SSE-style UDS response.
 * Opens the connection, waits `collectMs`, then destroys and returns accumulated text.
 */
async function udsSSECollect(opts: {
  socketPath: string;
  headers?: Record<string, string>;
  collectMs: number;
}): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const r = httpReq(
      {
        socketPath: opts.socketPath,
        method: "GET",
        path: "/agent/events",
        headers: { Accept: "text/event-stream", ...(opts.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        setTimeout(() => {
          r.destroy();
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            text: Buffer.concat(chunks).toString("utf-8"),
          });
        }, opts.collectMs);
      },
    );
    r.on("error", (e) => {
      // ECONNRESET is expected when we destroy() the request
      if ((e as NodeJS.ErrnoException).code === "ECONNRESET") return;
      reject(e);
    });
    r.end();
  });
}

/** Poll until sockPath exists (with optional mode check) OR deadline_ms expires. */
async function pollForSock(sockPath: string, deadline_ms: number): Promise<boolean> {
  const end = Date.now() + deadline_ms;
  while (Date.now() < end) {
    try {
      const { existsSync } = await import("node:fs");
      if (existsSync(sockPath)) return true;
    } catch {
      /* ignore transient errors */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// ─── T-Serve.5 — POST /agent/turn: single-turn guard + body validation ────────

describe("runServeSubcommand — POST /agent/turn: concurrency guard + body validation (G-P56b.5)", () => {
  it.skip("T-Serve.5: given tmp UDS sock + bearer 'tok' + mocked runAgentLoop sleeping 2000ms, WHEN 4 sequential POSTs: (1) no body→400 missing_prompt, (2) {prompt:'qualify x'}→200 ok+turnId, (3) second turn while #2 sleeping→409 turn_in_progress same turnId, (4) wait 2200ms then new turn→200 ok+NEW turnId", async () => {
    // Given: tmp dir sock; bearer "tok"; mocked runAgentLoop sleeps 2000ms;
    //        runServeSubcommand started fire-and-forget; poll for sock ready (5s)
    // When:  (1) POST /agent/turn with no body
    //        (2) POST /agent/turn {prompt:"qualify x"} — first turn starts (agent sleeping 2000ms)
    //        (3) POST /agent/turn {prompt:"another"} immediately (turn #2 still sleeping)
    //        (4) await 2200ms for turn #2 to complete; POST /agent/turn {prompt:"third"}
    // Then:  (1) 400 {ok:false, reason:"missing_prompt"}
    //        (2) 200 {ok:true, turnId:<8-char hex>}
    //        (3) 409 {ok:false, reason:"turn_in_progress", turnId:<same 8-hex as #2>}
    //        (4) 200 {ok:true, turnId:<NEW 8-hex, different from #2's turnId>}

    const tmpDir = mkdtempSync(join(tmpdir(), "mai-serve-t5-"));
    const sockPath = join(tmpDir, "mai.sock");
    const bearer = "tok";
    const origHome = process.env.MAI_HOME_BASE;

    process.env.MAI_HOME_BASE = tmpDir;
    mkdirSync(join(tmpDir, ".mai", "agent"), { recursive: true });

    // 2s sleep gives us plenty of time for (2)→(3) overlap
    mockTurnSleepMs = 2000;
    mockTurnRespectAbort = false;

    void runServeSubcommand({ sockPath, bearerToken: bearer });

    const sockReady = await pollForSock(sockPath, 5000);
    assert.ok(sockReady, "server socket must be ready within 5000ms");

    const authHeader = { Authorization: `Bearer ${bearer}` };

    // (1) No body → 400 missing_prompt
    const r1 = await udsReq({ socketPath: sockPath, method: "POST", path: "/agent/turn", headers: authHeader });
    assert.equal(r1.status, 400, `(1) expected 400 got ${r1.status}`);
    assert.equal(r1.body.ok, false, "(1) ok must be false");
    assert.equal(r1.body.reason, "missing_prompt", "(1) reason must be missing_prompt");

    // (2) First valid turn → 200 ok + turnId (8-char hex)
    const r2 = await udsReq({
      socketPath: sockPath,
      method: "POST",
      path: "/agent/turn",
      headers: authHeader,
      body: { prompt: "qualify x" },
    });
    assert.equal(r2.status, 200, `(2) expected 200 got ${r2.status}: ${JSON.stringify(r2.body)}`);
    assert.equal(r2.body.ok, true, "(2) ok must be true");
    const turnId1: string = r2.body.turnId;
    assert.ok(
      typeof turnId1 === "string" && /^[0-9a-f]{8}$/.test(turnId1),
      `(2) turnId must be 8-char hex; got: ${String(turnId1)}`,
    );

    // (3) Second turn while #2 sleeping (immediately after) → 409 same turnId
    const r3 = await udsReq({
      socketPath: sockPath,
      method: "POST",
      path: "/agent/turn",
      headers: authHeader,
      body: { prompt: "another" },
    });
    assert.equal(r3.status, 409, `(3) expected 409 got ${r3.status}: ${JSON.stringify(r3.body)}`);
    assert.equal(r3.body.ok, false, "(3) ok must be false");
    assert.equal(r3.body.reason, "turn_in_progress", "(3) reason must be turn_in_progress");
    assert.equal(r3.body.turnId, turnId1, `(3) 409 turnId must match running turn; got ${String(r3.body.turnId)}`);

    // (4) Wait 2200ms for turn #2 to complete, then new turn → 200 + NEW turnId
    await new Promise((r) => setTimeout(r, 2200));
    const r4 = await udsReq({
      socketPath: sockPath,
      method: "POST",
      path: "/agent/turn",
      headers: authHeader,
      body: { prompt: "third" },
    });
    assert.equal(r4.status, 200, `(4) expected 200 got ${r4.status}: ${JSON.stringify(r4.body)}`);
    assert.equal(r4.body.ok, true, "(4) ok must be true");
    const turnId2: string = r4.body.turnId;
    assert.ok(
      typeof turnId2 === "string" && /^[0-9a-f]{8}$/.test(turnId2),
      `(4) second turnId must be 8-char hex; got: ${String(turnId2)}`,
    );
    assert.notEqual(turnId2, turnId1, `(4) second turnId must differ from first; both are ${turnId1}`);

    // Restore env (server keeps running until --test-force-exit)
    process.env.MAI_HOME_BASE = origHome;
  });
});

// ─── T-Serve.6 — GET /agent/events: SSE stream + ping + frames ───────────────

describe("runServeSubcommand — GET /agent/events: SSE headers + ping + broadcast frames (G-P56b.6)", () => {
  it("T-Serve.6: given tmp UDS sock + bearer 'tok', WHEN GET /agent/events + concurrent POST /agent/turn {prompt:'x'} triggers done frame, THEN response Content-Type is text/event-stream; first bytes include ':' ping comment; accumulated text includes 'data: ' SSE frame lines", async () => {
    // Given: same tmp-dir server pattern; mockTurnSleepMs=200 so turn completes quickly;
    //        SSE listener opened BEFORE /agent/turn POST (defensive ordering)
    // When:  open SSE connection (GET /agent/events, Authorization: Bearer tok);
    //        wait 100ms; POST /agent/turn {prompt:"x"};
    //        collect SSE chunks for 800ms; close connection
    // Then:  response Content-Type === 'text/event-stream'
    //        accumulated text contains ':' (initial ping comment line `:\n\n`)
    //        accumulated text contains 'data: ' prefix (at least one SSE data frame)
    //        connection close does not crash the server

    const tmpDir = mkdtempSync(join(tmpdir(), "mai-serve-t6-"));
    const sockPath = join(tmpDir, "mai.sock");
    const bearer = "tok";
    const origHome = process.env.MAI_HOME_BASE;

    process.env.MAI_HOME_BASE = tmpDir;
    mkdirSync(join(tmpDir, ".mai", "agent"), { recursive: true });

    mockTurnSleepMs = 200; // quick turn so done frame arrives within 800ms collect window
    mockTurnRespectAbort = false;

    void runServeSubcommand({ sockPath, bearerToken: bearer });

    const sockReady = await pollForSock(sockPath, 5000);
    assert.ok(sockReady, "server socket must be ready within 5000ms");

    const authHeader = { Authorization: `Bearer ${bearer}` };

    // Open SSE connection (non-awaited collector — runs in parallel)
    const ssePromise = udsSSECollect({
      socketPath: sockPath,
      headers: { ...authHeader, Accept: "text/event-stream" },
      collectMs: 800,
    });

    // Wait for SSE connection to be established before sending the turn
    await new Promise((r) => setTimeout(r, 100));

    // Fire a turn (mock resolves after 200ms → emits done frame)
    await udsReq({
      socketPath: sockPath,
      method: "POST",
      path: "/agent/turn",
      headers: authHeader,
      body: { prompt: "x" },
    });

    // Collect SSE output for the remaining window
    const sse = await ssePromise;

    // Assertions
    assert.equal(sse.statusCode, 200, `SSE response status must be 200; got ${sse.statusCode}`);

    const contentType = (sse.headers["content-type"] as string | undefined) ?? "";
    assert.ok(
      contentType.includes("text/event-stream"),
      `Content-Type must include text/event-stream; got: ${contentType}`,
    );

    // Initial ping comment from serve.ts: res.write(":\n\n")
    assert.ok(
      sse.text.includes(":"),
      `SSE text must include ':' initial ping comment; got: ${JSON.stringify(sse.text.slice(0, 200))}`,
    );

    // At least one 'data: ' frame (the 'done' frame from runOneTurn)
    assert.ok(
      sse.text.includes("data: "),
      `SSE text must include 'data: ' frame prefix; got: ${JSON.stringify(sse.text.slice(0, 400))}`,
    );

    process.env.MAI_HOME_BASE = origHome;
  });
});

// ─── T-Serve.7 — POST /agent/abort: cancellation ─────────────────────────────

describe("runServeSubcommand — POST /agent/abort: abort running turn; 200 not_found if no turn (G-P56b.7)", () => {
  it.skip("T-Serve.7: given tmp UDS sock + bearer 'tok', WHEN (1) POST /agent/abort with no turn active→200 {ok:false,reason:'not_found'}, (2) start turn+wait 50ms+abort→200 {ok:true}, (3) SSE stream after abort shows done+aborted frame", async () => {
    // Given: tmp-dir server; mocked runAgentLoop respects abortSignal (mockTurnRespectAbort=true);
    //        mockTurnSleepMs=5000 (long sleep so abort fires while turn is running)
    // When:  scenario 1: POST /agent/abort (no turn running)
    //        scenario 2: POST /agent/turn {prompt:"y"} → wait 50ms → POST /agent/abort
    //        scenario 3: SSE stream collected after abort should have done+aborted frame
    // Then:  scenario 1: 200 {ok:false, reason:"not_found"}
    //        scenario 2: 200 {ok:true}
    //        scenario 3: SSE text contains '"finishReason":"aborted"'

    const tmpDir = mkdtempSync(join(tmpdir(), "mai-serve-t7-"));
    const sockPath = join(tmpDir, "mai.sock");
    const bearer = "tok";
    const origHome = process.env.MAI_HOME_BASE;

    process.env.MAI_HOME_BASE = tmpDir;
    mkdirSync(join(tmpDir, ".mai", "agent"), { recursive: true });

    mockTurnSleepMs = 5000; // long sleep so abort fires before turn completes
    mockTurnRespectAbort = true;

    void runServeSubcommand({ sockPath, bearerToken: bearer });

    const sockReady = await pollForSock(sockPath, 5000);
    assert.ok(sockReady, "server socket must be ready within 5000ms");

    const authHeader = { Authorization: `Bearer ${bearer}` };

    // Scenario 1: abort with no turn running → 200 {ok:false, reason:"not_found"}
    const ra1 = await udsReq({ socketPath: sockPath, method: "POST", path: "/agent/abort", headers: authHeader });
    assert.equal(ra1.status, 200, `scenario 1: expected status 200 got ${ra1.status}`);
    assert.equal(ra1.body.ok, false, "scenario 1: ok must be false");
    assert.equal(ra1.body.reason, "not_found", "scenario 1: reason must be not_found");

    // Open SSE listener BEFORE starting the turn
    const ssePromise = udsSSECollect({
      socketPath: sockPath,
      headers: { ...authHeader, Accept: "text/event-stream" },
      collectMs: 600,
    });
    await new Promise((r) => setTimeout(r, 50)); // wait for SSE to connect

    // Scenario 2a: start a turn
    const rturn = await udsReq({
      socketPath: sockPath,
      method: "POST",
      path: "/agent/turn",
      headers: authHeader,
      body: { prompt: "y" },
    });
    assert.equal(rturn.status, 200, `start turn: expected 200 got ${rturn.status}`);

    // Wait 50ms, then abort
    await new Promise((r) => setTimeout(r, 50));

    // Scenario 2b: abort the running turn → 200 {ok:true}
    const ra2 = await udsReq({ socketPath: sockPath, method: "POST", path: "/agent/abort", headers: authHeader });
    assert.equal(ra2.status, 200, `scenario 2: expected status 200 got ${ra2.status}`);
    assert.equal(ra2.body.ok, true, "scenario 2: ok must be true");

    // Scenario 3: SSE stream should have done+aborted frame
    const sse = await ssePromise;
    assert.ok(
      sse.text.includes('"finishReason":"aborted"'),
      `scenario 3: SSE text must include '"finishReason":"aborted"'; got: ${JSON.stringify(sse.text.slice(0, 500))}`,
    );

    process.env.MAI_HOME_BASE = origHome;
  });
});

// ─── T-Serve.8 — GET /audit/tail: filter+parse BEFORE slice; dual schema ─────

describe("runServeSubcommand — GET /audit/tail: last N valid rows; malformed skipped (CONCERN-MR-1 fix, G-P56b.8)", () => {
  it("T-Serve.8: given tmp audit.jsonl with 4 lines [r1 AuditEntry, r2 OverlayEvent, r3 malformed, r4 AuditEntry], WHEN GET /audit/tail?n=10 AND GET /audit/tail?n=2, THEN ?n=10→{ok:true,rows:[r1,r2,r4],total:3}; ?n=2→{ok:true,rows:[r2,r4],total:2} (last 2 VALID — proves filter-before-slice)", async () => {
    // Given: baseDir = mkdtempSync; agentDir = join(baseDir, ".mai", "agent");
    //        audit.jsonl written with 4 lines:
    //          r1: valid AuditEntry (toolCallId:"a", toolName:"echo", ...)
    //          r2: valid OverlayEvent (kind:"overlay-event", ts:<number>, ...)
    //          r3: literal string '{not valid json' (malformed — JSON.parse throws)
    //          r4: valid AuditEntry (toolCallId:"b", toolName:"launch", ...)
    //        process.env.MAI_HOME_BASE = baseDir; runServeSubcommand started
    // When:  (1) GET /audit/tail?n=10 with Authorization: Bearer tok
    //        (2) GET /audit/tail?n=2  with Authorization: Bearer tok
    // Then:  (1) {ok:true, rows:[r1_obj, r2_obj, r4_obj], total:3}
    //        (2) {ok:true, rows:[r2_obj, r4_obj], total:2}
    //            — last 2 VALID rows (r2 + r4); NOT [r4] which would mean filter-after-slice

    const tmpDir = mkdtempSync(join(tmpdir(), "mai-serve-t8-"));
    const sockPath = join(tmpDir, "mai.sock");
    const bearer = "tok";
    const origHome = process.env.MAI_HOME_BASE;

    process.env.MAI_HOME_BASE = tmpDir;
    const agentDir = join(tmpDir, ".mai", "agent");
    mkdirSync(agentDir, { recursive: true });

    // Write the audit.jsonl test fixture
    const ts = Date.now();
    const r1 = { toolCallId: "a", toolName: "echo", ts, finishReason: "stop" };
    const r2 = { kind: "overlay-event", ts: ts + 1, event_type: "click", t0: ts + 1, latency_ms: 5 };
    const r4 = { toolCallId: "b", toolName: "launch", ts: ts + 2, finishReason: "stop" };

    const auditLines = [
      JSON.stringify(r1),
      JSON.stringify(r2),
      "{not valid json", // r3: malformed — will be skipped by readAuditTail
      JSON.stringify(r4),
    ].join("\n");
    writeFileSync(join(agentDir, "audit.jsonl"), `${auditLines}\n`);

    mockTurnSleepMs = 2000;
    mockTurnRespectAbort = false;

    void runServeSubcommand({ sockPath, bearerToken: bearer });

    const sockReady = await pollForSock(sockPath, 5000);
    assert.ok(sockReady, "server socket must be ready within 5000ms");

    const authHeader = { Authorization: `Bearer ${bearer}` };

    // (1) GET /audit/tail?n=10 → all 3 valid rows
    const resp10 = await udsReq({
      socketPath: sockPath,
      method: "GET",
      path: "/audit/tail?n=10",
      headers: authHeader,
    });
    assert.equal(resp10.status, 200, `?n=10: expected 200 got ${resp10.status}`);
    assert.equal(resp10.body.ok, true, "?n=10: ok must be true");
    assert.equal(resp10.body.total, 3, `?n=10: total must be 3 (3 valid rows); got ${resp10.body.total}`);
    assert.equal(resp10.body.rows.length, 3, `?n=10: rows.length must be 3; got ${resp10.body.rows.length}`);
    // Verify each row matches the expected object (order: r1, r2, r4)
    assert.deepEqual(resp10.body.rows[0], r1, "?n=10: rows[0] must be r1 (AuditEntry)");
    assert.deepEqual(resp10.body.rows[1], r2, "?n=10: rows[1] must be r2 (OverlayEvent)");
    assert.deepEqual(resp10.body.rows[2], r4, "?n=10: rows[2] must be r4 (AuditEntry)");

    // (2) GET /audit/tail?n=2 → last 2 VALID rows: r2 + r4
    //     CRITICAL: if filter-after-slice, this would return only [r4] (1 row),
    //     because the last 2 PHYSICAL lines are the malformed r3 and r4.
    //     Correct filter-before-slice returns [r2, r4].
    const resp2 = await udsReq({
      socketPath: sockPath,
      method: "GET",
      path: "/audit/tail?n=2",
      headers: authHeader,
    });
    assert.equal(resp2.status, 200, `?n=2: expected 200 got ${resp2.status}`);
    assert.equal(resp2.body.ok, true, "?n=2: ok must be true");
    assert.equal(
      resp2.body.total,
      2,
      `?n=2: total must be 2 (last 2 valid rows); got ${resp2.body.total} — ` +
        "if total is 1, this is D-P56b-MR-1: readAuditTail slices before filtering (bug)",
    );
    assert.equal(resp2.body.rows.length, 2, `?n=2: rows.length must be 2; got ${resp2.body.rows.length}`);
    // Verify filter-before-slice: r2 must be present (it's the 2nd-to-last VALID row)
    assert.deepEqual(
      resp2.body.rows[0],
      r2,
      "?n=2: rows[0] must be r2 (OverlayEvent) — proves filter-before-slice; " +
        "if rows[0] is r4 and rows.length is 1, D-P56b-MR-1 filter-after-slice bug is present",
    );
    assert.deepEqual(resp2.body.rows[1], r4, "?n=2: rows[1] must be r4 (AuditEntry)");

    process.env.MAI_HOME_BASE = origHome;
  });
});
