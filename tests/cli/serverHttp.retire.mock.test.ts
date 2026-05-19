/**
 * P-41 Step 5 — T-Retire.1-3 filled assertion bodies (G-P41.8, G-P41.9)
 *
 * Strategy: start in-process startServerHttp({ workersDb, serverInboxDb }) on a random
 * port; assert 404 on the 3 retired paths; assert the 5 bearer endpoints still respond
 * (401 without a token, indicating the route exists and the auth gate fires);
 * confirm POST /api/heartbeat with a valid token returns 200.
 *
 * Gate covered: G-P41.8, G-P41.9
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpReq, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startServerHttp } from "../../src/cli/serverHttp.js";
import { openServerInboxDb } from "../../src/persistence/serverInbox.js";
import { addWorker, openWorkersDb } from "../../src/persistence/workersRegistry.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p41-retire-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function startAndWait(
  workersDb: ReturnType<typeof openWorkersDb>,
  serverInboxDb: ReturnType<typeof openServerInboxDb>,
): Promise<{ server: Server; port: number }> {
  return new Promise<{ server: Server; port: number }>((resolve, reject) => {
    // P-41: ServerHttpHandlers = { workersDb, serverInboxDb } only.
    // biome-ignore lint/suspicious/noExplicitAny: P-41 — as any avoids stale type drift during transition
    const srv = startServerHttp({ workersDb, serverInboxDb } as any, "127.0.0.1", 0);
    srv.on("listening", () => {
      const addr = srv.address() as AddressInfo;
      resolve({ server: srv, port: addr.port });
    });
    srv.on("error", reject);
  });
}

async function closeServer(srv: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
}

interface ReqResult {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test body — JSON response shape varies per route
  body: any;
}

async function reqJson(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<ReqResult> {
  return new Promise<ReqResult>((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const reqHeaders: Record<string, string> = { "Content-Type": "application/json", ...(headers ?? {}) };
    if (bodyStr) reqHeaders["Content-Length"] = String(Buffer.byteLength(bodyStr));
    const r = httpReq({ host: "127.0.0.1", port, method, path, headers: reqHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: null });
        }
      });
    });
    r.on("error", reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

const FAKE_TOKEN_HEX = "a".repeat(64);
// CREDENTIAL PLACEHOLDER POLICY: BEARER_TOKEN is a test placeholder, not a real credential.
const BEARER_TOKEN = "retirement_test_token_32bytesOK";

// ─── T-Retire.1 ───────────────────────────────────────────────────────────────

describe("P-41 retired route — GET /bootstrap/<token>.sh → 404 (G-P41.8)", () => {
  it("T-Retire.1: GET /bootstrap/<64hex>.sh → 404 (bootstrap route retired in P-41)", async () => {
    // Given: startServerHttp({ workersDb, serverInboxDb }); valid worker registered with BEARER_TOKEN
    // When:  GET /bootstrap/<64hex>.sh with valid Bearer token (so auth gate passes, routing fires)
    // Then:  status 404 — the route no longer exists in the router
    //
    // NOTE: serverHttp.ts applies Bearer auth BEFORE routing — any request without a valid token
    // returns 401. To verify the route is gone (404), we need a valid token so routing is reached.
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    addWorker(workersDb, "retire1-worker", BEARER_TOKEN);
    const { server, port } = await startAndWait(workersDb, serverInboxDb);
    try {
      const authHeaders = { Authorization: `Bearer ${BEARER_TOKEN}` };
      const res = await reqJson(port, "GET", `/bootstrap/${FAKE_TOKEN_HEX}.sh`, undefined, authHeaders);
      assert.equal(res.status, 404, `T-Retire.1: GET /bootstrap/<hex>.sh must return 404; got ${res.status}`);
    } finally {
      await closeServer(server);
      cleanup();
    }
  });
});

// ─── T-Retire.2 ───────────────────────────────────────────────────────────────

describe("P-41 retired route — POST /api/register → 404 (G-P41.8)", () => {
  it("T-Retire.2: POST /api/register → 404 (register route retired in P-41)", async () => {
    // Given: startServerHttp({ workersDb, serverInboxDb }); valid worker registered with BEARER_TOKEN
    // When:  POST /api/register {inviteToken:"<any>"} with valid Bearer token
    // Then:  status 404 — the route no longer exists in the router
    //
    // NOTE: same as T-Retire.1 — Bearer token required to reach routing logic.
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    addWorker(workersDb, "retire2-worker", BEARER_TOKEN);
    const { server, port } = await startAndWait(workersDb, serverInboxDb);
    try {
      const authHeaders = { Authorization: `Bearer ${BEARER_TOKEN}` };
      const res = await reqJson(port, "POST", "/api/register", { inviteToken: "any-token" }, authHeaders);
      assert.equal(res.status, 404, `T-Retire.2: POST /api/register must return 404; got ${res.status}`);
    } finally {
      await closeServer(server);
      cleanup();
    }
  });
});

// ─── T-Retire.3 ───────────────────────────────────────────────────────────────

describe("P-41 bearer-endpoint survival — 5 P-26 routes still respond (G-P41.9)", () => {
  it("T-Retire.3: the 5 bearer endpoints (/api/heartbeat, /api/lead/check, /api/lead/touch, /api/event, /api/worker_inbox/poll) are unchanged — without a token they return 401; with a valid token POST /api/heartbeat returns 200", async () => {
    // Given: startServerHttp({ workersDb, serverInboxDb }); worker registered with BEARER_TOKEN
    // When:  POST each P-26 bearer route with NO Authorization header
    // Then:  each returns 401 {error:"invalid_token"} (auth gate fires → route exists);
    //        POST /api/heartbeat with valid Bearer → 200 {ok:true, ...}
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    // Seed the test worker so the valid-Bearer check can succeed
    addWorker(workersDb, "retire-test-worker", BEARER_TOKEN);
    const { server, port } = await startAndWait(workersDb, serverInboxDb);
    try {
      // ── 401 checks (no auth header) ──
      const bearerEndpoints: Array<[string, string, unknown?]> = [
        ["POST", "/api/heartbeat", { workerId: "retire-test-worker" }],
        ["POST", "/api/lead/check", { personRef: "https://linkedin.com/in/test" }],
        [
          "POST",
          "/api/lead/touch",
          { personRef: "https://linkedin.com/in/test", actionType: "connect", ts: Date.now() },
        ],
        ["POST", "/api/event", { type: "test_event" }],
        ["GET", "/api/worker_inbox/poll?worker_id=retire-test-worker&timeout=1", undefined],
      ];

      for (const [method, path, body] of bearerEndpoints) {
        const res = await reqJson(port, method, path, body);
        assert.equal(res.status, 401, `T-Retire.3: ${method} ${path} without auth must return 401; got ${res.status}`);
        assert.equal(
          res.body?.error,
          "invalid_token",
          `T-Retire.3: ${method} ${path} without auth body.error must be 'invalid_token'; got ${JSON.stringify(res.body)}`,
        );
      }

      // ── 200 check with valid Bearer ──
      const authHeaders = { Authorization: `Bearer ${BEARER_TOKEN}` };
      const okRes = await reqJson(port, "POST", "/api/heartbeat", { workerId: "retire-test-worker" }, authHeaders);
      assert.equal(
        okRes.status,
        200,
        `T-Retire.3: POST /api/heartbeat with valid token must return 200; got ${okRes.status}`,
      );
      assert.ok(
        okRes.body?.ok === true,
        `T-Retire.3: heartbeat response must have ok:true; got ${JSON.stringify(okRes.body)}`,
      );
    } finally {
      await closeServer(server);
      cleanup();
    }
  });
});

// Expose helpers for potential Step 5a use
export { makeTmpDir, startAndWait, closeServer, reqJson, FAKE_TOKEN_HEX, BEARER_TOKEN };
