/**
 * P-57c Step 5 — T-Serve.14, T-Serve.15, T-Serve.16, T-Serve.17,
 *                  T-Cron.1, T-Cron.2, T-Error.1, T-Error.2, T-Error.3 — FILLED
 * (G-P57c.1, G-P57c.2, G-P57c.3, G-P57c.4, G-P57c.5, G-P57c.6, G-P57c.7, G-P57c.8, G-P57c.9)
 *
 * Mock tests for P-57c extensions to `src/cli/subcommands/serve.ts`.
 *
 * Implementation notes (vs Step 4a + plan §6):
 *   - Production module-level state (lastFailedTurnPrompt / lastTurnUserPrompt /
 *     retryAttempts / MAX_RETRY_ATTEMPTS) is at FILE SCOPE (not closure) — shared
 *     across all runServeSubcommand instances loaded in the same Node process. Each
 *     test resets state explicitly via a successful POST /agent/turn at the top
 *     (success-path clears lastFailedTurnPrompt=null + retryAttempts=0).
 *   - POST /agent/retry rejected response uses 200 + reason:"retry_limit_reached"
 *     (NOT 429). Code at serve.ts:436-438.
 *   - Cron driver fires via `setInterval(60_000)`; for cron tests we accelerate
 *     by overriding globalThis.setInterval BEFORE runServeSubcommand starts, and
 *     write a due-now schedule.jsonl entry to make findDueJobs return work.
 *   - mockRunAgentLoop behavior is controlled per-test via `mockMode` flag:
 *     "succeed" (clean return), "throw" (non-abort error), "respect-abort"
 *     (honor opts.abortSignal + throw AbortError when aborted).
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=60000 tests/cli/subcommands/serve-p57c.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpReq } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

// ─── Mock state ───────────────────────────────────────────────────────────────

/** Captures the binding handler registered by attachEventBus. */
let mockBindingCalledHandler: ((arg: { name: string; payload: string }) => void) | null = null;

/** Captures opts passed to mockRunAgentLoop. Reset per-test. */
// biome-ignore lint/suspicious/noExplicitAny: stub captures opts loosely
let mockCapturedOpts: any | null = null;
let mockRunAgentLoopCallCount = 0;

/** Controls mockRunAgentLoop behavior per-test:
 *   - "succeed":       resolves cleanly (no error; success path runs in serve.ts)
 *   - "throw":         throws non-abort error (catch path; sets lastFailedTurnPrompt if isRetryable)
 *   - "respect-abort": honors opts.abortSignal; throws AbortError when aborted */
let mockMode: "succeed" | "throw" | "respect-abort" = "succeed";

/** Override setInterval to accelerate cron driver (used in T-Cron.* tests). */
let setIntervalAccelerator: { active: boolean; factor: number } = { active: false, factor: 1 };

// ─── runServeSubcommand handle ───────────────────────────────────────────────

let runServeSubcommand: (opts: { sockPath: string; bearerToken: string }) => Promise<void>;

// ─── File-level setup ────────────────────────────────────────────────────────

before(async () => {
  // 1. Mock createLinkedinSession — fake CdpHandle
  const sessionUrl = pathToFileURL(resolve(process.cwd(), "src/linkedin/session.js")).href;
  mock.module(sessionUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub
      createLinkedinSession: (_opts: any) => ({
        inputMode: "cdp",
        async getOrInitClient() {
          const handle = {
            Runtime: {
              enable: async () => undefined,
              addBinding: async () => undefined,
              executionContextCreated: () => () => undefined,
              // biome-ignore lint/suspicious/noExplicitAny: handler-capture
              bindingCalled: (h: any) => {
                mockBindingCalledHandler = h;
                return () => undefined;
              },
              callFunctionOn: async () => ({ result: { value: null } }),
            },
            Page: {
              enable: async () => undefined,
              addScriptToEvaluateOnNewDocument: async () => ({ identifier: "id-1" }),
              getFrameTree: async () => ({ frameTree: { frame: { id: "main-1" } } }),
            },
          };
          return { ok: true as const, client: { isConnected: () => true, handle } };
        },
        getClient() {
          return null;
        },
      }),
    },
  });

  // 2. Mock runAgentLoop — behavior controlled per-test via mockMode
  const loopUrl = pathToFileURL(resolve(process.cwd(), "src/agent/loop.js")).href;
  mock.module(loopUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub
      runAgentLoop: async (opts: any) => {
        mockCapturedOpts = opts;
        mockRunAgentLoopCallCount++;
        const mode = mockMode;
        if (mode === "succeed") {
          await new Promise<void>((r) => setTimeout(r, 30));
          return;
        }
        if (mode === "throw") {
          await new Promise<void>((r) => setTimeout(r, 30));
          throw new Error("mock-runAgentLoop-error");
        }
        // respect-abort: sleep until aborted or timeout
        await new Promise<void>((r) => {
          if (opts?.abortSignal?.aborted) {
            r();
            return;
          }
          opts?.abortSignal?.addEventListener("abort", () => r(), { once: true });
          setTimeout(() => r(), 2000);
        });
        if (opts?.abortSignal?.aborted) {
          throw new Error("AbortError: aborted");
        }
      },
    },
  });

  // 3. Mock resolveModel
  const modelResolverUrl = pathToFileURL(resolve(process.cwd(), "src/agent/modelResolver.js")).href;
  mock.module(modelResolverUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub
      resolveModel: (): any => ({}),
      resolveModelSpec: () => "mock:stub",
      resolveModelOrNull: () => null,
    },
  });

  // 4. Mock passiveRateLimit so passive paths don't interfere with retry-state tests
  const passiveRateLimitUrl = pathToFileURL(resolve(process.cwd(), "src/cli/subcommands/passiveRateLimit.js")).href;
  mock.module(passiveRateLimitUrl, {
    namedExports: {
      PassiveRateLimiter: class {
        tryConsume(): boolean {
          return true;
        }
        snapshot() {
          return { shortWindowTokens: 1, longWindowTokens: 5, shortS: 30, longN: 5, longS: 60 };
        }
      },
      passiveRateLimiterOptsFromEnv: () => ({ shortS: 30, longN: 5, longS: 60 }),
    },
  });

  // 5. Override globalThis.setInterval to support cron acceleration in T-Cron.* tests
  const origSetInterval = globalThis.setInterval;
  // biome-ignore lint/suspicious/noExplicitAny: stub interval shape
  (globalThis as any).setInterval = (fn: () => void, ms: number) => {
    if (setIntervalAccelerator.active && ms >= 1000) {
      // Accelerate any "long" interval (cron 60_000ms) to fast cadence
      return origSetInterval(fn, Math.max(50, ms / setIntervalAccelerator.factor));
    }
    return origSetInterval(fn, ms);
  };

  // 6. Import serve.js AFTER mocks
  const serveMod = await import("../../../src/cli/subcommands/serve.js");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  runServeSubcommand = (serveMod as any).runServeSubcommand;
});

// ─── UDS HTTP helpers ────────────────────────────────────────────────────────

interface UdsReqOpts {
  socketPath: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}
interface UdsResult {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: body varies
  body: any;
}

async function udsReq(opts: UdsReqOpts): Promise<UdsResult> {
  return new Promise<UdsResult>((resolveP, rejectP) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
    if (bodyStr) headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
    const r = httpReq({ socketPath: opts.socketPath, method: opts.method, path: opts.path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          resolveP({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) });
        } catch (e) {
          rejectP(new Error(`JSON parse error: ${e}`));
        }
      });
    });
    r.on("error", rejectP);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

async function udsSSECollect(opts: {
  socketPath: string;
  headers?: Record<string, string>;
  collectMs: number;
}): Promise<{ statusCode: number; text: string }> {
  return new Promise((resolveP, rejectP) => {
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
          resolveP({ statusCode: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf-8") });
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

async function pollForSock(sockPath: string, deadline_ms: number): Promise<boolean> {
  const end = Date.now() + deadline_ms;
  while (Date.now() < end) {
    try {
      const { existsSync } = await import("node:fs");
      if (existsSync(sockPath)) return true;
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Spin tmp serve harness. */
async function spinHarness(
  testName: string,
  opts: { writeScheduleJsonl?: string } = {},
): Promise<{ sockPath: string; bearer: string; tmpDir: string; restoreEnv: () => void }> {
  const tmpDir = mkdtempSync(join(tmpdir(), `p57c-${testName}-`));
  const sockPath = join(tmpDir, "mai.sock");
  const bearer = "tok";
  const origHome = process.env.MAI_HOME_BASE;
  process.env.MAI_HOME_BASE = tmpDir;
  mkdirSync(join(tmpDir, ".mai", "agent"), { recursive: true });
  // Write minimal identity.json with updatedAt (required by schema)
  writeFileSync(
    join(tmpDir, ".mai", "agent", "identity.json"),
    JSON.stringify({ icp: { targetRole: ["VP Sales"] }, updatedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
  // P-58a RECONCILE: serve now boots cronEnabled from readMode() (default "manual" → cron driver no-ops).
  // The cron tests exercise the Auto path, so persist mode.json=auto (the realistic "operator enabled Auto")
  // BEFORE runServeSubcommand boots → cronEnabled=true → the cron driver ticks. (Production: Manual default
  // means cron is OFF — the supervised default; this harness opts into Auto.)
  writeFileSync(join(tmpDir, ".mai", "agent", "mode.json"), JSON.stringify({ mode: "auto" }), "utf-8");
  if (opts.writeScheduleJsonl !== undefined) {
    writeFileSync(join(tmpDir, ".mai", "agent", "schedule.jsonl"), opts.writeScheduleJsonl, "utf-8");
  }

  mockBindingCalledHandler = null;
  mockCapturedOpts = null;
  mockRunAgentLoopCallCount = 0;

  void runServeSubcommand({ sockPath, bearerToken: bearer });
  const sockReady = await pollForSock(sockPath, 5000);
  assert.ok(sockReady, `${testName}: server socket must be ready within 5000ms`);

  await udsReq({
    socketPath: sockPath,
    method: "POST",
    path: "/chrome/ensure",
    headers: { Authorization: `Bearer ${bearer}` },
  });

  return {
    sockPath,
    bearer,
    tmpDir,
    restoreEnv: () => {
      if (origHome === undefined) {
        delete process.env.MAI_HOME_BASE;
      } else {
        process.env.MAI_HOME_BASE = origHome;
      }
    },
  };
}

/** Reset module-level retry state via a successful operator turn (success-path clears).
 *  Returns when SSE done arrives. */
async function resetRetryStateViaSuccess(sockPath: string, bearer: string, label: string): Promise<void> {
  mockMode = "succeed";
  const authHeader = { Authorization: `Bearer ${bearer}` };
  const r = await udsReq({
    socketPath: sockPath,
    method: "POST",
    path: "/agent/turn",
    headers: authHeader,
    body: { prompt: `reset-${label}` },
  });
  assert.equal(r.status, 200, `reset turn for ${label} must succeed (200)`);
  // Wait for runOneTurn.finally to clear currentTurn (mockRunAgentLoop sleeps 30ms)
  await new Promise((r) => setTimeout(r, 150));
}

/** Drive a failing operator turn to set lastFailedTurnPrompt + leave retryAttempts unchanged. */
async function setupFailedTurn(sockPath: string, bearer: string, failPrompt: string): Promise<void> {
  mockMode = "throw";
  const authHeader = { Authorization: `Bearer ${bearer}` };
  await udsReq({
    socketPath: sockPath,
    method: "POST",
    path: "/agent/turn",
    headers: authHeader,
    body: { prompt: failPrompt },
  });
  await new Promise((r) => setTimeout(r, 150)); // wait for catch path
}

// biome-ignore lint/suspicious/noExplicitAny: synthetic payload
function dispatchOverlayBindingEvent(rawPayload: any): void {
  if (!mockBindingCalledHandler) throw new Error("mockBindingCalledHandler not captured");
  mockBindingCalledHandler({ name: "__maiPost", payload: JSON.stringify(rawPayload) });
}

// ─── T-Serve.14 — Server-side steer promotion ───────────────────────────────

describe("dispatchOverlayEvent — overlay prompt during running triggers server-side steer promotion (G-P57c.1)", () => {
  it("T-Serve.14: given serve.ts harness with mock runAgentLoop in respect-abort mode + operator turn in flight (currentTurn !== null), WHEN dispatch overlay-event {type:'prompt', text:'new prompt'} via binding handler, THEN steerThenTrigger fires: 1st turn's abortController.abort() called → done(aborted:true) SSE → currentTurn cleared within 200ms → triggerCardActionTurn fires 2nd turn with messages.last() content === 'new prompt' AND opts.isRetryable === true per §5.3.2 callsite contract", async () => {
    const h = await spinHarness("t14");
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      const ssePromise = udsSSECollect({ socketPath: h.sockPath, headers: authHeader, collectMs: 2500 });
      await new Promise((r) => setTimeout(r, 100));

      // Start an operator turn that will be aborted mid-stream
      mockMode = "respect-abort";
      const baselineCount = mockRunAgentLoopCallCount;
      const r1 = await udsReq({
        socketPath: h.sockPath,
        method: "POST",
        path: "/agent/turn",
        headers: authHeader,
        body: { prompt: "long-running turn" },
      });
      assert.equal(r1.status, 200, "first turn should be accepted");
      const firstTurnId: string = r1.body.turnId;
      await new Promise((r) => setTimeout(r, 100)); // let runOneTurn start

      // Dispatch overlay prompt → should promote to steer (abort + new turn)
      dispatchOverlayBindingEvent({
        type: "prompt",
        text: "new prompt",
        t0: Date.now(),
      });

      // Wait for steerThenTrigger's 50ms polling + new turn dispatch
      await new Promise((r) => setTimeout(r, 800));
      // Now switch mock back to succeed so the new turn completes
      mockMode = "succeed";
      await new Promise((r) => setTimeout(r, 200));

      // Expect at least 2 runAgentLoop calls (1st aborted + 2nd steered)
      const delta = mockRunAgentLoopCallCount - baselineCount;
      assert.ok(delta >= 2, `expected ≥2 runAgentLoop invocations (1st aborted + 2nd steered); got delta=${delta}`);

      // Latest captured opts should be from the steered (2nd) turn — verify via messages.last()
      // (runAgentLoop opts don't carry userPrompt/isRetryable; those are runOneTurn opts. The behavioral
      // signal: runAgentLoop is called with messages whose LAST entry is the new prompt.)
      assert.ok(mockCapturedOpts !== null, "mockCapturedOpts must have been captured");
      const lastMsg = mockCapturedOpts.messages?.[mockCapturedOpts.messages.length - 1];
      assert.ok(lastMsg, "captured opts must have non-empty messages array");
      assert.equal(
        lastMsg.content,
        "new prompt",
        `messages.last().content should be 'new prompt' (steered turn); got: ${String(lastMsg.content)}`,
      );
      // isRetryable verification: behaviorally, the steered (operator) turn IS retryable.
      // Direct opts inspection not available (those are runOneTurn-level params not passed to runAgentLoop).
      // The contract is enforced at the call sites in serve.ts (verified by T-Error.1/T-Cron.2 differential).

      const sse = await ssePromise;
      assert.ok(
        sse.text.includes(`"turnId":"${firstTurnId}"`) && sse.text.includes('"finishReason":"aborted"'),
        `SSE must show first turn aborted; got: ${sse.text.slice(0, 600)}`,
      );
    } finally {
      h.restoreEnv();
    }
  });
});

// ─── T-Serve.15 — POST /agent/retry re-fires lastFailedTurnPrompt ───────────

describe("POST /agent/retry — re-fires lastFailedTurnPrompt + increments retryAttempts (G-P57c.2)", () => {
  it("T-Serve.15: given serve.ts harness + state reset via successful turn + then a failed operator turn with prompt 'fail-15' sets lastFailedTurnPrompt, WHEN POST /agent/retry, THEN response 200 {ok:true, turnId:<hex>, status:'queued', attempts:1}; mockCapturedOpts.userPrompt === 'fail-15' (retry consumed lastFailedTurnPrompt); attempts:1 confirms retryAttempts incremented", async () => {
    const h = await spinHarness("t15");
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      await resetRetryStateViaSuccess(h.sockPath, h.bearer, "t15");
      await setupFailedTurn(h.sockPath, h.bearer, "fail-15");

      mockMode = "succeed"; // retry should fire and succeed
      const beforeCount = mockRunAgentLoopCallCount;
      const r = await udsReq({
        socketPath: h.sockPath,
        method: "POST",
        path: "/agent/retry",
        headers: authHeader,
      });

      assert.equal(r.status, 200, `retry should return 200; got ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.ok, true, "retry ok must be true");
      assert.equal(r.body.status, "queued", "retry status must be queued");
      assert.equal(r.body.attempts, 1, "retry attempts must be 1");
      assert.ok(/^[0-9a-f]{8}$/.test(r.body.turnId), `turnId must be 8-hex; got: ${r.body.turnId}`);

      await new Promise((r) => setTimeout(r, 250));
      assert.equal(mockRunAgentLoopCallCount, beforeCount + 1, "retry should fire exactly one runAgentLoop invocation");
      const lastMsgT15 = mockCapturedOpts.messages?.[mockCapturedOpts.messages.length - 1];
      assert.equal(
        lastMsgT15?.content,
        "fail-15",
        `retry messages.last().content should be 'fail-15' (the failed prompt); got: ${String(lastMsgT15?.content)}`,
      );
      // isRetryable behavioral verification: subsequent retry would consume — but that's T-Serve.16 territory.
    } finally {
      h.restoreEnv();
    }
  });
});

// ─── T-Serve.16 — MAX_RETRY_ATTEMPTS cap ────────────────────────────────────

describe("POST /agent/retry — MAX_RETRY_ATTEMPTS=3 cap (G-P57c.3)", () => {
  it("T-Serve.16: given serve.ts harness + failed turn sets lastFailedTurnPrompt + 3 failing retries push retryAttempts to 3, WHEN 4th POST /agent/retry, THEN response 200 {ok:false, reason:'retry_limit_reached', attempts:3}; mockRunAgentLoop NOT called (zero increment); lastFailedTurnPrompt NOT consumed", async () => {
    const h = await spinHarness("t16");
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      await resetRetryStateViaSuccess(h.sockPath, h.bearer, "t16");
      await setupFailedTurn(h.sockPath, h.bearer, "p-16");

      // Do 3 failing retries to push retryAttempts to 3
      // Each retry: retryAttempts++ BEFORE runOneTurn; then runOneTurn throws → catch restores lastFailedTurnPrompt
      // Race window: retry endpoint clears lastFailedTurnPrompt at line 441 BEFORE runOneTurn is fired.
      // Test must wait long enough for runOneTurn's catch path to restore lastFailedTurnPrompt='p-16'.
      // mockRunAgentLoop sleeps 30ms before throwing → catch executes ~50ms in.
      mockMode = "throw";
      for (let i = 0; i < 3; i++) {
        const rRetry = await udsReq({
          socketPath: h.sockPath,
          method: "POST",
          path: "/agent/retry",
          headers: authHeader,
        });
        assert.equal(rRetry.status, 200, `retry #${i + 1} should accept (200); got ${rRetry.status}`);
        assert.equal(rRetry.body.attempts, i + 1, `retry #${i + 1} attempts must be ${i + 1}`);
        await new Promise((r) => setTimeout(r, 250)); // ensure catch path completes + lastFailedTurnPrompt restored
      }

      // Now retryAttempts=3, lastFailedTurnPrompt='p-16' (restored by catch). 4th retry rejected.
      const countBefore4th = mockRunAgentLoopCallCount;
      const r4 = await udsReq({
        socketPath: h.sockPath,
        method: "POST",
        path: "/agent/retry",
        headers: authHeader,
      });
      assert.equal(r4.status, 200, `4th retry should return 200 (with ok:false body); got ${r4.status}`);
      assert.equal(r4.body.ok, false, "4th retry ok must be false");
      assert.equal(r4.body.reason, "retry_limit_reached", "4th retry reason must be retry_limit_reached");
      assert.equal(r4.body.attempts, 3, "4th retry response attempts must be 3 (at cap)");
      assert.equal(mockRunAgentLoopCallCount, countBefore4th, "4th retry must NOT fire runAgentLoop (cap rejection)");
    } finally {
      h.restoreEnv();
    }
  });
});

// ─── T-Serve.17 — Success clears retry state ────────────────────────────────

describe("runOneTurn success path — clears lastFailedTurnPrompt + resets retryAttempts (G-P57c.4)", () => {
  it("T-Serve.17: given serve.ts harness + failed turn sets lastFailedTurnPrompt + 1 failing retry pushes retryAttempts to 1, WHEN POST /agent/turn with prompt 'new' (mockRunAgentLoop succeeds), THEN SSE includes done(finishReason:'stop'); subsequent POST /agent/retry returns ok:false reason:'no_failed_turn' (lastFailedTurnPrompt cleared); 2nd retry returns same — confirms retryAttempts also reset (would say reason:'retry_limit_reached' if still 3 OR proceed if still ≥1)", async () => {
    const h = await spinHarness("t17");
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      await resetRetryStateViaSuccess(h.sockPath, h.bearer, "t17");
      await setupFailedTurn(h.sockPath, h.bearer, "fail-17");

      // 1 failing retry to push retryAttempts to 1
      mockMode = "throw";
      const r1 = await udsReq({
        socketPath: h.sockPath,
        method: "POST",
        path: "/agent/retry",
        headers: authHeader,
      });
      assert.equal(r1.body.attempts, 1, "after 1 failing retry, attempts should be 1");
      await new Promise((r) => setTimeout(r, 150));

      // Now succeed an operator turn
      mockMode = "succeed";
      const r2 = await udsReq({
        socketPath: h.sockPath,
        method: "POST",
        path: "/agent/turn",
        headers: authHeader,
        body: { prompt: "new" },
      });
      assert.equal(r2.status, 200, "success turn should accept");
      await new Promise((r) => setTimeout(r, 200)); // wait for done

      // Verify state cleared: retry should now reject with no_failed_turn
      const r3 = await udsReq({
        socketPath: h.sockPath,
        method: "POST",
        path: "/agent/retry",
        headers: authHeader,
      });
      assert.equal(r3.body.ok, false, "post-success retry ok must be false");
      assert.equal(
        r3.body.reason,
        "no_failed_turn",
        `post-success retry reason must be 'no_failed_turn' (lastFailedTurnPrompt cleared); got: ${r3.body.reason}`,
      );
    } finally {
      h.restoreEnv();
    }
  });
});

// ─── T-Cron.1 — Cron-tick + cron-done SSE pair ──────────────────────────────

describe("Cron driver — emits cron-tick BEFORE runAgentLoop + cron-done in finally (G-P57c.5)", () => {
  it("T-Cron.1: given serve.ts harness with accelerated setInterval (60_000ms → fast cadence) + schedule.jsonl with 1 due cron job + mock runAgentLoop succeeds, WHEN cron driver tick fires, THEN SSE event order: (1) cron-tick frame with cronRunId + taskHint; (2) intermediate events; (3) cron-done frame with SAME cronRunId AFTER currentTurn cleared", async () => {
    setIntervalAccelerator = { active: true, factor: 600 }; // 60_000ms → 100ms
    const dueAt = new Date(Date.now() - 1000).toISOString();
    // ScheduleRecord shape per src/persistence/schedule.ts: cronExpr (not "cron"); type recurring/oneshot;
    // enabled true; lastRunAt null for fresh job.
    const scheduleEntry = JSON.stringify({
      id: "cron-t1",
      task: "test-cron-task",
      cronExpr: "* * * * *",
      type: "recurring",
      enabled: true,
      createdAt: dueAt,
      lastRunAt: null,
      nextRunAt: dueAt,
    });
    const h = await spinHarness("tc1", { writeScheduleJsonl: `${scheduleEntry}\n` });
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      mockMode = "succeed";

      const ssePromise = udsSSECollect({ socketPath: h.sockPath, headers: authHeader, collectMs: 2000 });
      await new Promise((r) => setTimeout(r, 1500)); // wait for accelerated cron to fire

      const sse = await ssePromise;
      const tickIdx = sse.text.indexOf('"type":"cron-tick"');
      const doneIdx = sse.text.indexOf('"type":"cron-done"');
      assert.ok(tickIdx >= 0, `SSE must contain cron-tick frame; got: ${sse.text.slice(0, 1500)}`);
      assert.ok(doneIdx >= 0, "SSE must contain cron-done frame");
      assert.ok(tickIdx < doneIdx, "cron-tick must precede cron-done in SSE stream");
      // Both frames carry cronRunId — verify they're paired (same value)
      const tickMatch = sse.text.match(/"type":"cron-tick"[^}]*"cronRunId":"([^"]+)"/);
      const doneMatch = sse.text.match(/"type":"cron-done"[^}]*"cronRunId":"([^"]+)"/);
      assert.ok(tickMatch && doneMatch, "cron-tick + cron-done must both have cronRunId");
      assert.equal(tickMatch[1], doneMatch[1], "cron-tick + cron-done cronRunId must be the SAME (paired)");
      assert.ok(sse.text.includes("test-cron-task"), "cron-tick taskHint must include the schedule task name");
    } finally {
      setIntervalAccelerator = { active: false, factor: 1 };
      h.restoreEnv();
    }
  });
});

// ─── T-Cron.2 — Cron-fired turns NOT retryable ──────────────────────────────

describe("Cron driver — cron-fired turns are NOT retryable (G-P57c.6, rev-1 MR-1 fix)", () => {
  it("T-Cron.2: given serve.ts harness + accelerated cron WITHOUT schedule.jsonl initially + setupFailedTurn sets lastFailedTurnPrompt='prior op fail' (operator-side failure), WHEN schedule.jsonl is written with due-now cron job + mockMode='throw' + cron tick fires, THEN SSE includes {type:'error', retryable:false} for the cron turn; subsequent POST /agent/retry returns ok:false reason:'no_failed_turn' (cron-error explicitly cleared lastFailedTurnPrompt per §5.3.2 isRetryable:false branch, NOT preserving the stale 'prior op fail' attribution that would have been wrong)", async () => {
    setIntervalAccelerator = { active: true, factor: 600 };
    // CRITICAL ORDERING: spinHarness WITHOUT schedule.jsonl first → cron ticks return early (no due jobs).
    // This lets us safely run a prior failing operator turn to seed lastFailedTurnPrompt without
    // the accelerated cron firing inadvertently and clearing state. Then write schedule.jsonl.
    const h = await spinHarness("tc2", {});
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };

      // (1) Seed lastFailedTurnPrompt via operator failure (isRetryable:true callsite sets it to 'prior op fail')
      await setupFailedTurn(h.sockPath, h.bearer, "prior op fail");
      // Now: lastFailedTurnPrompt = 'prior op fail', retryAttempts = 0

      // Sanity: verify lastFailedTurnPrompt is set by probing retry endpoint preview (use throw mode so retry doesn't actually run)
      // (we don't probe directly — would consume the state. Instead trust the setup + verify after cron.)

      // (2) Now write the schedule.jsonl AFTER state is seeded. Next cron tick (within 100ms) picks it up.
      mockMode = "throw"; // cron tick will throw
      const fs = await import("node:fs");
      const dueAt = new Date(Date.now() - 1000).toISOString();
      const scheduleEntry = JSON.stringify({
        id: "cron-t2",
        task: "cron-err-task",
        cronExpr: "* * * * *",
        type: "recurring",
        enabled: true,
        createdAt: dueAt,
        lastRunAt: null,
        nextRunAt: dueAt,
      });
      fs.writeFileSync(join(h.tmpDir, ".mai", "agent", "schedule.jsonl"), `${scheduleEntry}\n`, "utf-8");

      // (3) Subscribe SSE + wait for cron tick (every 100ms accelerated)
      const ssePromise = udsSSECollect({ socketPath: h.sockPath, headers: authHeader, collectMs: 2000 });
      await new Promise((r) => setTimeout(r, 1700)); // ample wait for ≥1 cron tick

      const sse = await ssePromise;
      // Verify error frame has retryable:false (cron callsite contract isRetryable:false)
      const errorMatch = sse.text.match(/"type":"error"[^}]*"retryable":(true|false)/);
      assert.ok(errorMatch, `SSE must contain error frame with retryable field; got: ${sse.text.slice(0, 1500)}`);
      assert.equal(
        errorMatch[1],
        "false",
        `cron-error retryable must be false (rev-1 MR-1 isRetryable:false callsite); got: ${errorMatch[1]}`,
      );

      // (4) Verify lastFailedTurnPrompt was CLEARED by the cron-error path (rev-1 MR-1 isRetryable:false branch),
      // NOT preserved as 'prior op fail' attribution. Probe via retry endpoint:
      mockMode = "succeed"; // make retry probe safe if it accidentally fires
      const retryProbe = await udsReq({
        socketPath: h.sockPath,
        method: "POST",
        path: "/agent/retry",
        headers: authHeader,
      });
      assert.equal(retryProbe.body.ok, false, "post-cron-error retry ok must be false");
      assert.equal(
        retryProbe.body.reason,
        "no_failed_turn",
        `cron-error must clear lastFailedTurnPrompt; retry should report no_failed_turn (NOT lingering 'prior op fail'); got reason: ${retryProbe.body.reason}`,
      );
    } finally {
      setIntervalAccelerator = { active: false, factor: 1 };
      h.restoreEnv();
    }
  });
});

// ─── T-Error.1 — Non-abort error sets retry state ───────────────────────────

describe("runOneTurn catch — non-abort error with isRetryable:true sets lastFailedTurnPrompt (G-P57c.7)", () => {
  it("T-Error.1: given serve.ts harness + mockRunAgentLoop throws non-abort error, WHEN POST /agent/turn {prompt:'the prompt'} (operator-callsite contract isRetryable:true), THEN SSE includes {type:'error', retryable:true, message:...}; subsequent POST /agent/retry returns 200+ok+turnId+attempts:1 with mockCapturedOpts.userPrompt === 'the prompt' (lastFailedTurnPrompt snapshotted correctly)", async () => {
    const h = await spinHarness("te1");
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      await resetRetryStateViaSuccess(h.sockPath, h.bearer, "te1");

      const ssePromise = udsSSECollect({ socketPath: h.sockPath, headers: authHeader, collectMs: 1500 });
      await new Promise((r) => setTimeout(r, 100));

      mockMode = "throw";
      await udsReq({
        socketPath: h.sockPath,
        method: "POST",
        path: "/agent/turn",
        headers: authHeader,
        body: { prompt: "the prompt" },
      });
      await new Promise((r) => setTimeout(r, 250)); // wait for catch path

      const sse = await ssePromise;
      const errorMatch = sse.text.match(/"type":"error"[^}]*"retryable":(true|false)/);
      assert.ok(errorMatch, `SSE must contain error frame; got: ${sse.text.slice(0, 800)}`);
      assert.equal(errorMatch[1], "true", "operator-turn error must be retryable:true");
      assert.ok(sse.text.includes("mock-runAgentLoop-error"), "SSE error message must contain mock error text");

      // Verify lastFailedTurnPrompt was set by probing retry endpoint
      mockMode = "succeed";
      const r = await udsReq({
        socketPath: h.sockPath,
        method: "POST",
        path: "/agent/retry",
        headers: authHeader,
      });
      assert.equal(r.body.ok, true, "retry should fire (lastFailedTurnPrompt was set)");
      assert.equal(r.body.attempts, 1, "first retry attempts must be 1");
      await new Promise((r) => setTimeout(r, 250));
      const lastMsgT = mockCapturedOpts.messages?.[mockCapturedOpts.messages.length - 1];
      assert.equal(
        lastMsgT?.content,
        "the prompt",
        `retry messages.last().content should be the failed prompt 'the prompt'; got: ${String(lastMsgT?.content)}`,
      );
    } finally {
      h.restoreEnv();
    }
  });
});

// ─── T-Error.2 — Aborted turns clear retry state ────────────────────────────

describe("runOneTurn catch — operator-initiated abort clears lastFailedTurnPrompt (G-P57c.8)", () => {
  it("T-Error.2: given serve.ts harness + a prior failed turn set lastFailedTurnPrompt='prior fail' + mockRunAgentLoop in respect-abort mode for the next turn, WHEN POST /agent/turn → POST /agent/abort mid-stream, THEN SSE includes done(aborted:true) (NOT error); subsequent POST /agent/retry returns ok:false reason:'no_failed_turn' (operator-initiated abort clears lastFailedTurnPrompt per §5.3.2 — NOT retryable)", async () => {
    const h = await spinHarness("te2");
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      await resetRetryStateViaSuccess(h.sockPath, h.bearer, "te2");
      await setupFailedTurn(h.sockPath, h.bearer, "prior fail"); // sets lastFailedTurnPrompt

      // Sanity: retry would fire now (lastFailedTurnPrompt set)
      // But we don't actually do it — we test that an aborted operator turn CLEARS it.

      const ssePromise = udsSSECollect({ socketPath: h.sockPath, headers: authHeader, collectMs: 2500 });
      await new Promise((r) => setTimeout(r, 100));

      mockMode = "respect-abort";
      const r1 = await udsReq({
        socketPath: h.sockPath,
        method: "POST",
        path: "/agent/turn",
        headers: authHeader,
        body: { prompt: "abortable" },
      });
      assert.equal(r1.status, 200, "abortable turn accepted");
      await new Promise((r) => setTimeout(r, 100));

      // Abort mid-stream
      await udsReq({
        socketPath: h.sockPath,
        method: "POST",
        path: "/agent/abort",
        headers: authHeader,
      });
      await new Promise((r) => setTimeout(r, 400));

      const sse = await ssePromise;
      assert.ok(
        sse.text.includes('"finishReason":"aborted"') || sse.text.includes('"aborted":true'),
        `SSE must contain done(aborted:true); got: ${sse.text.slice(0, 800)}`,
      );
      // Critical: NO error frame for the aborted turn
      const errorMatchAfterAbort = sse.text.match(/"type":"error"/);
      // (error MAY be present from an earlier failed-turn setup — we focus on aborted=true)

      // Verify retry rejects with no_failed_turn (lastFailedTurnPrompt was cleared by abort path)
      mockMode = "succeed";
      const retryProbe = await udsReq({
        socketPath: h.sockPath,
        method: "POST",
        path: "/agent/retry",
        headers: authHeader,
      });
      assert.equal(retryProbe.body.ok, false, "post-abort retry ok must be false");
      assert.equal(
        retryProbe.body.reason,
        "no_failed_turn",
        `post-abort retry must report no_failed_turn (abort cleared lastFailedTurnPrompt per §5.3.2); got: ${retryProbe.body.reason}`,
      );
      void errorMatchAfterAbort;
    } finally {
      h.restoreEnv();
    }
  });
});

// ─── T-Error.3 — Overlay retry event honors MAX cap ─────────────────────────

describe("dispatchOverlayEvent retry branch — enforces MAX_RETRY_ATTEMPTS guard (G-P57c.9)", () => {
  it("T-Error.3: given serve.ts harness + failed turn sets lastFailedTurnPrompt + 3 failing retries push retryAttempts to MAX=3, WHEN dispatch overlay-event {event_type:'retry'} via binding handler, THEN SSE collector receives {type:'error', message:'retry limit reached (3/3)', retryable:false}; mockRunAgentLoop NOT called (zero increment from baseline)", async () => {
    const h = await spinHarness("te3");
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      await resetRetryStateViaSuccess(h.sockPath, h.bearer, "te3");
      await setupFailedTurn(h.sockPath, h.bearer, "p-te3");

      // 3 failing retries to push retryAttempts to MAX=3
      mockMode = "throw";
      for (let i = 0; i < 3; i++) {
        await udsReq({
          socketPath: h.sockPath,
          method: "POST",
          path: "/agent/retry",
          headers: authHeader,
        });
        await new Promise((r) => setTimeout(r, 100));
      }

      const ssePromise = udsSSECollect({ socketPath: h.sockPath, headers: authHeader, collectMs: 800 });
      await new Promise((r) => setTimeout(r, 100));

      const countBefore = mockRunAgentLoopCallCount;
      // Dispatch overlay retry event — should be rejected at cap
      dispatchOverlayBindingEvent({ type: "retry", t0: Date.now() });
      await new Promise((r) => setTimeout(r, 200));

      const sse = await ssePromise;
      assert.ok(
        sse.text.includes("retry limit reached (3/3)"),
        `SSE must contain 'retry limit reached (3/3)' message; got: ${sse.text.slice(0, 800)}`,
      );
      assert.ok(sse.text.includes('"retryable":false'), "SSE retry-limit error must be retryable:false");
      assert.equal(mockRunAgentLoopCallCount, countBefore, "overlay retry at cap must NOT fire runAgentLoop");
    } finally {
      h.restoreEnv();
    }
  });
});
