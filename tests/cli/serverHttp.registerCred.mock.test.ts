/**
 * P-28 Step 4a — T-REG.CRED.1..5
 *
 * Tests for credential-push additions to POST /api/register in serverHttp.ts.
 * Gate coverage: G-P28.23 (llmProviderConfig accepted + stored),
 *                G-P28.24 (googleAccountEmail accepted + stored),
 *                G-P28.25 (register without credential fields — backward compat),
 *                G-P28.26 (credentialsDb null → credential fields silently ignored),
 *                G-P28.27 (C-2 fix: response body.identity.profileUrl — not body.linkedInUrl)
 *
 * CREDENTIAL PLACEHOLDER POLICY (C-5): All fixtures use obvious placeholders ONLY.
 *   api_key    → "sk-PLACEHOLDER"
 *   password   → "PLACEHOLDER"
 *   twofa_link → "https://2fa.show/PLACEHOLDER"
 * NEVER a real API key, real password, or live SMS/2FA URL.
 *
 * Implementation note (Step 5):
 *   The /api/register handler does NOT read credential fields from the request body.
 *   Credentials are resolved from persona.llmKeyRef / persona.googleAccountRef pointing
 *   into the server's credentials.sqlite. Tests must pre-populate credentialsDb and
 *   create personas with the matching refs.
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
import {
  addGoogleAccount,
  addLlmKey,
  getLlmKey,
  listGoogleAccounts,
  listLlmKeys,
  openCredentialsDb,
} from "../../src/persistence/credentialLibrary.js";
import { insertInvite, openInvitesDb } from "../../src/persistence/invitesRegistry.js";
import { personaTemplateSchema } from "../../src/persistence/personaLibrary.js";
import { openServerInboxDb } from "../../src/persistence/serverInbox.js";
import { openWorkersDb } from "../../src/persistence/workersRegistry.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p28-regcred-"));
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

function personaWithLlmRef(llmKeyRef: string, linkedInUrl?: string): string {
  return JSON.stringify(
    personaTemplateSchema.parse({
      fullName: "BD Alice",
      role: "BD Specialist",
      company: "Acme",
      linkedInUrl,
      llmKeyRef,
      priorities: [],
      traits: [],
      updatedAt: new Date().toISOString(),
    }),
  );
}

function personaWithGoogRef(googleAccountRef: string): string {
  return JSON.stringify(
    personaTemplateSchema.parse({
      fullName: "BD Alice",
      role: "BD Specialist",
      company: "Acme",
      googleAccountRef,
      priorities: [],
      traits: [],
      updatedAt: new Date().toISOString(),
    }),
  );
}

type CredentialsDb = ReturnType<typeof openCredentialsDb>;

async function startAndWait(handlers: {
  workersDb: ReturnType<typeof openWorkersDb>;
  serverInboxDb: ReturnType<typeof openServerInboxDb>;
  invitesDb: ReturnType<typeof openInvitesDb>;
  personasDir: string;
  serverUrl: string;
  maiVersion: string;
  credentialsDb?: CredentialsDb | null;
}): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    // biome-ignore lint/suspicious/noExplicitAny: credentialsDb field type widened at Step 5
    const srv = startServerHttp({ ...handlers, credentialsDb: handlers.credentialsDb ?? null } as any, "127.0.0.1", 0);
    srv.on("listening", () => resolve({ server: srv, port: (srv.address() as AddressInfo).port }));
    srv.on("error", reject);
  });
}

async function closeServer(srv: Server): Promise<void> {
  return new Promise((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
}

async function postJson(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const r = httpReq(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(bodyStr)),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown> });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    r.on("error", reject);
    r.write(bodyStr);
    r.end();
  });
}

const SERVER_URL = "http://100.64.0.5:3031";
const MAI_VERSION = "0.4.25";

// ─── T-REG.CRED.1 ─────────────────────────────────────────────────────────────

describe("POST /api/register: llmProviderConfig resolved from persona.llmKeyRef + credentialsDb (G-P28.23)", () => {
  it("T-REG.CRED.1: given persona with llmKeyRef='llm1' + credentialsDb with api_key='sk-PLACEHOLDER', register returns 200 with llmProviderConfig in response and increments assigned_count", async () => {
    // Given: server with credentialsDb containing llm_key 'llm1' (api_key='sk-PLACEHOLDER')
    //        persona p1 has llmKeyRef='llm1'; pending invite for p1
    // When:  POST /api/register {inviteToken}
    // Then:  status 200; body.ok === true; body.llmProviderConfig.key === 'sk-PLACEHOLDER';
    //        getLlmKey(credentialsDb,'llm1').assigned_count === 1 (incremented G-P28.23)
    const { dir, cleanup } = makeTmpDir();
    const credentialsDb = openCredentialsDb(":memory:");
    addLlmKey(credentialsDb, {
      id: "llm1",
      provider_type: "anthropic",
      base_url: null,
      api_key: "sk-PLACEHOLDER",
      label: "test",
    });
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const plainToken = "c1c1c1c1".repeat(8);
    insertInvite(invitesDb, sha256(plainToken), "p1", null, Date.now() + 3_600_000);
    writeFileSync(join(dir, "p1.json"), personaWithLlmRef("llm1", "https://linkedin.com/in/bd-alice"), "utf-8");
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
      credentialsDb,
    });
    try {
      const res = await postJson(port, "/api/register", { inviteToken: plainToken });
      assert.equal(res.status, 200, "T-REG.CRED.1: status must be 200");
      assert.equal(res.body.ok, true, "T-REG.CRED.1: body.ok must be true");
      assert.ok(res.body.llmProviderConfig !== undefined, "T-REG.CRED.1: body.llmProviderConfig must be present (G-P28.23)");
      const cfg = res.body.llmProviderConfig as Record<string, unknown>;
      assert.equal(cfg.key, "sk-PLACEHOLDER", "T-REG.CRED.1: llmProviderConfig.key must be 'sk-PLACEHOLDER' (C-5)");
      assert.equal(cfg.type, "anthropic", "T-REG.CRED.1: llmProviderConfig.type must be 'anthropic'");
      // assigned_count must be incremented to 1 after registration
      const keyRow = getLlmKey(credentialsDb, "llm1");
      assert.equal(keyRow?.assigned_count, 1, "T-REG.CRED.1: assigned_count must be 1 after registration (G-P28.23)");
      // C-2 fix: identity.profileUrl must be in response
      const identity = res.body.identity as Record<string, unknown>;
      assert.ok(identity !== undefined, "T-REG.CRED.1: body.identity must be present");
      assert.equal(identity.profileUrl, "https://linkedin.com/in/bd-alice", "T-REG.CRED.1: identity.profileUrl must be set (C-2 fix)");
    } finally {
      await closeServer(server);
      invitesDb.close();
      credentialsDb.close();
      cleanup();
    }
  });
});

// ─── T-REG.CRED.2 ─────────────────────────────────────────────────────────────

describe("POST /api/register: googleAccountEmail resolved from persona.googleAccountRef + credentialsDb (G-P28.24)", () => {
  it("T-REG.CRED.2: given persona with googleAccountRef='g1' + credentialsDb with email='test@example.com', register returns 200 with googleAccountEmail in response", async () => {
    // Given: server with credentialsDb containing google_account 'g1' (email='test@example.com')
    //        persona p1 has googleAccountRef='g1'; pending invite for p1
    // When:  POST /api/register {inviteToken}
    // Then:  status 200; body.ok === true; body.googleAccountEmail === 'test@example.com'
    //        NOTE: password NEVER appears in response (G-P28.24)
    const { dir, cleanup } = makeTmpDir();
    const credentialsDb = openCredentialsDb(":memory:");
    addGoogleAccount(credentialsDb, {
      id: "g1",
      email: "test@example.com",
      password: "PLACEHOLDER",
      recovery_email: null,
      phone: null,
      sms_link: null,
      twofa_link: null,
      label: null,
    });
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const plainToken = "c2c2c2c2".repeat(8);
    insertInvite(invitesDb, sha256(plainToken), "p1", null, Date.now() + 3_600_000);
    writeFileSync(join(dir, "p1.json"), personaWithGoogRef("g1"), "utf-8");
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
      credentialsDb,
    });
    try {
      const res = await postJson(port, "/api/register", { inviteToken: plainToken });
      assert.equal(res.status, 200, "T-REG.CRED.2: status must be 200");
      assert.equal(res.body.ok, true, "T-REG.CRED.2: body.ok must be true");
      assert.equal(res.body.googleAccountEmail, "test@example.com", "T-REG.CRED.2: googleAccountEmail must be 'test@example.com' (G-P28.24)");
      // Sanity: listGoogleAccounts still has the row (it was pre-stored, not consumed)
      assert.equal(listGoogleAccounts(credentialsDb).length, 1, "T-REG.CRED.2: google account row must remain in DB");
    } finally {
      await closeServer(server);
      invitesDb.close();
      credentialsDb.close();
      cleanup();
    }
  });
});

// ─── T-REG.CRED.3 ─────────────────────────────────────────────────────────────

describe("POST /api/register: no credential refs in persona — backward compat (G-P28.25)", () => {
  it("T-REG.CRED.3: given persona WITHOUT llmKeyRef/googleAccountRef, register returns 200 with no credential fields in response", async () => {
    // Given: server with credentialsDb=openCredentialsDb(":memory:"); standard persona (no refs); pending invite
    // When:  POST /api/register {inviteToken}
    // Then:  status 200; body.ok === true; body.llmProviderConfig === undefined; body.googleAccountEmail === undefined
    const { dir, cleanup } = makeTmpDir();
    const credentialsDb = openCredentialsDb(":memory:");
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const plainToken = "c3c3c3c3".repeat(8);
    insertInvite(invitesDb, sha256(plainToken), "p1", null, Date.now() + 3_600_000);
    writeFileSync(join(dir, "p1.json"), validPersonaJsonStr("BD Alice"), "utf-8");
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
      credentialsDb,
    });
    try {
      const res = await postJson(port, "/api/register", { inviteToken: plainToken });
      assert.equal(res.status, 200, "T-REG.CRED.3: status must be 200 (no regression — G-P28.25)");
      assert.equal(res.body.ok, true, "T-REG.CRED.3: body.ok must be true");
      assert.equal(res.body.llmProviderConfig, undefined, "T-REG.CRED.3: no llmProviderConfig when persona has no llmKeyRef");
      assert.equal(res.body.googleAccountEmail, undefined, "T-REG.CRED.3: no googleAccountEmail when persona has no googleAccountRef");
      // credentialsDb unmodified (no keys pre-stored)
      assert.equal(listLlmKeys(credentialsDb).length, 0, "T-REG.CRED.3: credentialsDb must remain empty");
    } finally {
      await closeServer(server);
      invitesDb.close();
      credentialsDb.close();
      cleanup();
    }
  });
});

// ─── T-REG.CRED.4 ─────────────────────────────────────────────────────────────

describe("POST /api/register: credentialsDb=null → credential fields silently ignored (G-P28.26)", () => {
  it("T-REG.CRED.4: given server with credentialsDb=null and persona with llmKeyRef set, register still returns 200 (credential resolved silently skipped)", async () => {
    // Given: server with credentialsDb=null; persona has llmKeyRef='llm1' (ref present but no DB to resolve against)
    //        pending invite
    // When:  POST /api/register {inviteToken}
    // Then:  status 200; body.ok === true; no llmProviderConfig in response (graceful degradation G-P28.26)
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const plainToken = "c4c4c4c4".repeat(8);
    insertInvite(invitesDb, sha256(plainToken), "p1", null, Date.now() + 3_600_000);
    // Persona HAS a llmKeyRef but server has no credentialsDb to resolve it
    writeFileSync(join(dir, "p1.json"), personaWithLlmRef("llm1"), "utf-8");
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
      credentialsDb: null,
    });
    try {
      const res = await postJson(port, "/api/register", { inviteToken: plainToken });
      assert.equal(res.status, 200, "T-REG.CRED.4: status must be 200 even with credentialsDb=null (G-P28.26)");
      assert.equal(res.body.ok, true, "T-REG.CRED.4: body.ok must be true");
      assert.equal(res.body.llmProviderConfig, undefined, "T-REG.CRED.4: no llmProviderConfig when credentialsDb is null");
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-REG.CRED.5 ─────────────────────────────────────────────────────────────

describe("POST /api/register: C-2 fix — response body.identity.profileUrl (not body.linkedInUrl) (G-P28.27)", () => {
  it("T-REG.CRED.5: given successful register, response body.identity contains profileUrl (C-2: persona.linkedInUrl→identity.profileUrl fix) — NOT a linkedInUrl key", async () => {
    // Given: server with credentialsDb=null; persona with linkedInUrl='https://linkedin.com/in/bd-alice'; pending invite
    // When:  POST /api/register {inviteToken}
    // Then:  status 200; body.identity.profileUrl === 'https://linkedin.com/in/bd-alice' (C-2 fix);
    //        body.identity.linkedInUrl === undefined (old field NOT present)
    const { dir, cleanup } = makeTmpDir();
    const workersDb = openWorkersDb(join(dir, "workers.sqlite"));
    const serverInboxDb = openServerInboxDb(join(dir, "inbox.sqlite"));
    const invitesDb = openInvitesDb(":memory:");
    const plainToken = "c5c5c5c5".repeat(8);
    insertInvite(invitesDb, sha256(plainToken), "p1", null, Date.now() + 3_600_000);
    // Persona with a linkedInUrl to test the C-2 fix
    const personaWithUrl = JSON.stringify({
      ...personaTemplateSchema.parse({
        fullName: "BD Alice",
        role: "BD Specialist",
        company: "Acme",
        priorities: [],
        traits: [],
        updatedAt: new Date().toISOString(),
      }),
      linkedInUrl: "https://linkedin.com/in/bd-alice",
    });
    writeFileSync(join(dir, "p1.json"), personaWithUrl, "utf-8");
    const { server, port } = await startAndWait({
      workersDb,
      serverInboxDb,
      invitesDb,
      personasDir: dir,
      serverUrl: SERVER_URL,
      maiVersion: MAI_VERSION,
      credentialsDb: null,
    });
    try {
      const res = await postJson(port, "/api/register", { inviteToken: plainToken });
      assert.equal(res.status, 200, "T-REG.CRED.5: status must be 200");
      assert.equal(res.body.ok, true, "T-REG.CRED.5: body.ok must be true");
      const identity = res.body.identity as Record<string, unknown>;
      assert.ok(identity !== undefined, "T-REG.CRED.5: body.identity must be present");
      assert.equal(
        identity.profileUrl,
        "https://linkedin.com/in/bd-alice",
        "T-REG.CRED.5: identity.profileUrl must be set from persona.linkedInUrl (C-2 fix, G-P28.27)",
      );
      // biome-ignore lint/suspicious/noExplicitAny: checking absent field
      assert.equal((identity as any).linkedInUrl, undefined, "T-REG.CRED.5: identity.linkedInUrl must NOT exist (C-2 fix)");
    } finally {
      await closeServer(server);
      invitesDb.close();
      cleanup();
    }
  });
});
