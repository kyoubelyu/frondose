/**
 * P-56a Step 5 — T-Serve.1, T-Serve.2, T-Serve.3
 * (G-P56a.1, G-P56a.3, G-P56a.4)
 *
 * WIN-1 migrated: UDS → TCP loopback + port-file.
 *   - sockPath/pollForSock/udsReq(socketPath) → portFile/pollForPort/tcpReq(port)
 *   - T-Serve.4 (chmod 0o600/0o700 UDS permissions) DROPPED — no socket file in TCP mode.
 *
 * Mock tests for `src/cli/subcommands/serve.ts`.
 *
 * Gate coverage:
 *   G-P56a.1 — `mai serve` exposes 3 endpoints over TCP loopback with bearer-token auth
 *   G-P56a.3 — `GET /identity` returns `{ok:true, fullName, ...}` OR `{ok:false, reason}`
 *   G-P56a.4 — `POST /chrome/ensure` triggers `getOrInitClient()` and maps response envelope
 *
 * All tmp dirs via `mkdtempSync` — ZERO `~/.mai/` reads in mock tests.
 * T-Serve.2 identity isolation: `MAI_HOME_BASE=<tmpDir>` env override per OQ-5.
 * Server instances run fire-and-forget; event loop kept open until --test-force-exit.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpReq } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";
import { cleanupTmpDir } from "../../_helpers/tmp";

// ─── Session mock state (T-Serve.3) ──────────────────────────────────────────

/**
 * Controls behavior of the mocked `createLinkedinSession().getOrInitClient()`.
 * true  → returns {ok:false, error:"chrome_unavailable", message:"busy"} (503 path).
 * false → returns {ok:true, client:<stub>} (200 path).
 */
let mockChromeFailMode = false;

// ─── File-level setup: mock createLinkedinSession BEFORE serve.ts is imported ─

before(() => {
  const sessionUrl = pathToFileURL(resolve(process.cwd(), "src/linkedin/session.js")).href;
  mock.module(sessionUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub factory
      createLinkedinSession: (_opts: any) => ({
        inputMode: "cdp",
        async getOrInitClient() {
          if (mockChromeFailMode) {
            return { ok: false, error: "chrome_unavailable", message: "busy" };
          }
          const handle = {
            Runtime: {
              enable: async () => undefined,
              addBinding: async () => undefined,
              executionContextCreated: () => () => undefined,
              bindingCalled: () => () => undefined,
              callFunctionOn: async () => ({ result: { value: null } }),
            },
            Page: {
              enable: async () => undefined,
              addScriptToEvaluateOnNewDocument: async () => ({ identifier: "id-1" }),
              getFrameTree: async () => ({ frameTree: { frame: { id: "main-1" } } }),
            },
          };
          return { ok: true, client: { isConnected: () => true, handle } };
        },
      }),
    },
  });

  const modelResolverUrl = pathToFileURL(resolve(process.cwd(), "src/agent/modelResolver.js")).href;
  mock.module(modelResolverUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
      resolveModel: (): any => ({}),
      resolveModelSpec: () => "mock:stub",
      resolveModelOrNull: () => null,
    },
  });
});

// ─── TCP HTTP helper ──────────────────────────────────────────────────────────

interface TcpReqOpts {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}
interface TcpResult {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test result body type varies per endpoint
  body: any;
}

/** Make an HTTP request over TCP loopback; resolve with status + parsed JSON body. */
async function tcpReq(opts: TcpReqOpts): Promise<TcpResult> {
  return new Promise<TcpResult>((resolve, reject) => {
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
    if (bodyStr) headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
    const r = httpReq({ host: "127.0.0.1", port: opts.port, method: opts.method, path: opts.path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) });
        } catch (e) {
          reject(new Error(`JSON parse error in TCP response: ${e}`));
        }
      });
    });
    r.on("error", reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

/**
 * Poll until portFile exists and contains a valid port number, OR deadline_ms expires.
 * Returns the port number, or null on timeout.
 */
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

// ─── T-Serve.1 — GET /health: auth variants (G-P56a.1) ──────────────────────

describe("runServeSubcommand — GET /health auth variants (G-P56a.1)", () => {
  it("T-Serve.1: given runServeSubcommand on a tmp port-file with bearer token 'tok123', WHEN (a) GET /health no Authorization header, (b) GET /health wrong bearer, (c) GET /health correct bearer, THEN (a) 401 {ok:false,error:'missing_bearer'}, (b) 401 {ok:false,error:'invalid_token'}, (c) 200 {ok:true,ts:<number>,pid:<number>}; after test port-file cleaned up", async () => {
    // Given: tmp dir port-file path; bearer token "tok123"; runServeSubcommand started
    //        fire-and-forget; validator polls existsSync(portFile) until port read (max 2s)
    // When:  three HTTP requests via tcpReq():
    //          (a) no Authorization → 401 {ok:false, error:"missing_bearer"}
    //          (b) Authorization: Bearer WRONG → 401 {ok:false, error:"invalid_token"}
    //          (c) Authorization: Bearer tok123 → 200 {ok:true, ts:<num>, pid:<num>}
    // Then:  pid === process.pid (runServeSubcommand runs in-process);
    //        ts is a number; port-file cleaned up after rmSync

    const { runServeSubcommand } = await import("../../../src/cli/subcommands/serve.js");
    const baseDir = mkdtempSync(join(tmpdir(), "p56a-t1-"));
    const portFile = join(baseDir, "frondose.port");
    const token = "tok123";

    // Fire-and-forget — server stays alive until --test-force-exit
    void runServeSubcommand({ portFile, bearerToken: token });

    try {
      const port = await pollForPort(portFile, 2000);
      assert.ok(port !== null, `port-file did not appear within 2s: ${portFile}`);

      // (a) no Authorization header → 401 missing_bearer
      const r1 = await tcpReq({ port, method: "GET", path: "/health" });
      assert.equal(r1.status, 401, `(a) expected 401, got ${r1.status}`);
      assert.deepEqual(r1.body, { ok: false, error: "missing_bearer" });

      // (b) wrong bearer → 401 invalid_token
      const r2 = await tcpReq({
        port,
        method: "GET",
        path: "/health",
        headers: { Authorization: "Bearer WRONG_TOKEN" },
      });
      assert.equal(r2.status, 401, `(b) expected 401, got ${r2.status}`);
      assert.deepEqual(r2.body, { ok: false, error: "invalid_token" });

      // (c) correct bearer → 200 {ok:true, ts:number, pid:number}
      const r3 = await tcpReq({
        port,
        method: "GET",
        path: "/health",
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(r3.status, 200, `(c) expected 200, got ${r3.status}`);
      assert.equal(r3.body.ok, true);
      assert.equal(typeof r3.body.ts, "number", "ts should be a number");
      assert.ok(r3.body.ts > 0, "ts should be positive");
      assert.equal(r3.body.pid, process.pid, "pid should match test process pid");
    } finally {
      rmSync(portFile, { force: true, maxRetries: 5, retryDelay: 100 });
      cleanupTmpDir(baseDir);
    }
  });
});

// ─── T-Serve.2 — GET /identity: identity set vs. not set (G-P56a.3) ─────────

describe("runServeSubcommand — GET /identity identity-set vs. not-set (G-P56a.3)", () => {
  it("T-Serve.2: given (A) tmp MAI_HOME_BASE with config.json containing fullName:'Test Operator' and (B) empty tmp MAI_HOME_BASE with no config.json, WHEN GET /identity with valid bearer, THEN (A) 200 {ok:true, fullName:'Test Operator', ...} and (B) 200 {ok:false, reason:'identity not set; open Frondose → Settings to complete setup'}", async () => {
    // Given: variant A — tmp dir as MAI_HOME_BASE;
    //          write <tmpDir>/.frondose/agent/config.json with identity
    //        variant B — empty tmp dir as MAI_HOME_BASE; no config/identity files
    //        Both: runServeSubcommand started with tmp portFile + bearer "tok456"
    // When:  GET /identity with Authorization: Bearer tok456
    // Then:  variant A → 200 {ok:true, fullName:"Test Operator"}
    //        variant B → 200 {ok:false, reason:"identity not set; open Frondose → Settings to complete setup"}

    const { runServeSubcommand } = await import("../../../src/cli/subcommands/serve.js");
    const origHome = process.env.FRONDOSE_HOME_BASE;

    // ── Variant A: identity set ──────────────────────────────────────────────
    const homeDirA = mkdtempSync(join(tmpdir(), "p56a-t2a-"));
    const configDirA = join(homeDirA, ".frondose", "agent");
    mkdirSync(configDirA, { recursive: true });
    writeFileSync(
      join(configDirA, "config.json"),
      JSON.stringify({
        schema_version: 2,
        identity: { fullName: "Test Operator", updatedAt: "2024-01-01T00:00:00.000Z" },
      }),
    );
    const portFileA = join(homeDirA, "a.port");

    try {
      process.env.FRONDOSE_HOME_BASE = homeDirA;
      void runServeSubcommand({ portFile: portFileA, bearerToken: "tok456" });

      const portA = await pollForPort(portFileA, 2000);
      assert.ok(portA !== null, `port A not ready within 2s: ${portFileA}`);

      const rA = await tcpReq({
        port: portA,
        method: "GET",
        path: "/identity",
        headers: { Authorization: "Bearer tok456" },
      });
      assert.equal(rA.status, 200, `variant A: expected 200, got ${rA.status}`);
      assert.equal(rA.body.ok, true, "variant A: ok should be true");
      assert.equal(rA.body.fullName, "Test Operator", "variant A: fullName should match");
    } finally {
      rmSync(portFileA, { force: true, maxRetries: 5, retryDelay: 100 });
      cleanupTmpDir(homeDirA);
    }

    // ── Variant B: no identity ───────────────────────────────────────────────
    const homeDirB = mkdtempSync(join(tmpdir(), "p56a-t2b-"));
    const portFileB = join(homeDirB, "b.port");

    try {
      process.env.FRONDOSE_HOME_BASE = homeDirB;
      void runServeSubcommand({ portFile: portFileB, bearerToken: "tok456" });

      const portB = await pollForPort(portFileB, 2000);
      assert.ok(portB !== null, `port B not ready within 2s: ${portFileB}`);

      const rB = await tcpReq({
        port: portB,
        method: "GET",
        path: "/identity",
        headers: { Authorization: "Bearer tok456" },
      });
      assert.equal(rB.status, 200, `variant B: expected 200, got ${rB.status}`);
      assert.equal(rB.body.ok, false, "variant B: ok should be false");
      assert.equal(
        rB.body.reason,
        "identity not set; open Frondose → Settings to complete setup",
        "variant B: reason must match exactly (P-APP-11 b1 PINNED)",
      );
    } finally {
      rmSync(portFileB, { force: true, maxRetries: 5, retryDelay: 100 });
      cleanupTmpDir(homeDirB);
      if (origHome !== undefined) {
        process.env.FRONDOSE_HOME_BASE = origHome;
      } else {
        delete process.env.FRONDOSE_HOME_BASE;
      }
    }
  });
});

// ─── T-Serve.3 — POST /chrome/ensure: guard denied + success path (G-P56a.4) ─

describe("runServeSubcommand — POST /chrome/ensure guard-denied + success (G-P56a.4)", () => {
  it("T-Serve.3: given (a) mocked createLinkedinSession.getOrInitClient → {ok:false, error:'chrome_unavailable', message:'busy'} and (b) mocked getOrInitClient → {ok:true, client:<stub>}, WHEN POST /chrome/ensure with valid bearer, THEN (a) 503 {ok:false, error:'chrome_unavailable', message:'busy'} and (b) 200 {ok:true, chromePort:9222, overlayInstalled:true}", async () => {
    // Given: session.js mocked via mock.module() in before() hook above.
    //        mockChromeFailMode=true → getOrInitClient returns {ok:false, ...}
    //        mockChromeFailMode=false → getOrInitClient returns {ok:true, client:<stub>}
    // When:  POST /chrome/ensure with Authorization: Bearer tok789
    // Then:  sub-case (a): status 503, body {ok:false, error:'chrome_unavailable', message:'busy'}
    //        sub-case (b): status 200, body deep-equals {ok:true, chromePort:9222, overlayInstalled:true}

    const { runServeSubcommand } = await import("../../../src/cli/subcommands/serve.js");

    // ── Sub-case (a): fail mode ──────────────────────────────────────────────
    mockChromeFailMode = true;
    const baseDirA = mkdtempSync(join(tmpdir(), "p56a-t3a-"));
    const portFileA = join(baseDirA, "frondose.port");

    try {
      void runServeSubcommand({ portFile: portFileA, bearerToken: "tok789" });
      const portA = await pollForPort(portFileA, 2000);
      assert.ok(portA !== null, `port A not ready: ${portFileA}`);

      const rA = await tcpReq({
        port: portA,
        method: "POST",
        path: "/chrome/ensure",
        headers: { Authorization: "Bearer tok789" },
      });
      assert.equal(rA.status, 503, `sub-case (a): expected 503, got ${rA.status}`);
      assert.deepEqual(rA.body, { ok: false, error: "chrome_unavailable", message: "busy" });
    } finally {
      rmSync(portFileA, { force: true, maxRetries: 5, retryDelay: 100 });
      cleanupTmpDir(baseDirA);
    }

    // ── Sub-case (b): success mode ───────────────────────────────────────────
    mockChromeFailMode = false;
    const baseDirB = mkdtempSync(join(tmpdir(), "p56a-t3b-"));
    const portFileB = join(baseDirB, "frondose.port");

    try {
      void runServeSubcommand({ portFile: portFileB, bearerToken: "tok789" });
      const portB = await pollForPort(portFileB, 2000);
      assert.ok(portB !== null, `port B not ready: ${portFileB}`);

      const rB = await tcpReq({
        port: portB,
        method: "POST",
        path: "/chrome/ensure",
        headers: { Authorization: "Bearer tok789" },
      });
      assert.equal(rB.status, 200, `sub-case (b): expected 200, got ${rB.status}`);
      assert.deepEqual(rB.body, { ok: true, chromePort: 9222, overlayInstalled: true });
    } finally {
      mockChromeFailMode = false;
      rmSync(portFileB, { force: true, maxRetries: 5, retryDelay: 100 });
      cleanupTmpDir(baseDirB);
    }
  });
});
