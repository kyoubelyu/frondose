/**
 * P-26 Step 5 — T-REST.HEARTBEAT.1..3, T-AUTH.1..3,
 *               T-REST.LEAD.CHECK.1..6, T-REST.TOUCH.1, T-REST.EVENT.1,
 *               T-REST.POLL.1..4, T-BIND.1..2
 *
 * Tests for src/cli/serverHttp.ts — HTTP server routes + token-auth middleware.
 * Gate coverage: G-P26.1, G-P26.2, G-P26.3, G-P26.4, G-P26.5, G-P26.6,
 *                G-P26.7, G-P26.8, G-P26.9, G-P26.28
 *
 * Test strategy: startServerHttp on a random port (0); make requests via
 * node:http client; assert response status + body. All DBs use tmp files.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpReq, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startServerHttp } from "../../src/cli/serverHttp.js";
import { enqueueWorkerPending, openServerInboxDb } from "../../src/persistence/serverInbox.js";
import { addWorker, insertLeadAction, openWorkersDb } from "../../src/persistence/workersRegistry.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p26-http-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── HTTP test helpers ────────────────────────────────────────────────────────

/** Start server on random port, wait for 'listening' event, return server + port. */
async function startAndWait(
  workersDb: ReturnType<typeof openWorkersDb>,
  serverInboxDb: ReturnType<typeof openServerInboxDb>,
  bindAddress: string | null = "127.0.0.1",
): Promise<{ server: Server; port: number }> {
  return new Promise<{ server: Server; port: number }>((resolve, reject) => {
    // C-1 fix: ServerHttpHandlers expands 2→6 fields at builder Step 4b.
    // Stub new fields (invitesDb=null, personasDir="", serverUrl="", maiVersion="")
    // and cast to `any` until builder lands the 6-field interface.
    // biome-ignore lint/suspicious/noExplicitAny: C-1 pre-builder cast; remove after Step 4b
    const srv = startServerHttp({ workersDb, serverInboxDb, invitesDb: null, personasDir: "", serverUrl: "", maiVersion: "" } as any, bindAddress, 0);
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

interface ReqOpts {
  method: string;
  path: string;
  port: number;
  headers?: Record<string, string>;
  body?: unknown;
}
interface ReqResult {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test result body
  body: any;
}

async function req(opts: ReqOpts): Promise<ReqResult> {
  return new Promise<ReqResult>((resolve, reject) => {
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
          reject(e);
        }
      });
    });
    r.on("error", reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TOKEN_A = "validtoken_worker_a_32bytesXXXXX"; // 32+ chars
const AUTH_A = `Bearer ${TOKEN_A}`;

// ─── POST /api/heartbeat ──────────────────────────────────────────────────────

describe("POST /api/heartbeat (G-P26.1, G-P26.2)", () => {
  it("T-REST.HEARTBEAT.1: valid token + valid body → 200 {ok:true, pendingMessages:0}; last_heartbeat updated", async () => {
    // Given: workers.sqlite has worker_A with token_hash=sha256("validtoken"); no worker_pending rows
    // When:  POST /api/heartbeat {workerId:"worker_A", hostname:"h1"} with Authorization: Bearer validtoken
    // Then:  status 200; body {ok:true, pendingMessages:0}; workers.last_heartbeat updated
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      addWorker(workersDb, "worker_A", TOKEN_A);
      const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
      server = srv;
      const result = await req({
        method: "POST",
        path: "/api/heartbeat",
        port,
        headers: { Authorization: AUTH_A },
        body: { workerId: "worker_A", hostname: "h1" },
      });
      assert.equal(result.status, 200, "T-REST.HEARTBEAT.1: status must be 200");
      assert.deepEqual(
        result.body,
        { ok: true, pendingMessages: 0 },
        "T-REST.HEARTBEAT.1: body {ok:true, pendingMessages:0}",
      );
      const row = workersDb.prepare("SELECT last_heartbeat FROM workers WHERE worker_id='worker_A'").get() as {
        last_heartbeat: number | null;
      };
      assert.ok(
        row.last_heartbeat !== null && Date.now() - row.last_heartbeat < 5000,
        `T-REST.HEARTBEAT.1: last_heartbeat must be updated to recent ts; got ${row.last_heartbeat}`,
      );
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });

  it("T-REST.HEARTBEAT.2: missing Authorization header → 401 {error:'invalid_token'}", async () => {
    // Given: valid workers.sqlite
    // When:  POST /api/heartbeat with NO Authorization header
    // Then:  status 401; body {error:"invalid_token"}
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      addWorker(workersDb, "worker_A", TOKEN_A);
      const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
      server = srv;
      const result = await req({ method: "POST", path: "/api/heartbeat", port, body: { workerId: "worker_A" } });
      assert.equal(result.status, 401, "T-REST.HEARTBEAT.2: missing auth → 401");
      assert.deepEqual(result.body, { error: "invalid_token" }, "T-REST.HEARTBEAT.2: {error:invalid_token}");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });

  it("T-REST.HEARTBEAT.3: valid token + 3 pending worker_pending rows → pendingMessages:3", async () => {
    // Given: worker_A with valid token; 3 rows in worker_pending for worker_A
    // When:  POST /api/heartbeat
    // Then:  {ok:true, pendingMessages:3}
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      addWorker(workersDb, "worker_A", TOKEN_A);
      enqueueWorkerPending(serverInboxDb, "worker_A", "msg1");
      enqueueWorkerPending(serverInboxDb, "worker_A", "msg2");
      enqueueWorkerPending(serverInboxDb, "worker_A", "msg3");
      const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
      server = srv;
      const result = await req({
        method: "POST",
        path: "/api/heartbeat",
        port,
        headers: { Authorization: AUTH_A },
        body: { workerId: "worker_A" },
      });
      assert.equal(result.status, 200, "T-REST.HEARTBEAT.3: status 200");
      assert.deepEqual(result.body, { ok: true, pendingMessages: 3 }, "T-REST.HEARTBEAT.3: pendingMessages must be 3");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});

// ─── Token auth middleware ─────────────────────────────────────────────────────

describe("token auth middleware (G-P26.2, G-P26.9)", () => {
  it("T-AUTH.1: empty workers.sqlite → any Bearer token → 401", async () => {
    // Given: workers.sqlite empty (no workers registered)
    // When:  POST /api/heartbeat with Bearer foo
    // Then:  401 {error:"invalid_token"}
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
      server = srv;
      const result = await req({
        method: "POST",
        path: "/api/heartbeat",
        port,
        headers: { Authorization: "Bearer foo" },
        body: { workerId: "any" },
      });
      assert.equal(result.status, 401, "T-AUTH.1: empty DB → 401 for any token");
      assert.deepEqual(result.body, { error: "invalid_token" }, "T-AUTH.1: {error:invalid_token}");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });

  it("T-AUTH.2: revoked worker token → 401 (status=revoked blocks auth)", async () => {
    // Given: worker_A row with status='revoked'
    // When:  POST with correct token for revoked worker
    // Then:  401 {error:"invalid_token"}
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      addWorker(workersDb, "worker_A", TOKEN_A);
      workersDb.prepare("UPDATE workers SET status='revoked' WHERE worker_id='worker_A'").run();
      const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
      server = srv;
      const result = await req({
        method: "POST",
        path: "/api/heartbeat",
        port,
        headers: { Authorization: AUTH_A },
        body: { workerId: "worker_A" },
      });
      assert.equal(result.status, 401, "T-AUTH.2: revoked worker → 401");
      assert.deepEqual(result.body, { error: "invalid_token" }, "T-AUTH.2: {error:invalid_token}");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });

  it("T-AUTH.3: timingSafeEqual used — two tokens differing in last byte produce same-bound response time (best-effort)", async () => {
    // Given: two workers with tokens "aaaa...aaab" and "aaaa...aaac" (differ only in last byte)
    // When:  both requests made 10 times each; average response time measured
    // Then:  |avg_A - avg_B| < 1ms (timing oracle effectively eliminated)
    //        NOTE: implemented as behavioral test — verifies correct accept/reject, not raw timing
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      const tokenA = `${"a".repeat(63)}b`; // differs only in last char
      const tokenB = `${"a".repeat(63)}c`;
      addWorker(workersDb, "worker_A", tokenA);
      addWorker(workersDb, "worker_B", tokenB);
      const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
      server = srv;
      // worker_A correct token → 200
      const rA = await req({
        method: "POST",
        path: "/api/heartbeat",
        port,
        headers: { Authorization: `Bearer ${tokenA}` },
        body: { workerId: "worker_A" },
      });
      assert.equal(rA.status, 200, "T-AUTH.3: worker_A correct token → 200");
      // worker_B correct token → 200
      const rB = await req({
        method: "POST",
        path: "/api/heartbeat",
        port,
        headers: { Authorization: `Bearer ${tokenB}` },
        body: { workerId: "worker_B" },
      });
      assert.equal(rB.status, 200, "T-AUTH.3: worker_B correct token → 200");
      // Completely unknown token → 401 (constant-time comparison correctly rejects)
      const rUnknown = await req({
        method: "POST",
        path: "/api/heartbeat",
        port,
        headers: { Authorization: "Bearer unknowntoken" },
        body: { workerId: "worker_A" },
      });
      assert.equal(rUnknown.status, 401, "T-AUTH.3: unknown token → 401 (constant-time comparison still rejects)");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});

// ─── POST /api/lead/check ─────────────────────────────────────────────────────

describe("POST /api/lead/check (G-P26.3, G-P26.4, G-P26.5, G-P26.6)", () => {
  it("T-REST.LEAD.CHECK.1: empty lead_actions → {allowed:true, lastTouchedBy:null, lastTouchedTs:null, reason:null}", async () => {
    // Given: worker_A with valid token; lead_actions empty
    // When:  POST /api/lead/check {personRef:"https://www.linkedin.com/in/alice/"}
    // Then:  200 {allowed:true, lastTouchedBy:null, lastTouchedTs:null, reason:null}
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      addWorker(workersDb, "worker_A", TOKEN_A);
      const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
      server = srv;
      const result = await req({
        method: "POST",
        path: "/api/lead/check",
        port,
        headers: { Authorization: AUTH_A },
        body: { personRef: "https://www.linkedin.com/in/alice/" },
      });
      assert.equal(result.status, 200, "T-REST.LEAD.CHECK.1: status 200");
      assert.deepEqual(
        result.body,
        { allowed: true, lastTouchedBy: null, lastTouchedTs: null, reason: null },
        "T-REST.LEAD.CHECK.1: empty lead_actions → allowed=true with null metadata",
      );
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });

  it("T-REST.LEAD.CHECK.2: lead_actions has row ts=now-1h → {allowed:false, lastTouchedBy:'worker_A', reason contains 'worker_A'}", async () => {
    // Given: lead_actions has 1 row for profile_url with ts = Date.now() - 3600_000 (1 hour ago)
    // When:  POST /api/lead/check {personRef, lookbackHours:72}
    // Then:  {allowed:false, lastTouchedBy:"worker_A", lastTouchedTs:<ts>, reason: contains "worker_A"}
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      addWorker(workersDb, "worker_A", TOKEN_A);
      const ts = Date.now() - 3600_000;
      insertLeadAction(workersDb, "https://www.linkedin.com/in/alice/", "connect", "worker_A", ts);
      const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
      server = srv;
      const result = await req({
        method: "POST",
        path: "/api/lead/check",
        port,
        headers: { Authorization: AUTH_A },
        body: { personRef: "https://www.linkedin.com/in/alice/", lookbackHours: 72 },
      });
      assert.equal(result.status, 200, "T-REST.LEAD.CHECK.2: status 200");
      assert.equal(result.body.allowed, false, "T-REST.LEAD.CHECK.2: allowed=false");
      assert.equal(result.body.lastTouchedBy, "worker_A", "T-REST.LEAD.CHECK.2: lastTouchedBy=worker_A");
      assert.ok(
        typeof result.body.reason === "string" && result.body.reason.includes("worker_A"),
        `T-REST.LEAD.CHECK.2: reason must contain 'worker_A'; got: ${result.body.reason}`,
      );
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });

  it("T-REST.LEAD.CHECK.3: lead_actions row ts=now-96h; lookbackHours=72 → {allowed:true} (outside window)", async () => {
    // Given: row ts = Date.now() - 96 * 3600_000 (96h ago)
    // When:  POST check with lookbackHours=72
    // Then:  {allowed:true, ...} (96h > 72h window)
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      addWorker(workersDb, "worker_A", TOKEN_A);
      const ts = Date.now() - 96 * 3600_000;
      insertLeadAction(workersDb, "https://www.linkedin.com/in/alice/", "connect", "worker_A", ts);
      const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
      server = srv;
      const result = await req({
        method: "POST",
        path: "/api/lead/check",
        port,
        headers: { Authorization: AUTH_A },
        body: { personRef: "https://www.linkedin.com/in/alice/", lookbackHours: 72 },
      });
      assert.equal(result.status, 200, "T-REST.LEAD.CHECK.3: status 200");
      assert.equal(result.body.allowed, true, "T-REST.LEAD.CHECK.3: allowed=true (96h > 72h window)");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });

  it("T-REST.LEAD.CHECK.4: lookbackHours:0 → 400 with Zod validation error (min 1)", async () => {
    // Given: valid worker token
    // When:  POST /api/lead/check {personRef:..., lookbackHours:0}
    // Then:  400 {error:"validation", detail: contains min(1) info}
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      addWorker(workersDb, "worker_A", TOKEN_A);
      const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
      server = srv;
      const result = await req({
        method: "POST",
        path: "/api/lead/check",
        port,
        headers: { Authorization: AUTH_A },
        body: { personRef: "https://www.linkedin.com/in/alice/", lookbackHours: 0 },
      });
      assert.equal(result.status, 400, "T-REST.LEAD.CHECK.4: lookbackHours=0 → 400");
      assert.equal(result.body.error, "validation", "T-REST.LEAD.CHECK.4: error=validation");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });

  it("T-REST.LEAD.CHECK.5: lookbackHours:1000 → 400 with Zod validation error (max 720)", async () => {
    // Given: valid worker token
    // When:  POST /api/lead/check {personRef:..., lookbackHours:1000}
    // Then:  400 {error:"validation"}
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      addWorker(workersDb, "worker_A", TOKEN_A);
      const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
      server = srv;
      const result = await req({
        method: "POST",
        path: "/api/lead/check",
        port,
        headers: { Authorization: AUTH_A },
        body: { personRef: "https://www.linkedin.com/in/alice/", lookbackHours: 1000 },
      });
      assert.equal(result.status, 400, "T-REST.LEAD.CHECK.5: lookbackHours=1000 → 400");
      assert.equal(result.body.error, "validation", "T-REST.LEAD.CHECK.5: error=validation");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });

  it("T-REST.LEAD.CHECK.6: profile URL with different casing/trailing-slash matches via normalizeProfileUrl()", async () => {
    // Given: lead_actions row stored with normalizeProfileUrl("https://www.linkedin.com/in/alice-test/")
    // When:  POST check {personRef:"https://www.linkedin.com/in/alice-test"} (no trailing slash)
    // Then:  normalizeProfileUrl applied; same row found; {allowed:false}
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      addWorker(workersDb, "worker_A", TOKEN_A);
      // insertLeadAction normalizes URL → ensures trailing slash
      insertLeadAction(workersDb, "https://www.linkedin.com/in/alice-test/", "connect", "worker_A", Date.now() - 1000);
      const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
      server = srv;
      // Query without trailing slash — normalization should still match
      const result = await req({
        method: "POST",
        path: "/api/lead/check",
        port,
        headers: { Authorization: AUTH_A },
        body: { personRef: "https://www.linkedin.com/in/alice-test" },
      });
      assert.equal(result.status, 200, "T-REST.LEAD.CHECK.6: status 200");
      assert.equal(
        result.body.allowed,
        false,
        "T-REST.LEAD.CHECK.6: URL normalized via normalizeProfileUrl; row found → allowed=false",
      );
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});

// ─── POST /api/lead/touch ─────────────────────────────────────────────────────

describe("POST /api/lead/touch (G-P26.6)", () => {
  it("T-REST.TOUCH.1: inserts 1 row into lead_actions with normalized URL; returns {ok:true}", async () => {
    // Given: empty lead_actions; valid worker token
    // When:  POST /api/lead/touch {personRef:"https://linkedin.com/in/alice", actionType:"connect", ts:now}
    // Then:  200 {ok:true}; lead_actions has 1 row with normalizeProfileUrl applied
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      addWorker(workersDb, "worker_A", TOKEN_A);
      const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
      server = srv;
      const touchTs = Date.now();
      const result = await req({
        method: "POST",
        path: "/api/lead/touch",
        port,
        headers: { Authorization: AUTH_A },
        body: { personRef: "https://linkedin.com/in/alice", actionType: "connect", ts: touchTs },
      });
      assert.equal(result.status, 200, "T-REST.TOUCH.1: status 200");
      assert.deepEqual(result.body, { ok: true }, "T-REST.TOUCH.1: body {ok:true}");
      // Verify row in DB with normalized URL
      const row = workersDb.prepare("SELECT profile_url, action_type, worker_id FROM lead_actions LIMIT 1").get() as
        | { profile_url: string; action_type: string; worker_id: string }
        | undefined;
      assert.ok(row !== undefined, "T-REST.TOUCH.1: 1 row inserted into lead_actions");
      assert.ok(
        row!.profile_url.endsWith("/"),
        `T-REST.TOUCH.1: profile_url must have trailing slash (normalizeProfileUrl); got: ${row!.profile_url}`,
      );
      assert.equal(row!.action_type, "connect", "T-REST.TOUCH.1: action_type=connect");
      assert.equal(row!.worker_id, "worker_A", "T-REST.TOUCH.1: worker_id=worker_A (from token auth)");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});

// ─── POST /api/event ─────────────────────────────────────────────────────────

describe("POST /api/event (G-P26.7)", () => {
  it("T-REST.EVENT.1: inserts 1 row into server_inbox with status='pending'; returns {ok:true, id:n}", async () => {
    // Given: empty server_inbox; valid worker token
    // When:  POST /api/event {type:"outreach_sent", data:{person:"alice"}}
    // Then:  200 {ok:true, id:<n>}; server_inbox has 1 row with status='pending', data='{"person":"alice"}'
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      addWorker(workersDb, "worker_A", TOKEN_A);
      const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
      server = srv;
      const result = await req({
        method: "POST",
        path: "/api/event",
        port,
        headers: { Authorization: AUTH_A },
        body: { type: "outreach_sent", data: { person: "alice" } },
      });
      assert.equal(result.status, 200, "T-REST.EVENT.1: status 200");
      assert.equal(result.body.ok, true, "T-REST.EVENT.1: ok=true");
      assert.ok(
        typeof result.body.id === "number" && result.body.id >= 1,
        `T-REST.EVENT.1: id must be a positive number; got ${result.body.id}`,
      );
      const row = serverInboxDb.prepare("SELECT status, data FROM server_inbox LIMIT 1").get() as
        | { status: string; data: string }
        | undefined;
      assert.ok(row !== undefined, "T-REST.EVENT.1: 1 row in server_inbox");
      assert.equal(row!.status, "pending", "T-REST.EVENT.1: status=pending");
      assert.deepEqual(JSON.parse(row!.data), { person: "alice" }, "T-REST.EVENT.1: data matches");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});

// ─── GET /api/worker_inbox/poll ──────────────────────────────────────────────

describe("GET /api/worker_inbox/poll (G-P26.8)", () => {
  it("T-REST.POLL.1: 2 pending rows for worker_A → returns both messages immediately; rows marked consumed", async () => {
    // Given: worker_pending has 2 rows for worker_A; valid token
    // When:  GET /api/worker_inbox/poll?worker_id=worker_A&timeout=30
    // Then:  200 {messages:[{id,content,ts},{id,content,ts}]}; both rows now status='consumed'
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      addWorker(workersDb, "worker_A", TOKEN_A);
      enqueueWorkerPending(serverInboxDb, "worker_A", "msg-one");
      enqueueWorkerPending(serverInboxDb, "worker_A", "msg-two");
      const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
      server = srv;
      const result = await req({
        method: "GET",
        path: "/api/worker_inbox/poll?worker_id=worker_A&timeout=30",
        port,
        headers: { Authorization: AUTH_A },
      });
      assert.equal(result.status, 200, "T-REST.POLL.1: status 200");
      assert.equal(result.body.messages.length, 2, "T-REST.POLL.1: 2 messages returned");
      const contents = (result.body.messages as Array<{ content: string }>).map((m) => m.content).sort();
      assert.deepEqual(contents, ["msg-one", "msg-two"], "T-REST.POLL.1: both message contents returned");
      const consumed = serverInboxDb
        .prepare("SELECT COUNT(*) AS c FROM worker_pending WHERE status='consumed'")
        .get() as { c: number };
      assert.equal(consumed.c, 2, "T-REST.POLL.1: both rows marked consumed");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });

  it(
    "T-REST.POLL.2: empty worker_pending with timeout=1 → returns {messages:[]} after ~1s",
    { timeout: 10_000 },
    async () => {
      // Given: worker_pending empty; valid token
      // When:  GET poll?timeout=1 (1s timeout)
      // Then:  200 {messages:[]} returned after ≥1s; no rows consumed
      const { dir, cleanup } = makeTmpDir();
      let server: Server | null = null;
      try {
        const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
        const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
        addWorker(workersDb, "worker_A", TOKEN_A);
        const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
        server = srv;
        const t0 = Date.now();
        const result = await req({
          method: "GET",
          path: "/api/worker_inbox/poll?worker_id=worker_A&timeout=1",
          port,
          headers: { Authorization: AUTH_A },
        });
        const elapsed = Date.now() - t0;
        assert.equal(result.status, 200, "T-REST.POLL.2: status 200");
        assert.deepEqual(result.body, { messages: [] }, "T-REST.POLL.2: messages=[] on empty poll timeout");
        // Allow ±200ms tolerance (system load)
        assert.ok(elapsed >= 800, `T-REST.POLL.2: elapsed must be ≥800ms for 1s timeout; got ${elapsed}ms`);
      } finally {
        if (server) await closeServer(server);
        cleanup();
      }
    },
  );

  it(
    "T-REST.POLL.3: message inserted at t+200ms is returned at next 1s tick; timeout=5",
    { timeout: 15_000 },
    async () => {
      // Given: worker_pending empty at request start; test inserts 1 row at +200ms
      // When:  GET poll?timeout=5
      // Then:  returns the message at the next poll tick; {messages:[{content:"delayed"}]}
      const { dir, cleanup } = makeTmpDir();
      let server: Server | null = null;
      try {
        const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
        const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
        addWorker(workersDb, "worker_A", TOKEN_A);
        const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
        server = srv;
        // Start long-poll request before inserting the message
        const pollPromise = req({
          method: "GET",
          path: "/api/worker_inbox/poll?worker_id=worker_A&timeout=5",
          port,
          headers: { Authorization: AUTH_A },
        });
        // Insert delayed message at +200ms — server polls every 1s so finds it at ~1s
        await new Promise((r) => setTimeout(r, 200));
        enqueueWorkerPending(serverInboxDb, "worker_A", "delayed");
        const result = await pollPromise;
        assert.equal(result.status, 200, "T-REST.POLL.3: status 200");
        const msgs = result.body.messages as Array<{ content: string }>;
        assert.equal(msgs.length, 1, "T-REST.POLL.3: 1 message returned");
        assert.equal(msgs[0].content, "delayed", "T-REST.POLL.3: content='delayed'");
      } finally {
        if (server) await closeServer(server);
        cleanup();
      }
    },
  );

  it("T-REST.POLL.4: timeout=100 (exceeds max 60) → 400 Zod error", async () => {
    // Given: valid worker token
    // When:  GET poll?worker_id=worker_A&timeout=100
    // Then:  400 {error:"validation"}
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      addWorker(workersDb, "worker_A", TOKEN_A);
      const { server: srv, port } = await startAndWait(workersDb, serverInboxDb);
      server = srv;
      const result = await req({
        method: "GET",
        path: "/api/worker_inbox/poll?worker_id=worker_A&timeout=100",
        port,
        headers: { Authorization: AUTH_A },
      });
      assert.equal(result.status, 400, "T-REST.POLL.4: timeout=100 → 400");
      assert.equal(result.body.error, "validation", "T-REST.POLL.4: error=validation");
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});

// ─── server bind_address ──────────────────────────────────────────────────────

describe("server bind_address (G-P26.28)", () => {
  it("T-BIND.1: startServerHttp with bindAddress='127.0.0.1' listens on 127.0.0.1:port", async () => {
    // Given: handlers with mock DBs; bindAddress="127.0.0.1"; port=0 (random)
    // When:  startServerHttp called; server.address() checked
    // Then:  {address:"127.0.0.1", port: >0}
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      const { server: srv } = await startAndWait(workersDb, serverInboxDb, "127.0.0.1");
      server = srv;
      const addr = srv.address() as AddressInfo;
      assert.equal(addr.address, "127.0.0.1", "T-BIND.1: address must be 127.0.0.1");
      assert.ok(addr.port > 0, `T-BIND.1: port must be > 0; got ${addr.port}`);
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });

  it("T-BIND.2: startServerHttp with bindAddress=null listens on 127.0.0.1 (fallback)", async () => {
    // Given: bindAddress=null
    // When:  startServerHttp(handlers, null, 0)
    // Then:  server listens on 127.0.0.1 (default fallback in startServerHttp)
    const { dir, cleanup } = makeTmpDir();
    let server: Server | null = null;
    try {
      const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
      const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
      const { server: srv } = await startAndWait(workersDb, serverInboxDb, null);
      server = srv;
      const addr = srv.address() as AddressInfo;
      assert.equal(addr.address, "127.0.0.1", "T-BIND.2: null bindAddress → fallback 127.0.0.1");
      assert.ok(addr.port > 0, `T-BIND.2: port must be > 0; got ${addr.port}`);
    } finally {
      if (server) await closeServer(server);
      cleanup();
    }
  });
});
