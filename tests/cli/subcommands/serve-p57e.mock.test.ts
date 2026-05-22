/**
 * P-57e rev-2 Step 5 — T-ICP.1, T-Memory.1, T-Memory.2, T-Memory.3 — FILLED
 * (G-P57e.5, G-P57e.7)
 *
 * Mirrors P-57b/c/d serve mock harness:
 *   - mock.module() for session.js + loop.js + modelResolver.js + passiveRateLimit.js +
 *     icpMatcher.js (spy) BEFORE importing serve.ts.
 *   - Fake CdpHandle captures the binding handler (overlay-event dispatch entry point).
 *   - Dispatch overlay-events; capture mockRunAgentLoop's opts.messages[0].content
 *     (= buildPassivePrompt output pushed to passiveMessages in triggerPassiveAnalysis).
 *
 * Per source grep at Step 5 baseline (post-Step 4b):
 *   - serve.ts handlePassiveObservation click branch: tier-2 DROPPED (rate-limit only);
 *     matchIcp import REMOVED (OQ-4 done — noUnusedLocals:true + npm check exit 0 proves orphan gone).
 *   - buildPassivePrompt all 3 branches memory-first; click refSummary [ariaLabel, controlName, text]
 *     (ariaLabel FIRST per rev-1 MR fix).
 *   - Dispatch shapes: click {type:"observe", event_type:"click", ctx:{url, ref}}; profile-nav
 *     {type:"profile-nav", handle, url}; input {type:"observe", event_type:"input", ctx:{snippet, charCount}}.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=60000 tests/cli/subcommands/serve-p57e.mock.test.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpReq } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

// ─── Mock state ──────────────────────────────────────────────────────────────

let mockBindingCalledHandler: ((arg: { name: string; payload: string }) => void) | null = null;
// biome-ignore lint/suspicious/noExplicitAny: stub captures opts loosely
let mockCapturedOpts: any | null = null;
let mockRunAgentLoopCallCount = 0;

let runServeSubcommand: (opts: { sockPath: string; bearerToken: string }) => Promise<void>;

before(async () => {
  // 1. Mock createLinkedinSession — fake CdpHandle capturing the binding handler.
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

  // 2. Mock runAgentLoop — captures opts (messages) + succeeds.
  const loopUrl = pathToFileURL(resolve(process.cwd(), "src/agent/loop.js")).href;
  mock.module(loopUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub
      runAgentLoop: async (opts: any) => {
        mockCapturedOpts = opts;
        mockRunAgentLoopCallCount++;
        await new Promise<void>((r) => setTimeout(r, 20));
      },
    },
  });

  // 3. Mock resolveModel.
  const modelResolverUrl = pathToFileURL(resolve(process.cwd(), "src/agent/modelResolver.js")).href;
  mock.module(modelResolverUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub
      resolveModel: (): any => ({}),
      resolveModelSpec: () => "mock:stub",
      resolveModelOrNull: () => null,
    },
  });

  // 4. Mock passiveRateLimit — tryConsume always true (so click reaches triggerPassiveAnalysis).
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

  // NOTE: icpMatcher is intentionally NOT mocked. serve.ts REMOVED the matchIcp import
  // entirely at Step 4b (OQ-4 — verified via npm check noUnusedLocals:true). Mocking
  // icpMatcher cascade-breaks qualifyProfile.ts (which imports deriveQualificationFromMatch).
  // T-ICP.1 instead proves matchIcp-not-invoked at the SOURCE level (no import line in
  // serve.ts) + behaviorally (non-ICP ref click reaches triggerPassiveAnalysis).

  // 5. Import serve.js AFTER mocks.
  const serveMod = await import("../../../src/cli/subcommands/serve.js");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  runServeSubcommand = (serveMod as any).runServeSubcommand;
});

// ─── UDS helpers ─────────────────────────────────────────────────────────────

async function udsReq(opts: {
  socketPath: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  // biome-ignore lint/suspicious/noExplicitAny: body varies
}): Promise<{ status: number; body: any }> {
  return new Promise((resolveP, rejectP) => {
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

async function pollForSock(sockPath: string, deadline_ms: number): Promise<boolean> {
  const end = Date.now() + deadline_ms;
  while (Date.now() < end) {
    const { existsSync } = await import("node:fs");
    if (existsSync(sockPath)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function spinHarness(
  testName: string,
): Promise<{ sockPath: string; bearer: string; tmpDir: string; restoreEnv: () => void }> {
  const tmpDir = mkdtempSync(join(tmpdir(), `p57e-${testName}-`));
  const sockPath = join(tmpDir, "mai.sock");
  const bearer = "tok";
  const origHome = process.env.MAI_HOME_BASE;
  process.env.MAI_HOME_BASE = tmpDir;
  mkdirSync(join(tmpDir, ".mai", "agent"), { recursive: true });
  writeFileSync(
    join(tmpDir, ".mai", "agent", "identity.json"),
    JSON.stringify({ icp: { targetRole: ["VP Sales"] }, updatedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );

  mockBindingCalledHandler = null;
  mockCapturedOpts = null;
  mockRunAgentLoopCallCount = 0;

  void runServeSubcommand({ sockPath, bearerToken: bearer });
  const ready = await pollForSock(sockPath, 5000);
  assert.ok(ready, `${testName}: server socket must be ready within 5000ms`);

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
      if (origHome === undefined) delete process.env.MAI_HOME_BASE;
      else process.env.MAI_HOME_BASE = origHome;
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: synthetic payload
function dispatchOverlayBindingEvent(rawPayload: any): void {
  if (!mockBindingCalledHandler) throw new Error("mockBindingCalledHandler not captured");
  mockBindingCalledHandler({ name: "__maiPost", payload: JSON.stringify(rawPayload) });
}

/** Capture the buildPassivePrompt output (= passiveMessages[0].content) for a dispatched event. */
function capturedPrompt(): string {
  assert.ok(mockCapturedOpts !== null, "mockRunAgentLoop must have been called (triggerPassiveAnalysis fired)");
  const msgs = mockCapturedOpts.messages;
  assert.ok(Array.isArray(msgs) && msgs.length > 0, "captured opts.messages must be non-empty");
  return String(msgs[msgs.length - 1].content);
}

// ─── T-ICP.1 — click branch drops tier-2 ICP filter ─────────────────────────

describe("handlePassiveObservation click branch — tier-2 ICP filter dropped; any ref-bearing click fires (G-P57e.5)", () => {
  it("T-ICP.1: given serve.ts harness + ICP identity + ref={tag:'DIV', text:'unrelated'} (non-ICP) click event, WHEN dispatched while passiveLimiter allows, THEN triggerPassiveAnalysis IS called (mockRunAgentLoop fired); AND serve.ts source has NO matchIcp import (tier-2 removed + import orphan cleaned per OQ-4)", async () => {
    const h = await spinHarness("ticp1");
    try {
      const before = mockRunAgentLoopCallCount;
      dispatchOverlayBindingEvent({
        type: "observe",
        event_type: "click",
        ctx: {
          url: "https://www.linkedin.com/feed/",
          ref: { tag: "DIV", text: "unrelated page chrome" },
          x: 10,
          y: 20,
        },
        t0: Date.now(),
      });
      // Wait for triggerPassiveAnalysis → runAgentLoop (mock sleeps 20ms).
      await new Promise((r) => setTimeout(r, 150));

      assert.equal(
        mockRunAgentLoopCallCount,
        before + 1,
        "non-ICP ref click MUST reach triggerPassiveAnalysis (tier-2 ICP filter dropped — every ref-bearing click fires)",
      );

      // Source-level proof that matchIcp is no longer imported/called (OQ-4 — import orphan removed).
      const { readFileSync } = await import("node:fs");
      const serveSrc = readFileSync(resolve(process.cwd(), "src/cli/subcommands/serve.ts"), "utf-8");
      assert.ok(
        !/import\s+\{[^}]*\bmatchIcp\b[^}]*\}\s+from/.test(serveSrc),
        "serve.ts must have NO matchIcp import (tier-2 removed + orphan cleaned per OQ-4)",
      );
      assert.ok(
        !/\bmatchIcp\s*\(/.test(serveSrc),
        "serve.ts must have NO matchIcp(...) callsite (tier-2 filter fully dropped)",
      );
    } finally {
      h.restoreEnv();
    }
  });
});

// ─── T-Memory.1 — click branch memory-first + ariaLabel-first refSummary ────

describe("buildPassivePrompt click branch — memory-first text block referencing ctx.ref (G-P57e.7)", () => {
  it("T-Memory.1: given click ctx with ref={tag:'BUTTON', ariaLabel:'Connect to Jane Doe', controlName:'connect_btn', text:'Connect'}, WHEN buildPassivePrompt('click', ctx) drives the passive turn, THEN captured prompt contains 'Default response is memory-first: call `remember`' + 'BUTTON \"Connect to Jane Doe\"' (refSummary picks ariaLabel FIRST per rev-1 MR fix) + 'Routine engagement clicks (Like / Comment / Connect / Send / Follow buttons) → remember+stop' + 'ctx.ref:' JSON dump", async () => {
    const h = await spinHarness("tmem1");
    try {
      dispatchOverlayBindingEvent({
        type: "observe",
        event_type: "click",
        ctx: {
          url: "https://www.linkedin.com/in/jane/",
          ref: { tag: "BUTTON", text: "Connect", ariaLabel: "Connect to Jane Doe", controlName: "connect_btn" },
          x: 30,
          y: 40,
        },
        t0: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 150));

      const prompt = capturedPrompt();
      assert.ok(
        prompt.includes("Default response is memory-first: call `remember`"),
        `prompt must contain memory-first directive; got: ${prompt.slice(0, 200)}`,
      );
      // rev-1 MR fix: refSummary picks ariaLabel FIRST (NOT controlName "connect_btn")
      assert.ok(
        prompt.includes('BUTTON "Connect to Jane Doe"'),
        `prompt headline must use ariaLabel-first refSummary 'BUTTON "Connect to Jane Doe"'; got: ${prompt.slice(0, 200)}`,
      );
      assert.ok(
        !prompt.includes('BUTTON "connect_btn"'),
        "refSummary must NOT pick controlName 'connect_btn' first (ariaLabel takes priority per rev-1 MR)",
      );
      assert.ok(
        prompt.includes("Routine engagement clicks (Like / Comment / Connect / Send / Follow buttons) → remember+stop"),
        "prompt must contain routine-engagement directive",
      );
      assert.ok(prompt.includes("ctx.ref:"), "prompt must dump ctx.ref JSON");
      assert.ok(
        prompt.includes('"controlName":"connect_btn"'),
        "ctx.ref JSON dump must retain controlName (nothing lost)",
      );
    } finally {
      h.restoreEnv();
    }
  });
});

// ─── T-Memory.2 — profile-nav branch memory-first ───────────────────────────

describe("buildPassivePrompt profile-nav branch — memory-first text (G-P57e.7)", () => {
  it("T-Memory.2: given profile-nav ctx={handle:'jane', url:'...'}, WHEN buildPassivePrompt('profile-nav', ctx) drives the passive turn, THEN captured prompt contains 'if you have NO memory of this person → call `remember` (interaction kind: at)' + 'If you ALREADY have memory of this person → `stop` directly' + 'Call `suggest_card` ONLY if this person qualifies as a fresh ICP match'", async () => {
    const h = await spinHarness("tmem2");
    try {
      dispatchOverlayBindingEvent({
        type: "profile-nav",
        handle: "jane",
        url: "https://www.linkedin.com/in/jane/",
        t0: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 150));

      const prompt = capturedPrompt();
      assert.ok(
        prompt.includes("if you have NO memory of this person → call `remember` (interaction kind: at)"),
        `profile-nav prompt must contain no-memory→remember(at) directive; got: ${prompt.slice(0, 200)}`,
      );
      assert.ok(
        prompt.includes("If you ALREADY have memory of this person → `stop` directly"),
        "profile-nav prompt must contain already-memory→stop directive",
      );
      assert.ok(
        prompt.includes("Call `suggest_card` ONLY if this person qualifies as a fresh ICP match"),
        "profile-nav prompt must reserve suggest_card for fresh ICP match",
      );
    } finally {
      h.restoreEnv();
    }
  });
});

// ─── T-Memory.3 — input branch memory-first ─────────────────────────────────

describe("buildPassivePrompt input branch — memory-first text (G-P57e.7)", () => {
  it("T-Memory.3: given input ctx={snippet:'Hi Jane...', charCount:38}, WHEN buildPassivePrompt('input', ctx) drives the passive turn, THEN captured prompt contains 'Default response: call `remember` to record this draft moment' + 'interaction kind: message' + the snippet text", async () => {
    const h = await spinHarness("tmem3");
    try {
      const snippet = "Hi Jane, hope this finds you well...";
      dispatchOverlayBindingEvent({
        type: "observe",
        event_type: "input",
        ctx: { snippet, charCount: 38 },
        t0: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 150));

      const prompt = capturedPrompt();
      assert.ok(
        prompt.includes("Default response: call `remember` to record this draft moment"),
        `input prompt must contain memory-first draft directive; got: ${prompt.slice(0, 200)}`,
      );
      assert.ok(prompt.includes("interaction kind: message"), "input prompt must specify interaction kind: message");
      assert.ok(prompt.includes(snippet), "input prompt must include the snippet text");
    } finally {
      h.restoreEnv();
    }
  });
});
