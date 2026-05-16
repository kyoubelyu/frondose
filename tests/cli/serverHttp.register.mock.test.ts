/**
 * P-27 Step 5 — T-REST.REG.1..7
 *
 * Tests for POST /api/register HTTP route in serverHttp.ts.
 * Gate coverage: G-P27.5 (200 + consumed + worker inserted),
 *                G-P27.6 (401 consumed invite), G-P27.7 (401 expired),
 *                G-P27.8 (422 persona not found; invite NOT consumed),
 *                G-P27.9 (consume-first: addWorker throw → invite stays consumed),
 *                G-P27.5 integration (permanent token authenticates heartbeat)
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpReq, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startServerHttp } from "../../src/cli/serverHttp.js";
import { consumeInvite, insertInvite, lookupInviteAny, openInvitesDb } from "../../src/persistence/invitesRegistry.js";
import { personaTemplateSchema } from "../../src/persistence/personaLibrary.js";
import { openServerInboxDb } from "../../src/persistence/serverInbox.js";
import { addWorker, openWorkersDb } from "../../src/persistence/workersRegistry.js";

export function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p27-reg-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function validPersonaJsonStr(fullName = "BD Alice"): string {
  return JSON.stringify(
    personaTemplateSchema.parse({
      fullName,
      role: "BD Specialist",
      company: "Acme",
      priorities: [],
      traits: [],
      updatedAt: new Date().toISOString(),
    }),
  );
}

async function startAndWait(handlers: {
  workersDb: ReturnType<typeof openWorkersDb>;
  serverInboxDb: ReturnType<typeof openServerInboxDb>;
  invitesDb: ReturnType<typeof openInvitesDb>;
  personasDir: string;
  serverUrl: string;
  maiVersion: string;
}): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    // biome-ignore lint/suspicious/noExplicitAny: 6-field handlers
    const srv = startServerHttp(handlers as any, "127.0.0.1", 0);
    srv.on("listening", () => resolve({ server: srv, port: (srv.address() as AddressInfo).port }));
    srv.on("error", reject);
  });
}

async function closeServer(srv: Server): Promise<void> {
  return new Promise((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
}

interface JsonReqResult {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test result body
  body: any;
}

async function postJson(
  port: number,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<JsonReqResult> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const reqHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(bodyStr)),
      ...(headers ?? {}),
    };
    const r = httpReq({ host: "127.0.0.1", port, method: "POST", path, headers: reqHeaders }, (res) => {
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
    r.write(bodyStr);
    r.end();
  });
}

const SERVER_URL = "http://100.64.0.5:3031";
const MAI_VERSION = "0.4.24";

// ─── T-REST.REG.1 ─────────────────────────────────────────────────────────────

describe("POST /api/register — happy path (G-P27.5)", () => {
  it("T-REST.REG.1: given pending invite + persona present, POST returns 200 + workerId + permanentToken + identity; invite consumed; worker row inserted", async () => {
    // Given: invitesDb has pending invite for 'acme-bd' persona;
    //        personasDir/acme-bd.json exists with fullName='BD Alice'
    // When:  POST /api/register {inviteToken: <plaintext>}
    // Then:  status 200; body.ok=true; body.workerId non-empty; body.permanentToken is 64-char hex;
    //        body.personaId='acme-bd'; body.identity.fullName='BD Alice';
    //        invite row has status='consumed'; workers row exists
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const plainToken = "1a2b3c4d".repeat(8);
    const tokenSha = sha256(plainToken);
    writeFileSync(join(dir, "acme-bd.json"), validPersonaJsonStr("BD Alice"), "utf-8");
    insertInvite(invitesDb, tokenSha, "acme-bd", null, Date.now() + 3_600_000);
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
    });
    try {
      const res = await postJson(port, "/api/register", { inviteToken: plainToken });
      assert.equal(res.status, 200, `expected 200; got ${res.status}; body: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.ok, true);
      assert.ok(typeof res.body.workerId === "string" && res.body.workerId.length > 0, "workerId must be non-empty");
      assert.ok(
        /^[0-9a-f]{64}$/i.test(res.body.permanentToken),
        `permanentToken must be 64-char hex; got: ${res.body.permanentToken}`,
      );
      assert.equal(res.body.personaId, "acme-bd");
      assert.equal(res.body.identity?.fullName, "BD Alice");
      // Invite consumed
      const inviteRow = lookupInviteAny(invitesDb, tokenSha);
      assert.equal(inviteRow?.status, "consumed", "invite must be consumed after register");
      // Worker row present in workersDb
      const workerRows = workersDb
        .prepare("SELECT worker_id FROM workers WHERE worker_id=?")
        .get(res.body.workerId) as { worker_id: string } | undefined;
      assert.ok(workerRows, "worker row must exist in workersDb");
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-REST.REG.2 ─────────────────────────────────────────────────────────────

describe("POST /api/register — consumed invite (G-P27.6)", () => {
  it("T-REST.REG.2: given invite already consumed, POST returns 401 {ok:false, error:'invite invalid or consumed'}", async () => {
    // Given: invitesDb has invite with status='consumed'
    // When:  POST /api/register {inviteToken: <plaintext-of-consumed-token>}
    // Then:  status 401; body {ok:false, error:'invite invalid or consumed'}
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const plainToken = "2b3c4d5e".repeat(8);
    const tokenSha = sha256(plainToken);
    insertInvite(invitesDb, tokenSha, "acme-bd", null, Date.now() + 3_600_000);
    consumeInvite(invitesDb, tokenSha, "worker_prev"); // pre-consume
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
    });
    try {
      const res = await postJson(port, "/api/register", { inviteToken: plainToken });
      assert.equal(res.status, 401, `expected 401; got ${res.status}`);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.error, "invite invalid or consumed");
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-REST.REG.3 ─────────────────────────────────────────────────────────────

describe("POST /api/register — expired invite (G-P27.7)", () => {
  it("T-REST.REG.3: given expired invite (expires_at < now), POST returns 401", async () => {
    // Given: invitesDb has invite with expires_at=Date.now()-1
    // When:  POST /api/register {inviteToken: <plaintext>}
    // Then:  status 401; body {ok:false, error:'invite invalid or consumed'}
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const plainToken = "3c4d5e6f".repeat(8);
    const tokenSha = sha256(plainToken);
    insertInvite(invitesDb, tokenSha, "acme-bd", null, Date.now() - 1); // expired
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
    });
    try {
      const res = await postJson(port, "/api/register", { inviteToken: plainToken });
      assert.equal(res.status, 401, `expected 401; got ${res.status}`);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.error, "invite invalid or consumed");
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-REST.REG.4 ─────────────────────────────────────────────────────────────

describe("POST /api/register — persona not found (G-P27.8)", () => {
  it("T-REST.REG.4: given valid invite but persona file absent from personasDir, POST returns 422 and invite is NOT consumed", async () => {
    // Given: invitesDb has pending invite with persona_id='missing-persona';
    //        personasDir has NO 'missing-persona.json'
    // When:  POST /api/register {inviteToken: <plaintext>}
    // Then:  status 422; body {ok:false, error includes 'persona_not_found'}
    //        CRITICAL: invite row in invitesDb still has status='pending'
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const plainToken = "4d5e6f7a".repeat(8);
    const tokenSha = sha256(plainToken);
    insertInvite(invitesDb, tokenSha, "missing-persona", null, Date.now() + 3_600_000);
    // personasDir is empty — no missing-persona.json
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
    });
    try {
      const res = await postJson(port, "/api/register", { inviteToken: plainToken });
      assert.equal(res.status, 422, `expected 422; got ${res.status}; body: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.ok, false);
      assert.ok(
        typeof res.body.error === "string" && res.body.error.includes("persona_not_found"),
        `error must contain 'persona_not_found'; got: ${res.body.error}`,
      );
      // Invite must NOT be consumed (validate-before-consume order)
      const inviteRow = lookupInviteAny(invitesDb, tokenSha);
      assert.equal(inviteRow?.status, "pending", "invite must remain pending after 422 (not consumed)");
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-REST.REG.5 ─────────────────────────────────────────────────────────────

describe("POST /api/register — addWorker throws (G-P27.9)", () => {
  it("T-REST.REG.5: given valid invite + persona + requestedWorkerId 'collision' pre-inserted in workersDb, POST returns 500 and invite IS consumed (consume-first-insert-after)", async () => {
    // Given: invitesDb has pending invite for 'acme-bd' persona;
    //        personasDir/acme-bd.json exists;
    //        workersDb has pre-inserted row with worker_id='collision' (UNIQUE constraint trigger)
    // When:  POST /api/register {inviteToken: <plaintext>, requestedWorkerId: 'collision'}
    //        consumeInvite succeeds; addWorker throws UNIQUE → top-level catch → 500
    // Then:  status 500; invite row has status='consumed' (consume-first happened before addWorker)
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const plainToken = "5e6f7a8b".repeat(8);
    const tokenSha = sha256(plainToken);
    writeFileSync(join(dir, "acme-bd.json"), validPersonaJsonStr("BD Alice"), "utf-8");
    insertInvite(invitesDb, tokenSha, "acme-bd", null, Date.now() + 3_600_000);
    // Pre-insert worker with id='collision' to trigger UNIQUE constraint
    addWorker(workersDb, "collision", "some_token_value");
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
    });
    try {
      const res = await postJson(port, "/api/register", {
        inviteToken: plainToken,
        requestedWorkerId: "collision",
      });
      assert.equal(res.status, 500, `expected 500 from UNIQUE constraint; got ${res.status}`);
      // Invite IS consumed (consume happened before addWorker)
      const inviteRow = lookupInviteAny(invitesDb, tokenSha);
      assert.equal(inviteRow?.status, "consumed", "invite must be consumed (consume-first happened before addWorker)");
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-REST.REG.6 ─────────────────────────────────────────────────────────────

describe("POST /api/register integration — permanent token works for heartbeat (G-P27.5 integration)", () => {
  it("T-REST.REG.6: worker registered via /api/register can immediately authenticate POST /api/heartbeat with returned permanentToken", async () => {
    // Given: full register flow succeeds (as in T-REST.REG.1)
    // When:  POST /api/heartbeat with Authorization: Bearer <permanentToken from register response>
    //        body: {workerId: <workerId from register>, hostname: 'vm-x'}
    // Then:  status 200; body {ok:true, pendingMessages:0}
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const plainToken = "6f7a8b9c".repeat(8);
    const tokenSha = sha256(plainToken);
    writeFileSync(join(dir, "acme-bd.json"), validPersonaJsonStr("BD Alice"), "utf-8");
    insertInvite(invitesDb, tokenSha, "acme-bd", null, Date.now() + 3_600_000);
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
    });
    try {
      // Register first
      const regRes = await postJson(port, "/api/register", { inviteToken: plainToken });
      assert.equal(regRes.status, 200, `register must succeed; got ${regRes.status}`);
      const { workerId, permanentToken } = regRes.body;
      // Heartbeat with permanentToken
      const hbRes = await postJson(
        port,
        "/api/heartbeat",
        { workerId, hostname: "vm-x" },
        { Authorization: `Bearer ${permanentToken}` },
      );
      assert.equal(hbRes.status, 200, `heartbeat must succeed with permanentToken; got ${hbRes.status}`);
      assert.equal(hbRes.body.ok, true);
      assert.equal(hbRes.body.pendingMessages, 0);
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-REST.REG.7 ─────────────────────────────────────────────────────────────

describe("POST /api/register — missing inviteToken in body (G-P27.5 input validation)", () => {
  it("T-REST.REG.7: given body missing 'inviteToken' field, POST returns 400 Zod validation error", async () => {
    // Given: POST body = {} (empty, no inviteToken)
    // When:  POST /api/register {}
    // Then:  status 400; body contains error info (Zod validation)
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
    });
    try {
      const res = await postJson(port, "/api/register", {}); // empty body
      assert.equal(res.status, 400, `expected 400; got ${res.status}`);
      assert.ok(
        res.body.error === "validation" || typeof res.body.detail !== "undefined",
        `body must indicate Zod validation error; got: ${JSON.stringify(res.body)}`,
      );
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});
