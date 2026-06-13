/**
 * P-57f Step 5 — T-Ticker.1, T-Ticker.2 — FILLED
 * (G-P57f.1, G-P57f.2)
 *
 * Per source grep at Step 5 baseline (post-Step 4b):
 *   - serve.ts L717 passiveRefSummary (click → [ariaLabel, controlName, text].find(non-empty).slice(0,60)).
 *   - L734 passiveTicker: callInOverlay(client.handle, ctxId, `function() { window.__maiUpdateTicker(<json>); }`)
 *     guarded by `if (ctxId === undefined || !client) return`.
 *   - L748 start-ticker `mai · observing ${eventType}: ${refSummary}…` BEFORE runAgentLoop.
 *   - L784 completion-ticker `✓ noted: ${refSummary}` at the passive-fired emit.
 *
 * Harness: mirrors serve-p57e + mocks `../../overlay/inject.js` exposing:
 *   - `callInOverlay` SPY (captures handle + ctxId + fnString, + ordering vs runAgentLoop)
 *   - `subscribeContextId` stub (immediately invokes onContext(123) → serve.ts sets overlayContextId)
 *   - `installOverlay` stub + `OVERLAY_BOOTSTRAP_JS` placeholder (other importers)
 *   session mock getClient() returns a non-null {handle} so passiveTicker's guard passes.
 *   runAgentLoop mock records its call in the shared sequence (for start-before-loop ordering).
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=60000 tests/cli/subcommands/serve-p57f.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpReq } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

// ─── Mock state ──────────────────────────────────────────────────────────────

let mockBindingCalledHandler: ((arg: { name: string; payload: string }) => void) | null = null;
// Shared ordered call sequence: each entry is `callInOverlay:<fnString>` or `runAgentLoop`.
let callSeq: string[] = [];
const sseFramesSeen: string[] = [];

let runServeSubcommand: (opts: { portFile: string; bearerToken: string }) => Promise<void>;

const STUB_HANDLE = { __stub: "handle" };

before(async () => {
  // 1. session.js — fake CdpHandle; getClient() returns non-null {handle} so passiveTicker fires.
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
          return { handle: STUB_HANDLE };
        },
      }),
    },
  });

  // 2. loop.js — runAgentLoop records its call in callSeq + resolves.
  const loopUrl = pathToFileURL(resolve(process.cwd(), "src/agent/loop.js")).href;
  mock.module(loopUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub
      runAgentLoop: async (_opts: any) => {
        callSeq.push("runAgentLoop");
        await new Promise<void>((r) => setTimeout(r, 20));
      },
      // [P-PI-followup] Pi loop transitive imports from loop.js — see _loopMockHelper.ts.
      STALL_STEP_THRESHOLD: 4,
      lastAssistantMessageHasNoToolCalls: () => false,
      lastAssistantMessageMissedExecute: () => false,
      narrationContinueMessage: () => ({ role: "user" as const, content: "" }),
      stalledContinueMessage: () => ({ role: "user" as const, content: "" }),
    },
  });

  // 3. modelResolver.js
  const modelResolverUrl = pathToFileURL(resolve(process.cwd(), "src/agent/modelResolver.js")).href;
  mock.module(modelResolverUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub
      resolveModel: (): any => ({}),
      resolveModelSpec: () => "mock:stub",
      resolveModelOrNull: () => null,
    },
  });

  // 4. passiveRateLimit.js — tryConsume always true.
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

  // 5. inject.js — callInOverlay SPY (records fnString + ordering) + subscribeContextId stub
  //    (sets overlayContextId via onContext) + installOverlay stub + OVERLAY_BOOTSTRAP_JS placeholder.
  const injectUrl = pathToFileURL(resolve(process.cwd(), "src/overlay/inject.js")).href;
  mock.module(injectUrl, {
    namedExports: {
      OVERLAY_BOOTSTRAP_JS: "",
      installOverlay: async () => "id-overlay",
      // biome-ignore lint/suspicious/noExplicitAny: stub
      subscribeContextId: async (_handle: any, onContext: (id: number) => void) => {
        onContext(123); // serve.ts sets overlayContextId = 123 → passiveTicker guard passes
        return () => undefined;
      },
      // biome-ignore lint/suspicious/noExplicitAny: spy
      callInOverlay: async (_handle: any, _ctxId: number, fnString: string) => {
        callSeq.push(`callInOverlay:${fnString}`);
      },
    },
  });

  // 6. Import serve.js AFTER mocks.
  const serveMod = await import("../../../src/cli/subcommands/serve.js");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  runServeSubcommand = (serveMod as any).runServeSubcommand;
});

// ─── TCP + harness helpers ────────────────────────────────────────────────────

async function udsReq(opts: {
  port: number;
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

function collectSse(port: number, bearer: string, collectMs: number): Promise<void> {
  return new Promise((resolveP) => {
    const r = httpReq(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/agent/events",
        headers: { Accept: "text/event-stream", Authorization: `Bearer ${bearer}` },
      },
      (res) => {
        let buf = "";
        res.on("data", (c: Buffer) => {
          buf += c.toString();
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const l of lines) if (l.startsWith("data: ")) sseFramesSeen.push(l.slice(6));
        });
        setTimeout(() => {
          r.destroy();
          resolveP();
        }, collectMs);
      },
    );
    r.on("error", () => resolveP());
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
        if (!isNaN(port) && port > 0) return port;
      }
    } catch {
      /* ignore transient read errors */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

async function spinHarness(testName: string): Promise<{ port: number; bearer: string; restoreEnv: () => void }> {
  const tmpDir = mkdtempSync(join(tmpdir(), `p57f-${testName}-`));
  const portFile = join(tmpDir, "frondose.port");
  const bearer = "tok";
  const origHome = process.env.MAI_HOME_BASE;
  process.env.MAI_HOME_BASE = tmpDir;
  mkdirSync(join(tmpDir, ".frondose", "agent"), { recursive: true });
  writeFileSync(
    join(tmpDir, ".frondose", "agent", "identity.json"),
    JSON.stringify({ icp: { targetRole: ["VP Sales"] }, updatedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );

  mockBindingCalledHandler = null;
  callSeq = [];
  sseFramesSeen.length = 0;

  void runServeSubcommand({ portFile, bearerToken: bearer });
  const port = await pollForPort(portFile, 5000);
  assert.ok(port !== null, `${testName}: server port file must appear within 5000ms`);

  // /chrome/ensure → subscribeContextId stub fires onContext(123) → overlayContextId set.
  await udsReq({
    port,
    method: "POST",
    path: "/chrome/ensure",
    headers: { Authorization: `Bearer ${bearer}` },
  });

  // P-Z2: P-57g made passive default-OFF; enable it via the real runtime toggle.
  await udsReq({
    port,
    method: "POST",
    path: "/agent/passive-mode",
    headers: { Authorization: `Bearer ${bearer}` },
    body: { enabled: true },
  });

  return {
    port,
    bearer,
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

// ─── T-Ticker.1 — passive START ticker via callInOverlay (before runAgentLoop) ─

describe("triggerPassiveAnalysis — passive turn START emits observing-ticker via callInOverlay (G-P57f.1)", () => {
  it("T-Ticker.1: given serve.ts harness with callInOverlay spy + overlayContextId set + session.getClient() handle + runAgentLoop resolving, WHEN triggerPassiveAnalysis('click', {ref:{ariaLabel:'Connect to Jane'}}) fires, THEN callInOverlay is called BEFORE runAgentLoop with a fn string containing '__maiUpdateTicker' + 'observing click: Connect to Jane' (refSummary uses ariaLabel)", async () => {
    const h = await spinHarness("tt1");
    try {
      dispatchOverlayBindingEvent({
        type: "observe",
        event_type: "click",
        ctx: { url: "https://www.linkedin.com/in/jane/", ref: { ariaLabel: "Connect to Jane" }, x: 10, y: 20 },
        t0: Date.now(),
      });
      // Wait for triggerPassiveAnalysis → start-ticker + runAgentLoop (mock sleeps 20ms).
      await new Promise((r) => setTimeout(r, 150));

      // Find the start-ticker callInOverlay + the runAgentLoop entry in the ordered sequence.
      const startIdx = callSeq.findIndex(
        (s) =>
          s.startsWith("callInOverlay:") &&
          s.includes("__maiUpdateTicker") &&
          s.includes("observing click: Connect to Jane"),
      );
      const loopIdx = callSeq.indexOf("runAgentLoop");
      assert.ok(
        startIdx >= 0,
        `start-ticker callInOverlay with 'observing click: Connect to Jane' must be present; seq: ${JSON.stringify(callSeq)}`,
      );
      assert.ok(loopIdx >= 0, "runAgentLoop must have been called");
      assert.ok(
        startIdx < loopIdx,
        `start-ticker (idx ${startIdx}) must PRECEDE runAgentLoop (idx ${loopIdx}); seq: ${JSON.stringify(callSeq)}`,
      );
    } finally {
      h.restoreEnv();
    }
  });
});

// ─── T-Ticker.2 — passive COMPLETION ticker (✓ noted) + passive-fired ───────

describe("triggerPassiveAnalysis — passive turn COMPLETION emits ✓-noted ticker + passive-fired (G-P57f.2)", () => {
  it("T-Ticker.2: given serve.ts harness + SSE collector, WHEN triggerPassiveAnalysis('click', {ref:{controlName:'connect_btn'}}) runs to completion, THEN after runAgentLoop resolves a callInOverlay fires with '__maiUpdateTicker' + '✓ noted: connect_btn' (refSummary fallback ariaLabel>controlName>text — controlName since no ariaLabel) AND passive-fired SSE is emitted", async () => {
    const h = await spinHarness("tt2");
    try {
      const ssePromise = collectSse(h.port, h.bearer, 1500);
      await new Promise((r) => setTimeout(r, 100));

      dispatchOverlayBindingEvent({
        type: "observe",
        event_type: "click",
        ctx: { url: "https://www.linkedin.com/in/jane/", ref: { controlName: "connect_btn" }, x: 30, y: 40 },
        t0: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 250));
      await ssePromise;

      // Completion-ticker present + AFTER runAgentLoop.
      const compIdx = callSeq.findIndex(
        (s) => s.startsWith("callInOverlay:") && s.includes("__maiUpdateTicker") && s.includes("✓ noted: connect_btn"),
      );
      const loopIdx = callSeq.indexOf("runAgentLoop");
      assert.ok(
        compIdx >= 0,
        `completion-ticker '✓ noted: connect_btn' must be present (refSummary picks controlName since no ariaLabel); seq: ${JSON.stringify(callSeq)}`,
      );
      assert.ok(
        loopIdx >= 0 && compIdx > loopIdx,
        `completion-ticker (idx ${compIdx}) must follow runAgentLoop (idx ${loopIdx})`,
      );

      // passive-fired SSE emitted.
      const passiveFired = sseFramesSeen.some((f) => {
        try {
          return JSON.parse(f).type === "passive-fired";
        } catch {
          return false;
        }
      });
      assert.ok(
        passiveFired,
        `passive-fired SSE must be emitted; frames: ${JSON.stringify(sseFramesSeen).slice(0, 300)}`,
      );
    } finally {
      h.restoreEnv();
    }
  });
});
