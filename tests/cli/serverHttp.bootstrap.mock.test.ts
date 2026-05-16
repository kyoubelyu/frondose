/**
 * P-27 Step 5 — T-REST.BOOT.1..5
 *
 * Tests for GET /bootstrap/<token>.sh HTTP route in serverHttp.ts.
 * Gate coverage: G-P27.1 (200 + content-type + body substitution),
 *                G-P27.2 (404 expired), G-P27.3 (410 consumed),
 *                G-P27.4 (404 unknown / no .sh suffix)
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
import { consumeInvite, insertInvite, openInvitesDb } from "../../src/persistence/invitesRegistry.js";
import { openServerInboxDb } from "../../src/persistence/serverInbox.js";
import { openWorkersDb } from "../../src/persistence/workersRegistry.js";

export function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p27-boot-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Start server with 6-field handlers on random port, wait for listen. */
async function startAndWait(handlers: {
  workersDb: ReturnType<typeof openWorkersDb>;
  serverInboxDb: ReturnType<typeof openServerInboxDb>;
  invitesDb: ReturnType<typeof openInvitesDb>;
  personasDir: string;
  serverUrl: string;
  maiVersion: string;
}): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    // biome-ignore lint/suspicious/noExplicitAny: builder Step 4b extends ServerHttpHandlers with 4 more fields
    const srv = startServerHttp(handlers as any, "127.0.0.1", 0);
    srv.on("listening", () => resolve({ server: srv, port: (srv.address() as AddressInfo).port }));
    srv.on("error", reject);
  });
}

async function closeServer(srv: Server): Promise<void> {
  return new Promise((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
}

interface TextReqResult {
  status: number;
  body: string;
  contentType: string;
}

/** HTTP GET, returns raw text body + status + content-type. */
async function getScript(port: number, path: string): Promise<TextReqResult> {
  return new Promise((resolve, reject) => {
    const r = httpReq({ host: "127.0.0.1", port, method: "GET", path }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf-8"),
          contentType: (res.headers["content-type"] ?? "") as string,
        });
      });
    });
    r.on("error", reject);
    r.end();
  });
}

const SERVER_URL = "http://100.64.0.5:3031";
const MAI_VERSION = "0.4.24";

// ─── T-REST.BOOT.1 ─────────────────────────────────────────────────────────────

describe("GET /bootstrap/<token>.sh — pending invite (G-P27.1 + G-P27.20)", () => {
  it("T-REST.BOOT.1: given pending unexpired invite, GET returns 200 + content-type text/x-sh + body with SERVER_URL and INVITE_TOKEN", async () => {
    // Given: invitesDb has pending invite for a 64-char hex token;
    //        personasDir exists; serverUrl + maiVersion set on handlers
    // When:  GET /bootstrap/<plaintext-token>.sh
    // Then:  status 200; Content-Type: text/x-sh; body contains SERVER_URL + INVITE_TOKEN + MAI_VERSION
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const plainToken = "a1b2c3d4".repeat(8); // 64-char hex
    const tokenSha = sha256(plainToken);
    insertInvite(invitesDb, tokenSha, "p1", null, Date.now() + 3_600_000);
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
    });
    try {
      const res = await getScript(port, `/bootstrap/${plainToken}.sh`);
      assert.equal(res.status, 200, `expected 200; got ${res.status}; body: ${res.body.slice(0, 100)}`);
      assert.ok(
        res.contentType.startsWith("text/x-sh"),
        `expected content-type text/x-sh; got: ${res.contentType}`,
      );
      assert.ok(res.body.includes(SERVER_URL), `body must contain SERVER_URL="${SERVER_URL}"`);
      assert.ok(res.body.includes(plainToken), `body must contain plaintext invite token`);
      assert.ok(res.body.includes(MAI_VERSION), `body must contain MAI_VERSION="${MAI_VERSION}"`);
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-REST.BOOT.2 ─────────────────────────────────────────────────────────────

describe("GET /bootstrap/<token>.sh — expired invite (G-P27.2)", () => {
  it("T-REST.BOOT.2: given expired invite (expires_at < now), GET returns 404 with 'invite token not found or expired'", async () => {
    // Given: invitesDb has invite with expires_at=Date.now()-1 (already expired)
    // When:  GET /bootstrap/<token>.sh
    // Then:  status 404; body contains 'invite token not found or expired'
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const plainToken = "b2c3d4e5".repeat(8);
    const tokenSha = sha256(plainToken);
    insertInvite(invitesDb, tokenSha, "p1", null, Date.now() - 1); // expired
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
    });
    try {
      const res = await getScript(port, `/bootstrap/${plainToken}.sh`);
      assert.equal(res.status, 404, `expected 404; got ${res.status}`);
      assert.ok(
        res.body.includes("invite token not found or expired"),
        `body must contain 'invite token not found or expired'; got: ${res.body}`,
      );
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-REST.BOOT.3 ─────────────────────────────────────────────────────────────

describe("GET /bootstrap/<token>.sh — consumed invite (G-P27.3)", () => {
  it("T-REST.BOOT.3: given consumed invite (status='consumed'), GET returns 410 with 'invite token already used'", async () => {
    // Given: invitesDb has invite that was previously consumed (status='consumed')
    // When:  GET /bootstrap/<token>.sh
    // Then:  status 410; body 'invite token already used'
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const plainToken = "c3d4e5f6".repeat(8);
    const tokenSha = sha256(plainToken);
    insertInvite(invitesDb, tokenSha, "p1", null, Date.now() + 3_600_000);
    consumeInvite(invitesDb, tokenSha, "worker_X"); // mark consumed
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
    });
    try {
      const res = await getScript(port, `/bootstrap/${plainToken}.sh`);
      assert.equal(res.status, 410, `expected 410; got ${res.status}; body: ${res.body}`);
      assert.ok(
        res.body.includes("invite token already used"),
        `body must contain 'invite token already used'; got: ${res.body}`,
      );
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-REST.BOOT.4 ─────────────────────────────────────────────────────────────

describe("GET /bootstrap/<token>.sh — unknown token (G-P27.4)", () => {
  it("T-REST.BOOT.4: given token not in DB, GET returns 404 (same body as expired — does not reveal token existence)", async () => {
    // Given: invitesDb has no row matching the requested token's sha256
    // When:  GET /bootstrap/<random-unknown-token>.sh
    // Then:  status 404; body 'invite token not found or expired' (same as expired — no oracle)
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:"); // empty DB
    const unknownToken = "d4e5f6a7".repeat(8); // not in DB
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
    });
    try {
      const res = await getScript(port, `/bootstrap/${unknownToken}.sh`);
      assert.equal(res.status, 404, `expected 404; got ${res.status}`);
      assert.ok(
        res.body.includes("invite token not found or expired"),
        `body must contain oracle-neutral 404 message; got: ${res.body}`,
      );
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-REST.BOOT.5 ─────────────────────────────────────────────────────────────

describe("GET /bootstrap/<token> — missing .sh suffix (G-P27.4 sibling)", () => {
  it("T-REST.BOOT.5: given URL /bootstrap/<valid-hex-token> without .sh suffix, GET returns 404", async () => {
    // Given: valid pending invite in invitesDb
    // When:  GET /bootstrap/<token> (no .sh suffix — regex match fails)
    // Then:  status 404; body contains error text (regex /^\/bootstrap\/[hex]{64}\.sh/ does not match)
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const plainToken = "e5f6a7b8".repeat(8);
    const tokenSha = sha256(plainToken);
    insertInvite(invitesDb, tokenSha, "p1", null, Date.now() + 3_600_000);
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
    });
    try {
      // No .sh suffix
      const res = await getScript(port, `/bootstrap/${plainToken}`);
      assert.equal(res.status, 404, `expected 404 for URL without .sh suffix; got ${res.status}`);
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});
