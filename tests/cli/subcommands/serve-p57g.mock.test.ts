/**
 * P-57g Step 5 — T-PassiveDefault.1, T-PassiveToggle.1, T-PassiveGate.1 — FILLED
 * (G-P57g.1, G-P57g.2, G-P57g.3)
 *
 * Per source grep at Step 5 baseline (post-Step 4b):
 *   - serve.ts L84 (P-Z1: now a ServeState property in the shell): `passiveEnabled: (process.env.MAI_PASSIVE_SUGGEST ?? "off").toLowerCase() === "on",`
 *   - L484 POST /agent/passive-mode: enabled null → 400 {ok:false, reason:"missing_enabled"};
 *     else passiveEnabled=enabled + SSE {type:"passive-mode", passiveEnabled} + 200 {ok:true, passiveEnabled}.
 *   - L611/L634 `if (!passiveEnabled) { ...passive-skipped disabled... return; }` gates.
 *
 * Harness mirrors serve-p57f (mock session/loop/modelResolver/passiveRateLimit/inject).
 * IMPORTANT: MAI_PASSIVE_SUGGEST is DELETED before serve.js import so passiveEnabled defaults
 * false at module load. T-PassiveGate.1 is order-independent (POSTs {enabled:false} to reset first).
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     --test-timeout=60000 tests/cli/subcommands/serve-p57g.mock.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpReq } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVE_TS_PATH = join(__dirname, "..", "..", "..", "src", "cli", "subcommands", "serve.ts");

let mockBindingCalledHandler: ((arg: { name: string; payload: string }) => void) | null = null;
let mockRunAgentLoopCallCount = 0;
const sseFramesSeen: string[] = [];
let runServeSubcommand: (opts: { portFile: string; bearerToken: string }) => Promise<void>;

before(async () => {
  // Default-off: ensure env unset so passiveEnabled defaults false at module load.
  delete process.env.FRONDOSE_PASSIVE_SUGGEST;

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
          return { handle: { __stub: "h" } };
        },
      }),
    },
  });

  const loopUrl = pathToFileURL(resolve(process.cwd(), "src/agent/loop.js")).href;
  mock.module(loopUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub
      runAgentLoop: async (_opts: any) => {
        mockRunAgentLoopCallCount++;
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

  const modelResolverUrl = pathToFileURL(resolve(process.cwd(), "src/agent/modelResolver.js")).href;
  mock.module(modelResolverUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub
      resolveModel: (): any => ({}),
      resolveModelSpec: () => "mock:stub",
      resolveModelOrNull: () => ({}) as never,
    },
  });

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

  const injectUrl = pathToFileURL(resolve(process.cwd(), "src/overlay/inject.js")).href;
  mock.module(injectUrl, {
    namedExports: {
      OVERLAY_BOOTSTRAP_JS: "",
      installOverlay: async () => "id-overlay",
      // biome-ignore lint/suspicious/noExplicitAny: stub
      subscribeContextId: async (_handle: any, onContext: (id: number) => void) => {
        onContext(123);
        return () => undefined;
      },
      callInOverlay: async () => undefined,
    },
  });

  const serveMod = await import("../../../src/cli/subcommands/serve.js");
  // biome-ignore lint/suspicious/noExplicitAny: dynamic import
  runServeSubcommand = (serveMod as any).runServeSubcommand;
});

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
        if (!Number.isNaN(port) && port > 0) return port;
      }
    } catch {
      /* ignore transient read errors */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

async function spinHarness(testName: string): Promise<{ port: number; bearer: string; restoreEnv: () => void }> {
  const tmpDir = mkdtempSync(join(tmpdir(), `p57g-${testName}-`));
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

  mockBindingCalledHandler = null;
  mockRunAgentLoopCallCount = 0;
  sseFramesSeen.length = 0;

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
    restoreEnv: () => {
      if (origHome === undefined) delete process.env.FRONDOSE_HOME_BASE;
      else process.env.FRONDOSE_HOME_BASE = origHome;
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: synthetic payload
function dispatchClick(rawCtx: any): void {
  if (!mockBindingCalledHandler) throw new Error("mockBindingCalledHandler not captured");
  mockBindingCalledHandler({
    name: "__frondosePost",
    payload: JSON.stringify({ type: "observe", event_type: "click", ctx: rawCtx, t0: Date.now() }),
  });
}

// ─── T-PassiveDefault.1 — passiveEnabled defaults OFF (source-level) ─────────

describe("serve.ts passiveEnabled — defaults OFF through frondoseEnv; only PASSIVE_SUGGEST='on' enables (G-P57g.1)", () => {
  it('T-PassiveDefault.1: given serve.ts L84 post-P-Z1 (ServeState literal), WHEN the default expression is inspected, THEN it reads `?? "off"` + `=== "on"` and the OLD `?? "on"` + `!== "off"` default-ON form is GONE', () => {
    const src = readFileSync(SERVE_TS_PATH, "utf-8");
    assert.ok(
      // P-Z1 OQ-Z1.4: passiveEnabled moved from a module `let` to a ServeState object
      // literal in the serve.ts shell (serve.ts:84). The env-read line stays in serve.ts
      // (SERVE_TS_PATH unchanged); only the `let X =` prefix becomes the `X:` property form.
      /const\s+passiveEnabledAtBoot\s*=\s*\(frondoseEnv\("PASSIVE_SUGGEST"\)\s*\?\?\s*"off"\)/.test(src),
      "serve.ts must compute passiveEnabledAtBoot through frondoseEnv(PASSIVE_SUGGEST) with default 'off'",
    );
    assert.ok(
      /passiveEnabled:\s*passiveEnabledAtBoot/.test(src),
      "serve.ts must thread passiveEnabledAtBoot into ServeState.passiveEnabled",
    );
    assert.ok(
      src.includes('.toLowerCase() === "on"'),
      "serve.ts passiveEnabled must use `=== \"on\"` (only 'on' enables)",
    );
    // OLD default-ON form removed.
    assert.ok(
      !/passiveEnabled\s*=\s*\((?:process\.env\.MAI_PASSIVE_SUGGEST|frondoseEnv\("PASSIVE_SUGGEST"\))\s*\?\?\s*"on"\)/.test(
        src,
      ),
      'OLD `?? "on"` default-ON form must be REMOVED',
    );
    assert.ok(
      !/PASSIVE_SUGGEST.*\)\.toLowerCase\(\)\s*!==\s*"off"/.test(src),
      'OLD `!== "off"` comparison must be REMOVED',
    );
  });
});

// ─── T-PassiveToggle.1 — /agent/passive-mode flips flag + SSE ────────────────

describe("POST /agent/passive-mode — flips passiveEnabled + emits passive-mode SSE (G-P57g.2)", () => {
  it("T-PassiveToggle.1: given serve.ts harness + SSE collector, WHEN POST /agent/passive-mode {enabled:true}, THEN 200 {ok:true, passiveEnabled:true} + SSE {type:'passive-mode', passiveEnabled:true}; {enabled:false} flips back + emits; {} → 400 {ok:false, reason:'missing_enabled'}", async () => {
    const h = await spinHarness("ptoggle");
    try {
      const ssePromise = collectSse(h.port, h.bearer, 1200);
      await new Promise((r) => setTimeout(r, 100));
      const authHeader = { Authorization: `Bearer ${h.bearer}` };

      const rOn = await udsReq({
        port: h.port,
        method: "POST",
        path: "/agent/passive-mode",
        headers: authHeader,
        body: { enabled: true },
      });
      assert.equal(rOn.status, 200, "enabled:true → 200");
      assert.equal(rOn.body.ok, true, "enabled:true → ok:true");
      assert.equal(rOn.body.passiveEnabled, true, "enabled:true → passiveEnabled:true");

      const rOff = await udsReq({
        port: h.port,
        method: "POST",
        path: "/agent/passive-mode",
        headers: authHeader,
        body: { enabled: false },
      });
      assert.equal(rOff.body.passiveEnabled, false, "enabled:false → passiveEnabled:false (flips back)");

      const rMissing = await udsReq({
        port: h.port,
        method: "POST",
        path: "/agent/passive-mode",
        headers: authHeader,
        body: {},
      });
      assert.equal(rMissing.status, 400, "no enabled → 400");
      assert.equal(rMissing.body.ok, false, "no enabled → ok:false");
      assert.equal(rMissing.body.reason, "missing_enabled", "no enabled → reason:missing_enabled");

      await ssePromise;
      const passiveModeFrames = sseFramesSeen.filter((f) => {
        try {
          return JSON.parse(f).type === "passive-mode";
        } catch {
          return false;
        }
      });
      assert.ok(passiveModeFrames.length >= 2, `≥2 passive-mode SSE frames (on+off); got ${passiveModeFrames.length}`);
      assert.ok(
        passiveModeFrames.some((f) => JSON.parse(f).passiveEnabled === true),
        "a passive-mode SSE with passiveEnabled:true must be emitted",
      );
    } finally {
      h.restoreEnv();
    }
  });
});

// ─── T-PassiveGate.1 — passive event dropped when off, processed when on ─────

describe("handlePassiveObservation — drops passive event when off; processes after toggle on (G-P57g.3)", () => {
  it("T-PassiveGate.1: given serve.ts harness (default off; explicitly reset off first), WHEN a click observe event is dispatched while OFF, THEN triggerPassiveAnalysis NOT called; AFTER POST /agent/passive-mode {enabled:true}, the next click → triggerPassiveAnalysis IS called", async () => {
    const h = await spinHarness("pgate");
    try {
      const authHeader = { Authorization: `Bearer ${h.bearer}` };
      // Ensure OFF (order-independent — a prior test may have toggled the module-level flag).
      await udsReq({
        port: h.port,
        method: "POST",
        path: "/agent/passive-mode",
        headers: authHeader,
        body: { enabled: false },
      });

      const beforeOff = mockRunAgentLoopCallCount;
      dispatchClick({ url: "https://www.linkedin.com/in/jane/", ref: { ariaLabel: "Connect to Jane" } });
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(
        mockRunAgentLoopCallCount,
        beforeOff,
        "while passive OFF, click observe must be DROPPED (triggerPassiveAnalysis NOT called)",
      );

      // Toggle ON.
      await udsReq({
        port: h.port,
        method: "POST",
        path: "/agent/passive-mode",
        headers: authHeader,
        body: { enabled: true },
      });
      const beforeOn = mockRunAgentLoopCallCount;
      dispatchClick({ url: "https://www.linkedin.com/in/jane/", ref: { ariaLabel: "Connect to Jane" } });
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(
        mockRunAgentLoopCallCount,
        beforeOn + 1,
        "after passive ON, click observe must reach triggerPassiveAnalysis (runAgentLoop fired once)",
      );
    } finally {
      h.restoreEnv();
    }
  });
});
