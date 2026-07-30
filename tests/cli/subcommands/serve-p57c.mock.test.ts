import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpReq } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

// ─── Mock state ───────────────────────────────────────────────────────────────

let mockBindingCalledHandler: ((arg: { name: string; payload: string }) => void) | null = null;

// biome-ignore lint/suspicious/noExplicitAny: stub captures opts loosely
let mockCapturedOpts: any | null = null;
let mockRunAgentLoopCallCount = 0;
// biome-ignore lint/suspicious/noExplicitAny: capture current Pi options for ordering assertions
let mockCapturedOptsHistory: any[] = [];
let mockPiResolveCount = 0;
let installedTurnSignal: AbortSignal | null = null;

let mockMode: "succeed" | "throw" | "respect-abort" = "succeed";
let mockScript: Array<typeof mockMode> = [];

/** Override setInterval to accelerate cron driver (used in T-Cron.* tests). */
let setIntervalAccelerator: { active: boolean; factor: number } = { active: false, factor: 1 };

// ─── runServeSubcommand handle ───────────────────────────────────────────────

let runServeSubcommand: (opts: { portFile: string; bearerToken: string }) => Promise<void>;

// ─── File-level setup ────────────────────────────────────────────────────────

before(async () => {
  // 1. Mock createLinkedinSession — fake CdpHandle
  const sessionUrl = pathToFileURL(resolve(process.cwd(), "src/linkedin/session.js")).href;
  mock.module(sessionUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub
      createLinkedinSession: (_opts: any) => ({
        inputMode: "cdp",
        setTurnAbortSignal(signal: AbortSignal) {
          installedTurnSignal = signal;
        },
        clearTurnAbortSignal(signal: AbortSignal) {
          if (installedTurnSignal === signal) installedTurnSignal = null;
        },
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

  const piModelUrl = pathToFileURL(resolve(process.cwd(), "src/agent/pi/model.js")).href;
  mock.module(piModelUrl, {
    namedExports: {
      resolvePiModel: () => {
        mockPiResolveCount++;
        return { model: "mock", apiKey: "mock" };
      },
    },
  });

  // biome-ignore lint/suspicious/noExplicitAny: controlled Pi/delegate seam
  const controlledLoop = async (opts: any): Promise<void> => {
    mockCapturedOpts = opts;
    mockCapturedOptsHistory.push(opts);
    mockRunAgentLoopCallCount++;
    const mode = mockScript.shift() ?? mockMode;
    if (mode === "succeed") {
      await new Promise<void>((r) => setTimeout(r, 30));
      return;
    }
    if (mode === "throw") {
      await new Promise<void>((r) => setTimeout(r, 30));
      throw new Error("mock-runAgentLoop-error");
    }
    await new Promise<void>((r) => {
      if (opts?.abortSignal?.aborted) return r();
      opts?.abortSignal?.addEventListener("abort", () => r(), { once: true });
      setTimeout(r, 2000);
    });
    if (opts?.abortSignal?.aborted) throw new Error("AbortError: aborted");
  };

  const piLoopUrl = pathToFileURL(resolve(process.cwd(), "src/agent/pi/loop.js")).href;
  mock.module(piLoopUrl, {
    namedExports: {
      runAgentLoopPi: controlledLoop,
    },
  });

  const loopUrl = pathToFileURL(resolve(process.cwd(), "src/agent/loop.js")).href;
  mock.module(loopUrl, {
    namedExports: {
      runAgentLoop: controlledLoop,
      // [P-PI-followup] Pi loop transitive imports from loop.js — see _loopMockHelper.ts.
      STALL_STEP_THRESHOLD: 4,
      lastAssistantMessageHasNoToolCalls: () => false,
      lastAssistantMessageMissedExecute: () => false,
      narrationContinueMessage: () => ({ role: "user" as const, content: "" }),
      stalledContinueMessage: () => ({ role: "user" as const, content: "" }),
    },
  });

  const modelResolverUrl = pathToFileURL(resolve(process.cwd(), "src/agent/modelResolver.js")).href;
  mock.module(modelResolverUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub
      resolveModel: (): any => ({}),
      resolveModelSpec: () => "mock:stub",
      resolveModelOrNull: () => ({}) as never,
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

// ─── TCP HTTP helpers ─────────────────────────────────────────────────────────

interface TcpReqOpts {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}
interface TcpResult {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: body varies
  body: any;
}

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
      /* ignore transient read errors */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/** Spin tmp serve harness. */
async function spinHarness(
  testName: string,
  opts: { writeScheduleJsonl?: string } = {},
): Promise<{ port: number; bearer: string; tmpDir: string; restoreEnv: () => void }> {
  const tmpDir = mkdtempSync(join(tmpdir(), `p57c-${testName}-`));
  const portFile = join(tmpDir, "frondose.port");
  const bearer = "tok";
  const origHome = process.env.FRONDOSE_HOME_BASE;
  process.env.FRONDOSE_HOME_BASE = tmpDir;
  mkdirSync(join(tmpDir, ".frondose", "agent"), { recursive: true });
  writeFileSync(
    join(tmpDir, ".frondose", "agent", "identity.json"),
    JSON.stringify({ icp: { targetRole: ["VP Sales"] }, updatedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
  writeFileSync(join(tmpDir, ".frondose", "agent", "mode.json"), JSON.stringify({ mode: "auto" }), "utf-8");
  if (opts.writeScheduleJsonl !== undefined) {
    writeFileSync(join(tmpDir, ".frondose", "agent", "schedule.jsonl"), opts.writeScheduleJsonl, "utf-8");
  }

  mockBindingCalledHandler = null;
  mockCapturedOpts = null;
  mockCapturedOptsHistory = [];
  mockRunAgentLoopCallCount = 0;
  mockPiResolveCount = 0;
  mockScript = [];
  installedTurnSignal = null;

  void runServeSubcommand({ portFile, bearerToken: bearer });
  const port = await pollForPort(portFile, 5000);
  assert.ok(port !== null, `${testName}: server port file must appear within 5000ms`);

  await udsReq({
    port,
    method: "POST",
    path: "/chrome/ensure",
    headers: { Authorization: `Bearer ${bearer}` },
  });

  return {
    port,
    bearer,
    tmpDir,
    restoreEnv: () => {
      if (origHome === undefined) {
        delete process.env.FRONDOSE_HOME_BASE;
      } else {
        process.env.FRONDOSE_HOME_BASE = origHome;
      }
    },
  };
}

/** Reset module-level retry state through a successful operator turn. */
async function resetRetryStateViaSuccess(port: number, bearer: string, label: string): Promise<void> {
  mockMode = "succeed";
  const authHeader = { Authorization: `Bearer ${bearer}` };
  const r = await udsReq({
    port,
    method: "POST",
    path: "/agent/turn",
    headers: authHeader,
    body: { prompt: `reset-${label}` },
  });
  assert.equal(r.status, 200, `reset turn for ${label} must succeed (200)`);
  // Wait for runOneTurn.finally to clear currentTurn (mockRunAgentLoop sleeps 30ms)
  await new Promise((r) => setTimeout(r, 150));
}

async function setupFailedTurn(port: number, bearer: string, failPrompt: string): Promise<void> {
  mockMode = "throw";
  const authHeader = { Authorization: `Bearer ${bearer}` };
  await udsReq({
    port,
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
  mockBindingCalledHandler({ name: "__frondosePost", payload: JSON.stringify(rawPayload) });
}

// T-Serve.14
describe("dispatchOverlayEvent — overlay prompt during running triggers server-side steer promotion (G-P57c.1)", () => {
  it("T-Serve.14: steer aborts T1; T2 failure is retryable with exact new prompt", async () => {
    // Given/When/Then: steer T1→failing T2, then retry exact T2 prompt at attempts:1.
    const h = await spinHarness("t14");
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      const ssePromise = udsSSECollect({ port: h.port, headers: authHeader, collectMs: 2500 });
      await new Promise((r) => setTimeout(r, 100));

      mockScript = ["respect-abort", "throw", "succeed"];
      const r1 = await udsReq({
        port: h.port,
        method: "POST",
        path: "/agent/turn",
        headers: authHeader,
        body: { prompt: "long-running turn" },
      });
      assert.equal(r1.status, 200, "first turn should be accepted");
      const firstTurnId: string = r1.body.turnId;
      await new Promise((r) => setTimeout(r, 100));

      dispatchOverlayBindingEvent({ type: "prompt", text: "new prompt", t0: Date.now() });
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(mockRunAgentLoopCallCount, 2, "steer must enter T1 and failing T2");
      const retry = await udsReq({ port: h.port, method: "POST", path: "/agent/retry", headers: authHeader });
      assert.equal(retry.body.ok, true, "steered failure must remain retryable");
      assert.equal(retry.body.attempts, 1, "steered failure's first retry must be attempts:1");
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(mockRunAgentLoopCallCount, 3, "retry must enter Pi");
      const retryOpts = mockCapturedOptsHistory[2];
      const lastMsg = retryOpts.messages?.[retryOpts.messages.length - 1];
      assert.equal(lastMsg?.content, "new prompt", "retry must consume the exact steered prompt");
      assert.equal(mockPiResolveCount, 3, "all three turns must resolve Pi");

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

describe("POST /agent/retry — re-fires lastFailedTurnPrompt + increments retryAttempts (G-P57c.2)", () => {
  it("T-Serve.15: HTTP retry re-fires the exact failed prompt with attempts one", async () => {
    // Given/When/Then: fail one operator prompt, retry, and observe exact prompt plus attempts:1.
    const h = await spinHarness("t15");
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      await resetRetryStateViaSuccess(h.port, h.bearer, "t15");
      await setupFailedTurn(h.port, h.bearer, "fail-15");

      mockMode = "succeed"; // retry should fire and succeed
      const beforeCount = mockRunAgentLoopCallCount;
      const r = await udsReq({
        port: h.port,
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
    } finally {
      h.restoreEnv();
    }
  });
});

// T-Serve.16
describe("POST /agent/retry — MAX_RETRY_ATTEMPTS=3 cap (G-P57c.3)", () => {
  it("T-Serve.16: the fourth HTTP retry is rejected at the three-attempt cap without Pi", async () => {
    // Given/When/Then: exhaust three retries, then prove the fourth rejects before Pi.
    const h = await spinHarness("t16");
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      await resetRetryStateViaSuccess(h.port, h.bearer, "t16");
      await setupFailedTurn(h.port, h.bearer, "p-16");

      mockMode = "throw";
      for (let i = 0; i < 3; i++) {
        const rRetry = await udsReq({
          port: h.port,
          method: "POST",
          path: "/agent/retry",
          headers: authHeader,
        });
        assert.equal(rRetry.status, 200, `retry #${i + 1} should accept (200); got ${rRetry.status}`);
        assert.equal(rRetry.body.attempts, i + 1, `retry #${i + 1} attempts must be ${i + 1}`);
        await new Promise((r) => setTimeout(r, 250)); // ensure catch path completes + lastFailedTurnPrompt restored
      }

      const countBefore4th = mockRunAgentLoopCallCount;
      const r4 = await udsReq({
        port: h.port,
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

// T-Serve.17
describe("runOneTurn success path — clears lastFailedTurnPrompt + resets retryAttempts (G-P57c.4)", () => {
  it("T-Serve.17: success resets the retry counter before a fresh failure", async () => {
    // Given/When/Then: seed near cap, succeed, then prove a fresh failure retries at attempts:1.
    const h = await spinHarness("t17");
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      await resetRetryStateViaSuccess(h.port, h.bearer, "t17");
      await setupFailedTurn(h.port, h.bearer, "fail-17");

      mockMode = "throw";
      for (let attempt = 1; attempt <= 2; attempt++) {
        const seeded = await udsReq({ port: h.port, method: "POST", path: "/agent/retry", headers: authHeader });
        assert.equal(seeded.body.attempts, attempt, `seed retry must reach attempts:${attempt}`);
        await new Promise((r) => setTimeout(r, 150));
      }

      mockMode = "succeed";
      const r2 = await udsReq({
        port: h.port,
        method: "POST",
        path: "/agent/turn",
        headers: authHeader,
        body: { prompt: "new" },
      });
      assert.equal(r2.status, 200, "success turn should accept");
      await new Promise((r) => setTimeout(r, 200)); // wait for done

      await setupFailedTurn(h.port, h.bearer, "fresh-17");
      mockMode = "succeed";
      const freshRetry = await udsReq({ port: h.port, method: "POST", path: "/agent/retry", headers: authHeader });
      assert.equal(freshRetry.body.ok, true, "fresh failure must be retryable");
      assert.equal(freshRetry.body.attempts, 1, "success must reset the prior near-cap counter to zero");
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
    // Arm the SSE listener before making the record due. Writing it before boot
    // lets the accelerated interval consume it before the collector attaches.
    const h = await spinHarness("tc1");
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      mockMode = "succeed";

      const ssePromise = udsSSECollect({ port: h.port, headers: authHeader, collectMs: 2000 });
      await new Promise((r) => setTimeout(r, 100));
      const schedulePath = join(h.tmpDir, ".frondose", "agent", "schedule.jsonl");
      writeFileSync(schedulePath, `${scheduleEntry}\n`, "utf-8");
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
      const persisted = readFileSync(schedulePath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(persisted.length, 1, "recurring cron tick must update exactly one schedule record");
      assert.equal(persisted[0]?.id, "cron-t1");
      assert.equal(typeof persisted[0]?.lastRunAt, "string", "the single processed record must persist lastRunAt");
      assert.ok(
        new Date(String(persisted[0]?.nextRunAt)).getTime() > new Date(dueAt).getTime(),
        "the single processed recurring record must advance nextRunAt",
      );
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
      await setupFailedTurn(h.port, h.bearer, "prior op fail");
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
      fs.writeFileSync(join(h.tmpDir, ".frondose", "agent", "schedule.jsonl"), `${scheduleEntry}\n`, "utf-8");

      // (3) Subscribe SSE + wait for cron tick (every 100ms accelerated)
      const ssePromise = udsSSECollect({ port: h.port, headers: authHeader, collectMs: 2000 });
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
        port: h.port,
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

// T-Error.1
describe("runOneTurn catch — non-abort error with isRetryable:true sets lastFailedTurnPrompt (G-P57c.7)", () => {
  it("T-Error.1: a non-abort Pi error is retryable and preserves the exact prompt", async () => {
    // Given/When/Then: throw non-abortively, then retry the exact stored operator prompt.
    const h = await spinHarness("te1");
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      await resetRetryStateViaSuccess(h.port, h.bearer, "te1");

      const ssePromise = udsSSECollect({ port: h.port, headers: authHeader, collectMs: 1500 });
      await new Promise((r) => setTimeout(r, 100));

      mockMode = "throw";
      await udsReq({
        port: h.port,
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

      mockMode = "succeed";
      const r = await udsReq({
        port: h.port,
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

// T-Error.2
describe("runOneTurn catch — operator-initiated abort clears lastFailedTurnPrompt (G-P57c.8)", () => {
  it("T-Error.2: abort-reject emits one aborted done, no same-turn error, and clears retry state", async () => {
    // Given/When/Then: abort a rejecting Pi turn and prove exact terminal/error/retry cleanup.
    const h = await spinHarness("te2");
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      await resetRetryStateViaSuccess(h.port, h.bearer, "te2");
      await setupFailedTurn(h.port, h.bearer, "prior fail"); // sets lastFailedTurnPrompt

      const ssePromise = udsSSECollect({ port: h.port, headers: authHeader, collectMs: 2500 });
      await new Promise((r) => setTimeout(r, 100));

      mockMode = "respect-abort";
      const r1 = await udsReq({
        port: h.port,
        method: "POST",
        path: "/agent/turn",
        headers: authHeader,
        body: { prompt: "abortable" },
      });
      assert.equal(r1.status, 200, "abortable turn accepted");
      await new Promise((r) => setTimeout(r, 100));

      const abortResponse = await udsReq({
        port: h.port,
        method: "POST",
        path: "/agent/abort",
        headers: authHeader,
      });
      assert.equal(abortResponse.body.turnId, r1.body.turnId, "abort response must name the active turn");
      assert.equal(abortResponse.body.released, true, "abort response must release the active turn");
      await new Promise((r) => setTimeout(r, 400));

      const sse = await ssePromise;
      const frames = sse.text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)));
      const turnFrames = frames.filter((frame) => frame.turnId === r1.body.turnId);
      const terminal = turnFrames.filter(
        (frame) => frame.type === "done" && (frame.finishReason === "aborted" || frame.aborted === true),
      );
      assert.equal(terminal.length, 1, "active turn must emit exactly one aborted terminal frame");
      assert.equal(
        turnFrames.filter((frame) => frame.type === "error").length,
        0,
        "aborted catch path must emit no error frame for the active turn",
      );

      mockMode = "succeed";
      const retryProbe = await udsReq({
        port: h.port,
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
    } finally {
      h.restoreEnv();
    }
  });
});

// T-Error.3
describe("dispatchOverlayEvent retry branch — enforces MAX_RETRY_ATTEMPTS guard (G-P57c.9)", () => {
  it("T-Error.3: overlay retry at cap emits a non-retryable limit error without Pi", async () => {
    // Given/When/Then: exhaust retry state, dispatch overlay retry, and prove fail-before-Pi.
    const h = await spinHarness("te3");
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      await resetRetryStateViaSuccess(h.port, h.bearer, "te3");
      await setupFailedTurn(h.port, h.bearer, "p-te3");

      mockMode = "throw";
      for (let i = 0; i < 3; i++) {
        await udsReq({
          port: h.port,
          method: "POST",
          path: "/agent/retry",
          headers: authHeader,
        });
        await new Promise((r) => setTimeout(r, 100));
      }

      const ssePromise = udsSSECollect({ port: h.port, headers: authHeader, collectMs: 800 });
      await new Promise((r) => setTimeout(r, 100));

      const countBefore = mockRunAgentLoopCallCount;
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
