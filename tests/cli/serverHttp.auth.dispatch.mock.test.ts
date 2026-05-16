/**
 * P-27 Step 5 — T-AUTH.1..6
 *
 * Tests for the auth-dispatch restructure in serverHttp.ts:
 *   GET /bootstrap/<any>.sh → public (no Bearer required)
 *   POST /api/register      → invite-token route (body field, not Bearer)
 *   All other routes        → Bearer gate (unchanged from P-26)
 *
 * Gate coverage: G-P27.10 (auth dispatch + P-26 Bearer regression)
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpReq, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startServerHttp } from "../../src/cli/serverHttp.js";
import { insertInvite, openInvitesDb } from "../../src/persistence/invitesRegistry.js";
import { openServerInboxDb } from "../../src/persistence/serverInbox.js";
import { addWorker, openWorkersDb } from "../../src/persistence/workersRegistry.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p27-auth-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function startAndWait(handlers: {
  workersDb: ReturnType<typeof openWorkersDb>;
  serverInboxDb: ReturnType<typeof openServerInboxDb>;
  invitesDb: ReturnType<typeof openInvitesDb>;
  personasDir: string;
  serverUrl: string;
  maiVersion: string;
  credentialsDb?: null; // P-28: 7th field (null until builder Step 4b)
}): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    // biome-ignore lint/suspicious/noExplicitAny: P-28 extends to 7 fields
    const srv = startServerHttp({ ...handlers, credentialsDb: handlers.credentialsDb ?? null } as any, "127.0.0.1", 0);
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

interface RawResult {
  status: number;
  body: string;
}

/** Plain HTTP request — returns status + raw text body (no JSON.parse). */
async function getRaw(port: number, path: string): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const r = httpReq({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") });
      });
    });
    r.on("error", reject);
    r.end();
  });
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

// ─── T-AUTH.1 ─────────────────────────────────────────────────────────────────

describe("GET /bootstrap/<any>.sh — classified as PUBLIC (no Bearer needed) (G-P27.10)", () => {
  it("T-AUTH.1: GET /bootstrap/<valid-token>.sh with NO Authorization header reaches handleBootstrapScript and does NOT return 401", async () => {
    // Given: server running with 6-field handlers; invitesDb open with pending invite
    // When:  GET /bootstrap/<hex>.sh — no Authorization header at all
    // Then:  response is NOT 401 {error:'invalid_token'} — route classified as public
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const plainToken = "a1a1a1a1".repeat(8);
    const tokenSha = sha256(plainToken);
    insertInvite(invitesDb, tokenSha, "p1", null, Date.now() + 3_600_000);
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: "http://srv",
      maiVersion: "0.4.24",
    });
    try {
      // Use getRaw — response is text/x-sh (bash script), not JSON
      const res = await getRaw(port, `/bootstrap/${plainToken}.sh`);
      // Must NOT be 401 (that would mean the Bearer gate fired)
      assert.notEqual(res.status, 401, "bootstrap route must NOT require Bearer auth");
      // Pending invite → 200 (bootstrap script handler returns 200 for pending invites)
      assert.equal(res.status, 200, `expected 200 for pending invite; got ${res.status}; body: ${res.body.slice(0, 60)}`);
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-AUTH.2 ─────────────────────────────────────────────────────────────────

describe("POST /api/register — classified as INVITE-TOKEN route (body field, not Bearer) (G-P27.10)", () => {
  it("T-AUTH.2: POST /api/register with NO Authorization header reaches handleRegister and does NOT return 401 from Bearer gate", async () => {
    // Given: server running; invitesDb + workersDb open; personasDir configured
    // When:  POST /api/register {inviteToken: '<plaintext>'} — no Authorization header
    // Then:  response is NOT 401 from Bearer gate (error:'invalid_token');
    //        may be 401 from invite-token validation (error:'invite invalid or consumed') for bad token
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: "http://srv",
      maiVersion: "0.4.24",
    });
    try {
      // Use a valid-format token (64 hex chars) not in DB → invite validation 401
      const fakeToken = "b2b2b2b2".repeat(8);
      const res = await reqJson(port, "POST", "/api/register", { inviteToken: fakeToken });
      // Must NOT be 401 from Bearer gate {error:'invalid_token'}
      // It may be 401 from invite validation with a DIFFERENT error message
      if (res.status === 401) {
        assert.notEqual(
          res.body?.error,
          "invalid_token",
          "if 401, error must NOT be 'invalid_token' (Bearer gate must not fire for /api/register)",
        );
      }
      // The status should be 401 from invite validation, not from Bearer gate
      assert.equal(
        res.body?.error,
        "invite invalid or consumed",
        `expected invite-validation 401, not Bearer-gate 401; got: ${JSON.stringify(res.body)}`,
      );
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-AUTH.3 ─────────────────────────────────────────────────────────────────

describe("POST /api/heartbeat — Bearer gate regression (G-P27.10)", () => {
  it("T-AUTH.3: POST /api/heartbeat with NO Authorization header returns 401 {error:'invalid_token'}", async () => {
    // Given: workers.sqlite has active worker; server running
    // When:  POST /api/heartbeat with NO Authorization header
    // Then:  status 401; body {error:'invalid_token'} — Bearer gate unchanged from P-26
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    addWorker(workersDb, "auth_test_w3", WORKER_TOKEN);
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: "http://srv",
      maiVersion: "0.4.24",
    });
    try {
      const res = await reqJson(port, "POST", "/api/heartbeat", { workerId: "auth_test_w3", hostname: "h1" });
      assert.equal(res.status, 401, `expected 401 without Bearer; got ${res.status}`);
      assert.equal(res.body?.error, "invalid_token");
    } finally {
      await closeServer(server);
      invitesDb.close();
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
    const invitesDb = openInvitesDb(":memory:");
    addWorker(workersDb, "auth_test_w4", WORKER_TOKEN);
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: "http://srv",
      maiVersion: "0.4.24",
    });
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
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-AUTH.5 ─────────────────────────────────────────────────────────────────

describe("POST /api/lead/check — Bearer gate regression (G-P27.10)", () => {
  it("T-AUTH.5: POST /api/lead/check with no Bearer header returns 401 (all 5 P-26 routes still gate on Bearer)", async () => {
    // Given: server running with 6-field handlers
    // When:  POST /api/lead/check with no Authorization header
    // Then:  status 401; body {error:'invalid_token'}
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: "http://srv",
      maiVersion: "0.4.24",
    });
    try {
      const res = await reqJson(port, "POST", "/api/lead/check", {
        personRef: "https://linkedin.com/in/test",
      });
      assert.equal(res.status, 401, `expected 401; got ${res.status}`);
      assert.equal(res.body?.error, "invalid_token");
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-AUTH.6 ─────────────────────────────────────────────────────────────────

describe("GET /api/worker_inbox/poll — Bearer gate regression (G-P27.10)", () => {
  it("T-AUTH.6: GET /api/worker_inbox/poll?timeout=0 with no Bearer header returns 401", async () => {
    // Given: server running with 6-field handlers
    // When:  GET /api/worker_inbox/poll?timeout=0 — no Authorization header
    // Then:  status 401; body {error:'invalid_token'}
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: "http://srv",
      maiVersion: "0.4.24",
    });
    try {
      const res = await reqJson(port, "GET", "/api/worker_inbox/poll?worker_id=w1&timeout=1");
      assert.equal(res.status, 401, `expected 401; got ${res.status}`);
      assert.equal(res.body?.error, "invalid_token");
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});
