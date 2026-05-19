/**
 * P-27 Step 5 — T-AUTH.3..6 (bearer gate regression)
 *
 * P-41 pruning: T-AUTH.1 (GET /bootstrap/<any>.sh → public) and
 * T-AUTH.2 (POST /api/register → invite-token route) are RETIRED along
 * with the bootstrap + register machinery. Only the 4 bearer-gate
 * regression tests (T-AUTH.3-6) survive.
 *
 * Tests for the auth-dispatch in serverHttp.ts:
 *   All P-26 bearer endpoints → Bearer gate (unchanged from P-26)
 *
 * Gate coverage: G-P27.10 (Bearer regression)
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

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p27-auth-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function startAndWait(
  workersDb: ReturnType<typeof openWorkersDb>,
  serverInboxDb: ReturnType<typeof openServerInboxDb>,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    // P-41: ServerHttpHandlers = { workersDb, serverInboxDb } only; as any bridges pre/post-4b
    // biome-ignore lint/suspicious/noExplicitAny: P-41 transition
    const srv = startServerHttp({ workersDb, serverInboxDb } as any, "127.0.0.1", 0);
    srv.on("listening", () => resolve({ server: srv, port: (srv.address() as AddressInfo).port }));
    srv.on("error", reject);
  });
}

async function closeServer(srv: Server): Promise<void> {
  return new Promise((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
}

interface JsonResult {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test body
  body: any;
}

async function reqJson(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<JsonResult> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const reqHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    };
    if (bodyStr) reqHeaders["Content-Length"] = String(Buffer.byteLength(bodyStr));
    const r = httpReq({ host: "127.0.0.1", port, method, path, headers: reqHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) });
        } catch (e) {
          reject(e);
        }
      });
    });
    r.on("error", reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

const WORKER_TOKEN = "worker_auth_test_token_32bytes_OK";

// ─── T-AUTH.3 ─────────────────────────────────────────────────────────────────

describe("POST /api/heartbeat — Bearer gate regression (G-P27.10)", () => {
  it("T-AUTH.3: POST /api/heartbeat with NO Authorization header returns 401 {error:'invalid_token'}", async () => {
    // Given: workers.sqlite has active worker; server running (P-41: { workersDb, serverInboxDb } only)
    // When:  POST /api/heartbeat with NO Authorization header
    // Then:  status 401; body {error:'invalid_token'} — Bearer gate unchanged from P-26
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    addWorker(workersDb, "auth_test_w3", WORKER_TOKEN);
    const { server, port } = await startAndWait(workersDb, serverInboxDb);
    try {
      const res = await reqJson(port, "POST", "/api/heartbeat", { workerId: "auth_test_w3", hostname: "h1" });
      assert.equal(res.status, 401, `expected 401 without Bearer; got ${res.status}`);
      assert.equal(res.body?.error, "invalid_token");
    } finally {
      await closeServer(server);
      cleanup();
    }
  });
});

// ─── T-AUTH.4 ─────────────────────────────────────────────────────────────────

describe("POST /api/heartbeat — valid Bearer token (G-P27.10 regression)", () => {
  it("T-AUTH.4: POST /api/heartbeat with valid Bearer worker token returns 200 (P-26 behavior unchanged)", async () => {
    // Given: workers.sqlite has worker with token=WORKER_TOKEN
    // When:  POST /api/heartbeat with Authorization: Bearer WORKER_TOKEN
    //        body: {workerId:'auth_test_w4', hostname:'h1'}
    // Then:  status 200; body {ok:true, pendingMessages:0}
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    addWorker(workersDb, "auth_test_w4", WORKER_TOKEN);
    const { server, port } = await startAndWait(workersDb, serverInboxDb);
    try {
      const res = await reqJson(
        port,
        "POST",
        "/api/heartbeat",
        { workerId: "auth_test_w4", hostname: "h1" },
        { Authorization: `Bearer ${WORKER_TOKEN}` },
      );
      assert.equal(res.status, 200, `expected 200 with valid Bearer; got ${res.status}`);
      assert.equal(res.body?.ok, true);
      assert.equal(res.body?.pendingMessages, 0);
    } finally {
      await closeServer(server);
      cleanup();
    }
  });
});

// ─── T-AUTH.5 ─────────────────────────────────────────────────────────────────

describe("POST /api/lead/check — Bearer gate regression (G-P27.10)", () => {
  it("T-AUTH.5: POST /api/lead/check with no Bearer header returns 401 (all 5 P-26 routes still gate on Bearer)", async () => {
    // Given: server running with { workersDb, serverInboxDb } handlers
    // When:  POST /api/lead/check with no Authorization header
    // Then:  status 401; body {error:'invalid_token'}
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const { server, port } = await startAndWait(workersDb, serverInboxDb);
    try {
      const res = await reqJson(port, "POST", "/api/lead/check", {
        personRef: "https://linkedin.com/in/test",
      });
      assert.equal(res.status, 401, `expected 401; got ${res.status}`);
      assert.equal(res.body?.error, "invalid_token");
    } finally {
      await closeServer(server);
      cleanup();
    }
  });
});

// ─── T-AUTH.6 ─────────────────────────────────────────────────────────────────

describe("GET /api/worker_inbox/poll — Bearer gate regression (G-P27.10)", () => {
  it("T-AUTH.6: GET /api/worker_inbox/poll?timeout=0 with no Bearer header returns 401", async () => {
    // Given: server running with { workersDb, serverInboxDb } handlers
    // When:  GET /api/worker_inbox/poll?timeout=0 — no Authorization header
    // Then:  status 401; body {error:'invalid_token'}
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const { server, port } = await startAndWait(workersDb, serverInboxDb);
    try {
      const res = await reqJson(port, "GET", "/api/worker_inbox/poll?worker_id=w1&timeout=1");
      assert.equal(res.status, 401, `expected 401; got ${res.status}`);
      assert.equal(res.body?.error, "invalid_token");
    } finally {
      await closeServer(server);
      cleanup();
    }
  });
});
