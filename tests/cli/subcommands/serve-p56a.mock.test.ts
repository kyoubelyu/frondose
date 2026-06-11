/**
 * P-56a Step 5 — T-Serve.1, T-Serve.2, T-Serve.3, T-Serve.4
 * (G-P56a.1, G-P56a.2, G-P56a.3, G-P56a.4)
 *
 * Mock tests for `src/cli/subcommands/serve.ts`.
 *
 * Gate coverage:
 *   G-P56a.1 — `mai serve` exposes 3 endpoints over UDS with bearer-token auth
 *   G-P56a.2 — UDS perms: sock file `0o600` AND parent dir `0o700` (owner-only)
 *   G-P56a.3 — `GET /identity` returns `{ok:true, fullName, ...}` OR `{ok:false, reason}`
 *   G-P56a.4 — `POST /chrome/ensure` triggers `getOrInitClient()` and maps response envelope
 *
 * T-Serve.3 mock approach: `mock.module()` from `node:test` set up in a `before()`
 * hook before serve.ts is first imported. The hook mocks createLinkedinSession with
 * a stub controlled by `mockChromeFailMode`. tsx registers modules with .js URLs
 * so the mock specifier uses pathToFileURL + resolve(cwd, "src/linkedin/session.js").
 * If mock.module() fails (URL mismatch), T-Serve.3 fails and surfaces D-P56a-01.
 *
 * All tmp dirs via `mkdtempSync` — ZERO `~/.mai/` reads in mock tests.
 * T-Serve.2 identity isolation: `MAI_HOME_BASE=<tmpDir>` env override per OQ-5.
 * Server instances run fire-and-forget; event loop kept open until --test-force-exit.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpReq } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, it, mock } from "node:test";
import { pathToFileURL } from "node:url";

// ─── Session mock state (T-Serve.3) ──────────────────────────────────────────

/**
 * Controls behavior of the mocked `createLinkedinSession().getOrInitClient()`.
 * true  → returns {ok:false, error:"chrome_unavailable", message:"busy"} (503 path).
 * false → returns {ok:true, client:<stub>} (200 path).
 * Does NOT affect T-Serve.1/2/4 which never call POST /chrome/ensure.
 */
let mockChromeFailMode = false;

// ─── File-level setup: mock createLinkedinSession BEFORE serve.ts is imported ─

before(() => {
  // session.js must be mocked BEFORE serve.ts is first imported. This before() hook
  // runs before any describe/it in the file, so all serve.ts imports in tests get
  // the mocked createLinkedinSession. The mock specifier must match the URL that
  // tsx registers in the ESM module cache: tsx passes .js imports through as-is.
  const sessionUrl = pathToFileURL(resolve(process.cwd(), "src/linkedin/session.js")).href;
  mock.module(sessionUrl, {
    namedExports: {
      // biome-ignore lint/suspicious/noExplicitAny: stub factory — type does not need to match LinkedinSession exactly
      createLinkedinSession: (_opts: any) => ({
        inputMode: "cdp",
        async getOrInitClient() {
          if (mockChromeFailMode) {
            return { ok: false, error: "chrome_unavailable", message: "busy" };
          }
          // P-Z2: /chrome/ensure gained overlay wiring since P-56a (subscribeContextId +
          // attachEventBus, both real/un-mocked) — they read result.client.handle's CDP
          // methods. Provide a fake CdpHandle (Runtime/Page stubs) mirroring sibling
          // serve-p57b so the success path reaches 200 {overlayInstalled:true}.
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

  // P-Z2 (bucket 2b): once HOME is isolated there is no provider config, so
  // resolveModel({}) throws at modelResolver.ts:178 and the server never boots.
  // serve-p56b/p57a/p57c already mock this; serve-p56a is the latent hole the
  // npm-script footgun masked. Stub the resolver so the server boots cleanly.
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

// ─── UDS HTTP helper ─────────────────────────────────────────────────────────

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
 * Poll until sockPath exists (and optionally has a specific permission mode)
 * OR deadline_ms expires. Returns true if found.
 *
 * `awaitMode` (optional): if set, also wait until `statSync(sockPath).mode & 0o777 === awaitMode`.
 * Used by T-Serve.4 to avoid a race where the socket file appears on disk BEFORE
 * serve.ts's listen callback fires (which is where `chmodSync(sock, 0o600)` runs).
 * Polling until mode=0o600 guarantees the listen callback has already completed.
 */
async function pollForSock(sockPath: string, deadline_ms: number, awaitMode?: number): Promise<boolean> {
  const end = Date.now() + deadline_ms;
  while (Date.now() < end) {
    try {
      if (existsSync(sockPath)) {
        if (awaitMode === undefined) return true;
        if ((statSync(sockPath).mode & 0o777) === awaitMode) return true;
      }
    } catch {
      /* ignore transient stat errors */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// ─── T-Serve.1 — GET /health: auth variants (G-P56a.1) ──────────────────────

describe("runServeSubcommand — GET /health auth variants (G-P56a.1)", () => {
  it("T-Serve.1: given runServeSubcommand on a tmp UDS sock with bearer token 'tok123', WHEN (a) GET /health no Authorization header, (b) GET /health wrong bearer, (c) GET /health correct bearer, THEN (a) 401 {ok:false,error:'missing_bearer'}, (b) 401 {ok:false,error:'invalid_token'}, (c) 200 {ok:true,ts:<number>,pid:<number>}; after test sock cleaned up", async () => {
    // Given: tmp dir UDS sock path; bearer token "tok123"; runServeSubcommand started
    //        fire-and-forget; validator polls existsSync(sockPath) until true (max 2s)
    // When:  three HTTP requests via udsReq():
    //          (a) no Authorization → 401 {ok:false, error:"missing_bearer"}
    //          (b) Authorization: Bearer WRONG → 401 {ok:false, error:"invalid_token"}
    //          (c) Authorization: Bearer tok123 → 200 {ok:true, ts:<num>, pid:<num>}
    // Then:  pid === process.pid (runServeSubcommand runs in-process);
    //        ts is a number; sock cleaned up after rmSync

    const { runServeSubcommand } = await import("../../../src/cli/subcommands/serve.js");
    const baseDir = mkdtempSync(join(tmpdir(), "p56a-t1-"));
    const sockPath = join(baseDir, "mai.sock");
    const token = "tok123";

    // Fire-and-forget — server stays alive until --test-force-exit
    void runServeSubcommand({ sockPath, bearerToken: token });

    try {
      const found = await pollForSock(sockPath, 2000);
      assert.ok(found, `UDS sock did not appear within 2s: ${sockPath}`);

      // (a) no Authorization header → 401 missing_bearer
      const r1 = await udsReq({ socketPath: sockPath, method: "GET", path: "/health" });
      assert.equal(r1.status, 401, `(a) expected 401, got ${r1.status}`);
      assert.deepEqual(r1.body, { ok: false, error: "missing_bearer" });

      // (b) wrong bearer → 401 invalid_token
      const r2 = await udsReq({
        socketPath: sockPath,
        method: "GET",
        path: "/health",
        headers: { Authorization: "Bearer WRONG_TOKEN" },
      });
      assert.equal(r2.status, 401, `(b) expected 401, got ${r2.status}`);
      assert.deepEqual(r2.body, { ok: false, error: "invalid_token" });

      // (c) correct bearer → 200 {ok:true, ts:number, pid:number}
      const r3 = await udsReq({
        socketPath: sockPath,
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
      rmSync(sockPath, { force: true });
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

// ─── T-Serve.2 — GET /identity: identity set vs. not set (G-P56a.3) ─────────

describe("runServeSubcommand — GET /identity identity-set vs. not-set (G-P56a.3)", () => {
  it("T-Serve.2: given (A) tmp MAI_HOME_BASE with config.json containing fullName:'Test Operator' and (B) empty tmp MAI_HOME_BASE with no config.json, WHEN GET /identity with valid bearer, THEN (A) 200 {ok:true, fullName:'Test Operator', ...} and (B) 200 {ok:false, reason:'identity not set; open Frondose → Settings to complete setup'}", async () => {
    // Given: variant A — tmp dir as MAI_HOME_BASE;
    //          write <tmpDir>/.mai/agent/config.json with {schema_version:2, identity:{fullName:"Test Operator",...}}
    //          (authoritative path per P-28: readConfig returns cfg.identity)
    //        variant B — empty tmp dir as MAI_HOME_BASE; no config/identity files
    //        Both: runServeSubcommand started with tmp sock + bearer "tok456";
    //          process.env.MAI_HOME_BASE = <tmpDir> before starting server (per OQ-5)
    // When:  GET /identity with Authorization: Bearer tok456
    // Then:  variant A → 200 {ok:true, fullName:"Test Operator"} (200 even with ok:true)
    //        variant B → 200 {ok:false, reason:"identity not set; open Frondose → Settings to complete setup"}
    //          (200 status — absence of identity is a state, not HTTP error, per plan §6)
    //          P-APP-11 b1 PINNED: health.ts:12 = "identity not set; open Frondose → Settings to complete setup"

    const { runServeSubcommand } = await import("../../../src/cli/subcommands/serve.js");
    const origHome = process.env.MAI_HOME_BASE;

    // ── Variant A: identity set ──────────────────────────────────────────────
    const homeDirA = mkdtempSync(join(tmpdir(), "p56a-t2a-"));
    const configDirA = join(homeDirA, ".mai", "agent");
    mkdirSync(configDirA, { recursive: true });
    // Write valid config.json v2 with identity (Zod fills defaults for server/worker/etc)
    writeFileSync(
      join(configDirA, "config.json"),
      JSON.stringify({
        schema_version: 2,
        identity: { fullName: "Test Operator", updatedAt: "2024-01-01T00:00:00.000Z" },
      }),
    );
    const sockPathA = join(homeDirA, "a.sock");

    try {
      process.env.MAI_HOME_BASE = homeDirA;
      void runServeSubcommand({ sockPath: sockPathA, bearerToken: "tok456" });

      const foundA = await pollForSock(sockPathA, 2000);
      assert.ok(foundA, `sock A not ready within 2s: ${sockPathA}`);

      const rA = await udsReq({
        socketPath: sockPathA,
        method: "GET",
        path: "/identity",
        headers: { Authorization: "Bearer tok456" },
      });
      assert.equal(rA.status, 200, `variant A: expected 200, got ${rA.status}`);
      assert.equal(rA.body.ok, true, "variant A: ok should be true");
      assert.equal(rA.body.fullName, "Test Operator", "variant A: fullName should match");
    } finally {
      rmSync(sockPathA, { force: true });
      rmSync(homeDirA, { recursive: true, force: true });
    }

    // ── Variant B: no identity ───────────────────────────────────────────────
    const homeDirB = mkdtempSync(join(tmpdir(), "p56a-t2b-"));
    const sockPathB = join(homeDirB, "b.sock");

    try {
      process.env.MAI_HOME_BASE = homeDirB;
      void runServeSubcommand({ sockPath: sockPathB, bearerToken: "tok456" });

      const foundB = await pollForSock(sockPathB, 2000);
      assert.ok(foundB, `sock B not ready within 2s: ${sockPathB}`);

      const rB = await udsReq({
        socketPath: sockPathB,
        method: "GET",
        path: "/identity",
        headers: { Authorization: "Bearer tok456" },
      });
      assert.equal(rB.status, 200, `variant B: expected 200, got ${rB.status}`);
      assert.equal(rB.body.ok, false, "variant B: ok should be false");
      assert.equal(rB.body.reason, "identity not set; open Frondose → Settings to complete setup", "variant B: reason must match exactly (P-APP-11 b1 PINNED)");
    } finally {
      rmSync(sockPathB, { force: true });
      rmSync(homeDirB, { recursive: true, force: true });
      // Restore MAI_HOME_BASE regardless of test outcome
      if (origHome !== undefined) {
        process.env.MAI_HOME_BASE = origHome;
      } else {
        delete process.env.MAI_HOME_BASE;
      }
    }
  });
});

// ─── T-Serve.3 — POST /chrome/ensure: guard denied + success path (G-P56a.4) ─

describe("runServeSubcommand — POST /chrome/ensure guard-denied + success (G-P56a.4)", () => {
  it("T-Serve.3: given (a) mocked createLinkedinSession.getOrInitClient → {ok:false, error:'chrome_unavailable', message:'busy'} and (b) mocked getOrInitClient → {ok:true, client:<stub>}, WHEN POST /chrome/ensure with valid bearer, THEN (a) 503 {ok:false, error:'chrome_unavailable', message:'busy'} and (b) 200 {ok:true, chromePort:9222, overlayInstalled:true}", async () => {
    // Given: session.js mocked via mock.module() in before() hook above.
    //        mockChromeFailMode=true → getOrInitClient returns {ok:false, error:'chrome_unavailable', message:'busy'}
    //        mockChromeFailMode=false → getOrInitClient returns {ok:true, client:<stub>}
    //        Both sub-cases use runServeSubcommand on separate tmp socks + bearer "tok789"
    // When:  POST /chrome/ensure with Authorization: Bearer tok789
    // Then:  sub-case (a): status 503, body {ok:false, error:'chrome_unavailable', message:'busy'}
    //        sub-case (b): status 200, body deep-equals {ok:true, chromePort:9222, overlayInstalled:true}
    //
    // NOTE: If mock.module() did not intercept (tsx URL mismatch), this test will fail
    // because the real getOrInitClient() either throws (→500) or returns {ok:true} (→200).
    // A 503/real-chrome failure here surfaces D-P56a-01: mock.module() URL mismatch.

    const { runServeSubcommand } = await import("../../../src/cli/subcommands/serve.js");

    // ── Sub-case (a): fail mode ──────────────────────────────────────────────
    mockChromeFailMode = true;
    const baseDirA = mkdtempSync(join(tmpdir(), "p56a-t3a-"));
    const sockPathA = join(baseDirA, "mai.sock");

    try {
      void runServeSubcommand({ sockPath: sockPathA, bearerToken: "tok789" });
      assert.ok(await pollForSock(sockPathA, 2000), `sock A not ready: ${sockPathA}`);

      const rA = await udsReq({
        socketPath: sockPathA,
        method: "POST",
        path: "/chrome/ensure",
        headers: { Authorization: "Bearer tok789" },
      });
      assert.equal(rA.status, 503, `sub-case (a): expected 503, got ${rA.status}`);
      assert.deepEqual(rA.body, { ok: false, error: "chrome_unavailable", message: "busy" });
    } finally {
      rmSync(sockPathA, { force: true });
      rmSync(baseDirA, { recursive: true, force: true });
    }

    // ── Sub-case (b): success mode ───────────────────────────────────────────
    mockChromeFailMode = false;
    const baseDirB = mkdtempSync(join(tmpdir(), "p56a-t3b-"));
    const sockPathB = join(baseDirB, "mai.sock");

    try {
      void runServeSubcommand({ sockPath: sockPathB, bearerToken: "tok789" });
      assert.ok(await pollForSock(sockPathB, 2000), `sock B not ready: ${sockPathB}`);

      const rB = await udsReq({
        socketPath: sockPathB,
        method: "POST",
        path: "/chrome/ensure",
        headers: { Authorization: "Bearer tok789" },
      });
      assert.equal(rB.status, 200, `sub-case (b): expected 200, got ${rB.status}`);
      assert.deepEqual(rB.body, { ok: true, chromePort: 9222, overlayInstalled: true });
    } finally {
      mockChromeFailMode = false; // reset to safe default
      rmSync(sockPathB, { force: true });
      rmSync(baseDirB, { recursive: true, force: true });
    }
  });
});

// ─── T-Serve.4 — chmod 0o700 parent dir + 0o600 sock (G-P56a.2) ─────────────

describe("runServeSubcommand — UDS permissions invariant: parent dir 0o700 + sock 0o600 (G-P56a.2)", () => {
  it("T-Serve.4: given a tmp dir with a fresh sub-dir (parent NOT yet created) and sock path inside it, WHEN runServeSubcommand starts and listen fires (pollForSock true within 2s), THEN statSync(parentDir).mode & 0o777 === 0o700 AND statSync(sockPath).mode & 0o777 === 0o600; after rmSync, existsSync(sockPath) === false", async () => {
    // Given: baseDir = mkdtempSync(join(tmpdir(),"p56a-perm-"));
    //        parentDir = join(baseDir, "sub"); — does NOT exist yet (serve.ts creates it)
    //        sockPath = join(parentDir, "mai.sock"); bearer "tok-perm"
    //        runServeSubcommand started fire-and-forget
    // When:  validator polls existsSync(sockPath) until true (max 2s)
    // Then:  statSync(parentDir).mode & 0o777 === 0o700 (parent dir owner-only)
    //        statSync(sockPath).mode & 0o777 === 0o600 (sock file owner-only)
    //        Note: macOS reports socket mode as e.g. 0o140600 (full mode bits);
    //        the & 0o777 mask isolates permission bits (plan §6 T-Serve.4 portability note)
    // After: rmSync sock → existsSync(sockPath) === false

    const { runServeSubcommand } = await import("../../../src/cli/subcommands/serve.js");
    const baseDir = mkdtempSync(join(tmpdir(), "p56a-perm-"));
    const parentDir = join(baseDir, "sub"); // does NOT exist yet — serve.ts creates it
    const sockPath = join(parentDir, "mai.sock");

    void runServeSubcommand({ sockPath, bearerToken: "tok-perm" });

    try {
      // Poll until mode=0o600 to ensure serve.ts's listen callback has already run.
      // The socket file appears on disk BEFORE the listen callback fires (mode=0o755);
      // we must wait until chmodSync(sock, 0o600) completes before inspecting or rmSync-ing,
      // otherwise the rmSync races with serve.ts's chmodSync → ENOENT crash in serve.ts.
      const found = await pollForSock(sockPath, 2000, 0o600);
      assert.ok(found, `UDS sock did not reach mode 0o600 within 2s: ${sockPath}`);

      // Parent dir: chmodSync(parentDir, 0o700) in serve.ts — checked after sock is ready
      const dirMode = statSync(parentDir).mode & 0o777;
      assert.equal(dirMode, 0o700, `parentDir mode should be 0o700, got 0o${dirMode.toString(8)}`);

      // Sock file: serve.ts chmodSync(sockPath, 0o600) already ran (poll guaranteed it)
      // macOS socket mode is e.g. 0o140600 (0o140000 = socket type bits + 0o600 perms)
      const sockMode = statSync(sockPath).mode & 0o777;
      assert.equal(sockMode, 0o600, `sockPath mode should be 0o600, got 0o${sockMode.toString(8)}`);
    } finally {
      rmSync(sockPath, { force: true });
      rmSync(baseDir, { recursive: true, force: true });
    }

    // After rmSync: sock no longer exists
    assert.equal(existsSync(sockPath), false, "sock should not exist after rmSync");
  });
});
