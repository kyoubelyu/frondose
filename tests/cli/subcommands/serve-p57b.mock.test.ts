/**
 * P-57b Step 5 — T-Passive.2, T-Passive.3, T-Passive.4, T-Passive.5, T-Serve.13 — FILLED
 * (G-P57b.3, G-P57b.4, G-P57b.5, G-P57b.6, G-P57b.7)
 *
 * Mock tests for P-57b extensions to `src/cli/subcommands/serve.ts`.
 *
 * Implementation note (vs Step 4a scaffold + plan §6):
 *   - SSE `passive-skipped` reasons in PRODUCTION code: "disabled" | "busy" | "cache_hit"
 *     | "rate_limit" | "icp_mismatch". The plan §6 used "rate_limited" / "turn_in_progress"
 *     but actual code uses "rate_limit" / "busy". Tests assert the actual implementation
 *     strings, not the plan strings (per `feedback_codex_critic_false_positives` — fact-check
 *     against source).
 *   - `handlePassiveObservation` click pre-filter uses `matchIcp(...).role.status === "match"`
 *     (NOT `tokenizeRoleQuery` from the plan §5.3.6). matchIcp uses tokenOverlapMatch
 *     internally which is equivalent semantically for ASCII tokens.
 *   - Identity is NOT mocked (per Step 4a learning); we write a real identity.json under
 *     a tmp MAI_HOME_BASE.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=30000 tests/cli/subcommands/serve-p57b.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpReq } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

// ─── Mock state ───────────────────────────────────────────────────────────────

/** Captures the binding handler registered by attachEventBus on the fake CdpHandle.
 *  Each /chrome/ensure call resets this. Test bodies invoke it synthetically. */
let mockBindingCalledHandler: ((arg: { name: string; payload: string }) => void) | null = null;

/** Captures the `messages` array reference passed to mockRunAgentLoop. */
// biome-ignore lint/suspicious/noExplicitAny: stub for CoreMessage shape
let mockCapturedMessages: any[] | null = null;

/** Counts mockRunAgentLoop invocations (test bodies snapshot + assert deltas). */
let mockRunAgentLoopCallCount = 0;

/** Controls the mockRunAgentLoop sleep duration (ms). Used by T-Serve.13 to overlap. */
let mockRunAgentLoopSleepMs = 20;

/** Controls the mocked PassiveRateLimiter.tryConsume() return value per-test.
 *  Default true (allow) so most tests fire passive turns; T-Passive.2 sets false. */
let mockLimiterAllow = true;

// ─── runServeSubcommand handle ───────────────────────────────────────────────

let runServeSubcommand: (opts: { sockPath: string; bearerToken: string }) => Promise<void>;

// ─── File-level setup ────────────────────────────────────────────────────────

before(async () => {
  // 1. Mock createLinkedinSession — fake CdpHandle whose Runtime.bindingCalled captures the handler
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

  // 2. Mock runAgentLoop — captures opts + counts invocations
  const loopUrl = pathToFileURL(resolve(process.cwd(), "src/agent/loop.js")).href;
  mock.module(loopUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub
      runAgentLoop: async (opts: any) => {
        mockCapturedMessages = opts?.messages ?? null;
        mockRunAgentLoopCallCount++;
        const sleepMs = mockRunAgentLoopSleepMs;
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
    },
  });

  // 3. Mock resolveModel
  const modelResolverUrl = pathToFileURL(resolve(process.cwd(), "src/agent/modelResolver.js")).href;
  mock.module(modelResolverUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      resolveModel: (): any => ({}),
      resolveModelSpec: () => "mock:stub",
      resolveModelOrNull: () => null,
    },
  });

  // 4. Mock passiveRateLimit — module-level passiveLimiter in serve.ts would persist
  //    state across tests; per-test mockLimiterAllow gives precise control without
  //    fighting setInterval refills or test ordering.
  const passiveRateLimitUrl = pathToFileURL(resolve(process.cwd(), "src/cli/subcommands/passiveRateLimit.js")).href;
  mock.module(passiveRateLimitUrl, {
    namedExports: {
      PassiveRateLimiter: class {
        tryConsume(): boolean {
          return mockLimiterAllow;
        }
        snapshot() {
          return { shortWindowTokens: 1, longWindowTokens: 5, shortS: 30, longN: 5, longS: 60 };
        }
      },
      passiveRateLimiterOptsFromEnv: () => ({ shortS: 30, longN: 5, longS: 60 }),
    },
  });

  // 5. Identity NOT mocked — Step 5 writes a real identity.json under tmp MAI_HOME_BASE per-test
  //    (Step 4a learning: partial mock cascade-breaks src/tools/identity/getIdentity.ts).

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
          rejectP(new Error(`JSON parse error in UDS response: ${e}`));
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

/** Build a synthetic OverlayEvent with the non-enumerable `payload` field that
 *  eventBus.ts produces. This is what dispatchOverlayEvent expects to see. */
// biome-ignore lint/suspicious/noExplicitAny: synthetic event payload varies
function makeOverlayEvent(eventType: string, payload: any) {
  const event = {
    kind: "overlay-event",
    ts: Date.now(),
    event_type: eventType,
    t0: Date.now(),
    latency_ms: 0,
  };
  Object.defineProperty(event, "payload", { value: payload, enumerable: false });
  return event;
}

/** Spin a tmp serve harness with identity.json containing the given ICP roles. */
async function spinHarness(
  testName: string,
  opts: { icpRoles?: string[]; identityOverride?: Record<string, unknown> } = {},
): Promise<{ sockPath: string; bearer: string; tmpDir: string; restoreEnv: () => void }> {
  const tmpDir = mkdtempSync(join(tmpdir(), `p57b-${testName}-`));
  const sockPath = join(tmpDir, "mai.sock");
  const bearer = "tok";
  const origHome = process.env.MAI_HOME_BASE;
  process.env.MAI_HOME_BASE = tmpDir;
  mkdirSync(join(tmpDir, ".mai", "agent"), { recursive: true });

  // Write a legacy identity.json (readConfig fallback path picks it up when config.json missing)
  // Schema requirement: identityRecordSchema has `updatedAt: z.string().min(1)` REQUIRED;
  // missing field causes the legacy reader to return null with a stderr warning. All other
  // fields including icp are optional. Caller can pass identityOverride to add more.
  if (opts.icpRoles) {
    const identityRecord: Record<string, unknown> = {
      icp: { targetRole: opts.icpRoles },
      updatedAt: new Date().toISOString(),
      ...opts.identityOverride,
    };
    writeFileSync(join(tmpDir, ".mai", "agent", "identity.json"), JSON.stringify(identityRecord, null, 2), "utf-8");
  }

  // Reset per-test mock state
  mockBindingCalledHandler = null;
  mockCapturedMessages = null;
  mockRunAgentLoopCallCount = 0;
  mockRunAgentLoopSleepMs = 20;
  mockLimiterAllow = true; // tests that need denial set this to false before dispatch

  void runServeSubcommand({ sockPath, bearerToken: bearer });
  const sockReady = await pollForSock(sockPath, 5000);
  assert.ok(sockReady, `${testName}: server socket must be ready within 5000ms`);

  // /chrome/ensure to register the binding handler
  await udsReq({
    socketPath: sockPath,
    method: "POST",
    path: "/chrome/ensure",
    headers: { Authorization: `Bearer ${bearer}` },
  });
  assert.ok(mockBindingCalledHandler !== null, `${testName}: bindingCalled handler must be captured`);

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

/** Drive a synthetic overlay event through the captured binding handler. */
// biome-ignore lint/suspicious/noExplicitAny: synthetic payload
function dispatchOverlayBindingEvent(rawPayload: any): void {
  if (!mockBindingCalledHandler) throw new Error("mockBindingCalledHandler not captured");
  // Real attachEventBus parses payload then calls dispatchOverlayEvent. To bypass that
  // path entirely (since we don't have the real attachEventBus from session.js — only
  // serve.ts's attachEventBus call), we directly emit the raw payload as if from the
  // CDP binding event. Real eventBus.ts then constructs the OverlayEvent + non-enum
  // payload + calls onEvent. Our binding handler IS the real eventBus's internal callback
  // (since attachEventBus is imported from real overlay/eventBus.js — NOT mocked).
  mockBindingCalledHandler({ name: "__maiPost", payload: JSON.stringify(rawPayload) });
}
void makeOverlayEvent; // alternative shape; kept for reference

// ─── T-Passive.2 — Rate-limit exhausted → passive-skipped SSE ───────────────

describe("handlePassiveProfileNav — rate-limit exhausted → passive-skipped SSE; runAgentLoop NOT called (G-P57b.3)", () => {
  it("T-Passive.2: given serve.ts harness + identity.icp + mocked PassiveRateLimiter set to DENY (mockLimiterAllow=false), WHEN dispatch a profile-nav overlay event, THEN SSE collector receives {type:'passive-skipped', reason:'rate_limit'} AND mockRunAgentLoopCallCount stays at 0 (no invocation)", async () => {
    const h = await spinHarness("t2", { icpRoles: ["VP Sales"] });
    try {
      // After harness spin (which set mockLimiterAllow=true), force DENY for this test
      mockLimiterAllow = false;

      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      const ssePromise = udsSSECollect({ socketPath: h.sockPath, headers: authHeader, collectMs: 800 });
      await new Promise((r) => setTimeout(r, 100)); // SSE handshake

      dispatchOverlayBindingEvent({
        type: "profile-nav",
        handle: "t2-jane",
        url: "https://linkedin.com/in/t2-jane/",
        t0: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 100));

      assert.equal(
        mockRunAgentLoopCallCount,
        0,
        `rate-limit DENIED → runAgentLoop must NOT be called; got ${mockRunAgentLoopCallCount}`,
      );

      const sse = await ssePromise;
      assert.ok(
        sse.text.includes('"type":"passive-skipped"') && sse.text.includes('"reason":"rate_limit"'),
        `SSE must contain passive-skipped + reason rate_limit; got: ${sse.text.slice(0, 800)}`,
      );
    } finally {
      h.restoreEnv();
    }
  });
});

// ─── T-Passive.3 — passiveMessages[] isolation ──────────────────────────────

describe("triggerPassiveAnalysis — isolated passiveMessages[]; operator messages[] UNCHANGED (G-P57b.4, OQ-passive-5)", () => {
  it("T-Passive.3: given serve.ts harness + operator messages[] seeded via POST /agent/turn, WHEN profile-nav overlay event fires triggerPassiveAnalysis, THEN passive runAgentLoop receives a FRESH messages[] of length 1 (just the passive prompt) — NOT the operator's prior array; operator messages[] reference unchanged", async () => {
    const h = await spinHarness("t3", { icpRoles: ["VP Sales"] });
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };

      // (1) Operator POST /agent/turn → captures operator messages[]
      await udsReq({
        socketPath: h.sockPath,
        method: "POST",
        path: "/agent/turn",
        headers: authHeader,
        body: { prompt: "operator first turn" },
      });
      await new Promise((r) => setTimeout(r, 60));
      // Snapshot the operator messages[] reference + length
      // biome-ignore lint/suspicious/noExplicitAny: snapshot ref to escape never-narrowing
      const opMessagesRef: any[] | null = mockCapturedMessages;
      assert.ok(opMessagesRef !== null, "operator messages[] should have been captured");
      // biome-ignore lint/suspicious/noExplicitAny: after assert, manually cast
      const opMsgs = opMessagesRef as any[];
      const opLen = opMsgs.length;
      assert.ok(opLen >= 1, `operator messages[] length should be ≥1; got ${opLen}`);
      const firstOpContent = opMsgs[0]?.content;
      assert.ok(
        typeof firstOpContent === "string" && firstOpContent.includes("operator first turn"),
        "operator messages[0] must contain 'operator first turn'",
      );

      // (2) Trigger profile-nav passive observation
      mockCapturedMessages = null;
      dispatchOverlayBindingEvent({
        type: "profile-nav",
        handle: "t3-alice",
        url: "https://linkedin.com/in/t3-alice/",
        t0: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 100));

      // (3) Passive captured messages[] should be FRESH array of length 1, NOT the operator's
      // biome-ignore lint/suspicious/noExplicitAny: snapshot to escape narrowing
      const passiveMessagesRef: any[] | null = mockCapturedMessages;
      assert.ok(passiveMessagesRef !== null, "passive runAgentLoop must have been invoked");
      // biome-ignore lint/suspicious/noExplicitAny: cast after assert
      const passiveMsgs = passiveMessagesRef as any[];
      assert.notStrictEqual(
        passiveMsgs,
        opMsgs,
        "passive messages[] must be a DIFFERENT array reference from operator's (isolation per OQ-passive-5)",
      );
      assert.equal(
        passiveMsgs.length,
        1,
        `passive messages[] should have exactly 1 entry (the passive prompt); got ${passiveMsgs.length}`,
      );
      const passiveContent = passiveMsgs[0]?.content;
      assert.ok(
        typeof passiveContent === "string" && passiveContent.includes("Silently analyse"),
        `passive messages[0] must contain 'Silently analyse' (buildPassivePrompt profile-nav signature); got: ${String(passiveContent).slice(0, 200)}`,
      );

      // (4) Operator messages[] length UNCHANGED after passive fire
      assert.equal(
        opMsgs.length,
        opLen,
        `operator messages[] length must be UNCHANGED after passive fire; was ${opLen}, now ${opMsgs.length}`,
      );
    } finally {
      h.restoreEnv();
    }
  });
});

// ─── T-Passive.4 — Profile-cache 10-min dedup + lazy TTL eviction ───────────

describe("handlePassiveProfileNav — passiveProfileCache 10-min dedup + lazy TTL eviction (G-P57b.5)", () => {
  it("T-Passive.4: given serve.ts harness + identity.icp; first profile-nav for handle 'jane' fires successfully (callCount → 1); WHEN second profile-nav for SAME handle 'jane' immediately, THEN SSE 'passive-skipped' + 'cache_hit'; callCount stays at 1; after manipulating cache entry's ts to simulate >10min, third fires (lazy-evict re-adds, callCount → 2)", async () => {
    const h = await spinHarness("t4", { icpRoles: ["VP Sales"] });
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      const ssePromise = udsSSECollect({ socketPath: h.sockPath, headers: authHeader, collectMs: 1500 });
      await new Promise((r) => setTimeout(r, 100));

      // (1) First profile-nav for 'jane' → fires
      dispatchOverlayBindingEvent({
        type: "profile-nav",
        handle: "jane",
        url: "https://linkedin.com/in/jane/",
        t0: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(mockRunAgentLoopCallCount, 1, "(#1) first profile-nav should fire runAgentLoop");

      // (2) Second profile-nav for 'jane' → cache_hit
      dispatchOverlayBindingEvent({
        type: "profile-nav",
        handle: "jane",
        url: "https://linkedin.com/in/jane/",
        t0: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(mockRunAgentLoopCallCount, 1, "(#2) second profile-nav SAME handle should NOT fire (cache hit)");

      // (3) Simulate TTL expiry: stub Date.now temporarily so the lazy-eviction check
      //     sees the cached entry as expired. PASSIVE_PROFILE_CACHE_TTL_MS = 10*60*1000.
      const origDateNow = Date.now;
      try {
        Date.now = () => origDateNow() + 11 * 60 * 1000; // 11 minutes ahead
        dispatchOverlayBindingEvent({
          type: "profile-nav",
          handle: "jane",
          url: "https://linkedin.com/in/jane/",
          t0: origDateNow(),
        });
        await new Promise((r) => setTimeout(r, 80));
      } finally {
        Date.now = origDateNow;
      }
      assert.equal(
        mockRunAgentLoopCallCount,
        2,
        `(#3) after >10min, third profile-nav SAME handle should fire (lazy TTL evict + re-add); got ${mockRunAgentLoopCallCount}`,
      );

      const sse = await ssePromise;
      assert.ok(
        sse.text.includes('"type":"passive-skipped"') && sse.text.includes('"reason":"cache_hit"'),
        `SSE must contain passive-skipped + reason cache_hit after #2; got: ${sse.text.slice(0, 800)}`,
      );
    } finally {
      h.restoreEnv();
    }
  });
});

// ─── T-Passive.5 — Click 2-tier ICP pre-filter ──────────────────────────────

describe("handlePassiveObservation — click 2-tier ICP pre-filter (URL /in/* OR matchIcp role token) (G-P57b.6)", () => {
  it("T-Passive.5: given serve.ts harness + identity.icp.targetRole=['VP Sales']; clean rate-limiter, WHEN dispatch four click events (V1:/feed/+'Like this post'→skip; V2:/in/jane-doe/+'Connect'→tier-1 fire; V3:/feed/+'VP of Sales role'→tier-2 fire on matchIcp; V4:/messaging/+'chat history'→skip), THEN runAgentLoop fired exactly 2 times (V2+V3); SSE has 2 passive-skipped + 2 passive-fired frames", async () => {
    const h = await spinHarness("t5", { icpRoles: ["VP Sales"] });
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      const ssePromise = udsSSECollect({ socketPath: h.sockPath, headers: authHeader, collectMs: 2000 });
      await new Promise((r) => setTimeout(r, 100));

      // V1: /feed/ + "Like this post" — both tier-1 (no /in/) AND tier-2 (no role-token) miss → skip
      dispatchOverlayBindingEvent({
        type: "observe",
        event_type: "click",
        ctx: { url: "https://linkedin.com/feed/", targetTag: "SPAN", targetText: "Like this post", x: 10, y: 20 },
        t0: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 60));

      // V2: /in/jane-doe/ + "Connect" — tier-1 URL match → fire
      dispatchOverlayBindingEvent({
        type: "observe",
        event_type: "click",
        ctx: { url: "https://linkedin.com/in/jane-doe/", targetTag: "BUTTON", targetText: "Connect", x: 30, y: 40 },
        t0: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 60));

      // V3: /feed/ + "VP of Sales role" — tier-2 matchIcp("VP of Sales role", {targetRole:["VP Sales"]}) → match → fire
      dispatchOverlayBindingEvent({
        type: "observe",
        event_type: "click",
        ctx: { url: "https://linkedin.com/feed/", targetTag: "A", targetText: "VP of Sales role", x: 50, y: 60 },
        t0: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 60));

      // V4: /messaging/ + "chat history" — both tiers miss → skip
      dispatchOverlayBindingEvent({
        type: "observe",
        event_type: "click",
        ctx: { url: "https://linkedin.com/messaging/", targetTag: "DIV", targetText: "chat history", x: 70, y: 80 },
        t0: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 200));

      assert.equal(
        mockRunAgentLoopCallCount,
        2,
        `runAgentLoop should fire exactly 2 times (V2 + V3); got ${mockRunAgentLoopCallCount}`,
      );

      const sse = await ssePromise;
      // 2 passive-skipped + 2 passive-fired
      const skipCount = (sse.text.match(/"type":"passive-skipped".*?"reason":"icp_mismatch"/g) ?? []).length;
      const fireCount = (sse.text.match(/"type":"passive-fired"/g) ?? []).length;
      assert.equal(skipCount, 2, `SSE must contain 2 passive-skipped icp_mismatch frames (V1+V4); got ${skipCount}`);
      assert.equal(fireCount, 2, `SSE must contain 2 passive-fired frames (V2+V3); got ${fireCount}`);
    } finally {
      h.restoreEnv();
    }
  });
});

// ─── T-Serve.13 — Silent skip on currentTurn busy ───────────────────────────

describe("handlePassiveObservation — silent skip on currentTurn !== null (G-P57b.7)", () => {
  it("T-Serve.13: given serve.ts harness with an in-flight operator turn (sleeping mockRunAgentLoop), WHEN dispatch click observe event with ICP-matching ctx, THEN SSE emits {type:'passive-skipped', reason:'busy'}; the passive event does NOT fire runAgentLoop (callCount stays at 1 — only the operator turn)", async () => {
    const h = await spinHarness("t13", { icpRoles: ["VP Sales"] });
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      // Long sleep so the operator turn is still in flight when we dispatch the passive event
      mockRunAgentLoopSleepMs = 1500;

      const ssePromise = udsSSECollect({ socketPath: h.sockPath, headers: authHeader, collectMs: 1200 });
      await new Promise((r) => setTimeout(r, 100));

      // Start operator turn
      await udsReq({
        socketPath: h.sockPath,
        method: "POST",
        path: "/agent/turn",
        headers: authHeader,
        body: { prompt: "operator busy" },
      });
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(mockRunAgentLoopCallCount, 1, "operator runAgentLoop should be invoked (count=1)");

      // Dispatch passive click with ICP-matching ctx WHILE operator turn is still sleeping
      dispatchOverlayBindingEvent({
        type: "observe",
        event_type: "click",
        ctx: { url: "https://linkedin.com/in/jane/", targetTag: "BUTTON", targetText: "Connect", x: 1, y: 1 },
        t0: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 200));

      // currentTurn is busy → passive observation should be silent-skipped with reason busy
      assert.equal(
        mockRunAgentLoopCallCount,
        1,
        `passive click should NOT fire runAgentLoop while operator turn in progress; got count=${mockRunAgentLoopCallCount}`,
      );

      const sse = await ssePromise;
      assert.ok(
        sse.text.includes('"type":"passive-skipped"') && sse.text.includes('"reason":"busy"'),
        `SSE must contain passive-skipped + reason busy; got: ${sse.text.slice(0, 800)}`,
      );
    } finally {
      h.restoreEnv();
    }
  });
});
