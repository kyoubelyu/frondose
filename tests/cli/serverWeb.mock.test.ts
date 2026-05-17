/**
 * P-29 Step 5 — T-WEB.AUTH.1-5, T-WEB.STATIC.1-3, T-WEB.WORKERS.1,
 *               T-WEB.LEADS.1, T-WEB.PERSONAS.1, T-WEB.INVITES.1,
 *               T-WEB.PROV.1-4, T-WEB.404
 *
 * Tests for src/cli/serverWeb.ts — startWebHttp HTTP server.
 * Strategy: start server on ephemeral port (port=0) with :memory: DB handles
 * + tmp assetRoot fixture dir; issue real fetch() calls; assert responses.
 *
 * Gate coverage: G-P29.1, G-P29.2, G-P29.3, G-P29.4, G-P29.5, G-P29.6,
 *                G-P29.7, G-P29.8, G-P29.9, G-P29.10, G-P29.12, G-P29.14,
 *                G-P29.15, G-P29.16, G-P29.17, G-P29.18, G-P29.19
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkBasicAuth, startWebHttp, type WebHttpDeps } from "../../src/cli/serverWeb.js";
import { insertInvite, openInvitesDb } from "../../src/persistence/invitesRegistry.js";
import { appendPersonInteraction, openMemoryDatabase } from "../../src/persistence/memory.js";
import { writePersonaTemplate } from "../../src/persistence/personaLibrary.js";
import { addWorker, insertLeadAction, openWorkersDb } from "../../src/persistence/workersRegistry.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface TestFixture {
  deps: WebHttpDeps;
  assetDir: string;
  personasDir: string;
  cleanup: () => void;
}

function makeFixture(overrides: Partial<WebHttpDeps> = {}): TestFixture {
  const assetDir = mkdtempSync(join(tmpdir(), "mai-p29-asset-"));
  const personasDir = mkdtempSync(join(tmpdir(), "mai-p29-personas-"));

  // Stub static files for T-WEB.STATIC.*
  writeFileSync(join(assetDir, "index.html"), "<html><body>mai server</body></html>", "utf-8");
  writeFileSync(join(assetDir, "app.js"), "/* bundle */", "utf-8");
  writeFileSync(join(assetDir, "style.css"), "/* css */", "utf-8");

  const workersDb = openWorkersDb(":memory:");
  const memoryDb = openMemoryDatabase(":memory:");
  const invitesDb = openInvitesDb(":memory:");

  const deps: WebHttpDeps = {
    workersDb,
    memoryDb,
    invitesDb,
    personasDir,
    serverUrl: "http://127.0.0.1:3031",
    assetRoot: assetDir,
    ...overrides,
  };

  return {
    deps,
    assetDir,
    personasDir,
    cleanup: () => {
      workersDb.close();
      memoryDb.close();
      if (deps.invitesDb && deps.invitesDb !== invitesDb) {
        // overridden invitesDb — original is already closed or null
      } else {
        invitesDb.close();
      }
      rmSync(assetDir, { recursive: true, force: true });
      rmSync(personasDir, { recursive: true, force: true });
    },
  };
}

async function startTestServer(
  deps: WebHttpDeps,
  webToken: string | undefined,
): Promise<{ server: Server; port: number }> {
  return new Promise<{ server: Server; port: number }>((resolve, reject) => {
    const srv = startWebHttp(deps, 0, "127.0.0.1", webToken);
    srv.on("listening", () => {
      const addr = srv.address() as AddressInfo;
      resolve({ server: srv, port: addr.port });
    });
    srv.on("error", reject);
  });
}

async function stopServer(srv: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
}

function basicAuth(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

// ─── T-WEB.AUTH ───────────────────────────────────────────────────────────────

describe("startWebHttp — Basic-Auth gate (G-P29.2, G-P29.3, G-P29.4, G-P29.5, G-P29.6)", () => {
  it("T-WEB.AUTH.1: given startWebHttp(deps, 0, '127.0.0.1', undefined), when GET /api/web/workers with no auth header, then 200 (no-auth mode)", async () => {
    // Given: webToken=undefined → no-auth mode (G-P29.2)
    // When: fetch GET /api/web/workers with no Authorization header
    // Then: 200 (route is reachable without credentials)
    const { deps, cleanup } = makeFixture();
    const { server, port } = await startTestServer(deps, undefined);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/web/workers`);
      assert.equal(res.status, 200, "T-WEB.AUTH.1: no-auth mode must allow unauthenticated access");
    } finally {
      await stopServer(server);
      cleanup();
    }
  });

  it("T-WEB.AUTH.2: given webToken='secret', when GET / with no Authorization header, then 401 + WWW-Authenticate: Basic realm='mai-server'", async () => {
    // Given: webToken='secret' set → auth-required mode (G-P29.3)
    // When: fetch GET / with no Authorization header
    // Then: 401 status; response header WWW-Authenticate: 'Basic realm="mai-server"'
    const { deps, cleanup } = makeFixture();
    const { server, port } = await startTestServer(deps, "secret");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(res.status, 401, "T-WEB.AUTH.2: no-auth request must return 401 when webToken is set");
      const wwwAuth = res.headers.get("WWW-Authenticate");
      assert.ok(
        wwwAuth?.includes("Basic"),
        `T-WEB.AUTH.2: WWW-Authenticate must include 'Basic'; got: ${wwwAuth}`,
      );
      assert.ok(
        wwwAuth?.includes("mai-server"),
        `T-WEB.AUTH.2: WWW-Authenticate realm must include 'mai-server'; got: ${wwwAuth}`,
      );
    } finally {
      await stopServer(server);
      cleanup();
    }
  });

  it("T-WEB.AUTH.3: given webToken='secret', when GET / with wrong Authorization password, then 401", async () => {
    // Given: webToken='secret' (G-P29.4)
    // When: fetch GET / with Authorization: Basic base64('op:wrongpassword')
    // Then: 401
    const { deps, cleanup } = makeFixture();
    const { server, port } = await startTestServer(deps, "secret");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { Authorization: basicAuth("op", "wrongpassword") },
      });
      assert.equal(res.status, 401, "T-WEB.AUTH.3: wrong password must return 401");
    } finally {
      await stopServer(server);
      cleanup();
    }
  });

  it("T-WEB.AUTH.4: given webToken='secret', when GET / with correct Authorization: Basic base64(op:secret), then not-401 (auth passed)", async () => {
    // Given: webToken='secret' (G-P29.5)
    // When: fetch GET / with correct credentials
    // Then: status !== 401 (200 or 404 depending on static file; auth passed)
    const { deps, cleanup } = makeFixture();
    const { server, port } = await startTestServer(deps, "secret");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { Authorization: basicAuth("op", "secret") },
      });
      assert.notEqual(res.status, 401, "T-WEB.AUTH.4: correct credentials must not return 401");
    } finally {
      await stopServer(server);
      cleanup();
    }
  });

  it("T-WEB.AUTH.5: checkBasicAuth with supplied token of different length than webToken → false, no throw (length-guard before timingSafeEqual)", () => {
    // Given: checkBasicAuth exported directly; Authorization header with LONGER password
    //        than configured webToken (G-P29.6: unequal-length → false, no RangeError)
    // When: checkBasicAuth(fakeReq, "short") where header has password "averylongtokenvalue12345"
    // Then: returns false; does NOT throw RangeError
    const fakeReq = {
      headers: { authorization: basicAuth("op", "averylongtokenvalue12345") },
    } as unknown as IncomingMessage;
    const result = checkBasicAuth(fakeReq, "short");
    assert.equal(
      result,
      false,
      "T-WEB.AUTH.5: checkBasicAuth with different-length passwords must return false (length-guard prevents RangeError)",
    );
  });
});

// ─── T-WEB.STATIC ─────────────────────────────────────────────────────────────

describe("startWebHttp — static file serving (G-P29.7, G-P29.8, G-P29.9)", () => {
  it("T-WEB.STATIC.1: given assetRoot with index.html, when GET /, then 200 with Content-Type text/html and body matches file", async () => {
    // Given: assetRoot dir has index.html with known content (G-P29.7)
    // When: fetch GET / (no auth)
    // Then: 200; Content-Type starts with 'text/html'; body contains marker text
    const { deps, cleanup } = makeFixture();
    const { server, port } = await startTestServer(deps, undefined);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(res.status, 200, "T-WEB.STATIC.1: GET / must return 200");
      const ct = res.headers.get("content-type") ?? "";
      assert.ok(ct.startsWith("text/html"), `T-WEB.STATIC.1: Content-Type must be text/html; got: ${ct}`);
      const body = await res.text();
      assert.ok(body.includes("mai server"), "T-WEB.STATIC.1: body must contain fixture marker text");
    } finally {
      await stopServer(server);
      cleanup();
    }
  });

  it("T-WEB.STATIC.2: when GET /app.js → Content-Type application/javascript; when GET /style.css → Content-Type text/css", async () => {
    // Given: assetRoot has app.js + style.css (G-P29.8)
    // When: fetch GET /app.js then GET /style.css
    // Then: /app.js → 200, Content-Type: application/javascript; /style.css → 200, Content-Type: text/css
    const { deps, cleanup } = makeFixture();
    const { server, port } = await startTestServer(deps, undefined);
    try {
      const resJs = await fetch(`http://127.0.0.1:${port}/app.js`);
      const resCss = await fetch(`http://127.0.0.1:${port}/style.css`);
      assert.equal(resJs.status, 200, "T-WEB.STATIC.2: GET /app.js must return 200");
      assert.ok(
        (resJs.headers.get("content-type") ?? "").includes("javascript"),
        `T-WEB.STATIC.2: /app.js Content-Type must include 'javascript'; got: ${resJs.headers.get("content-type")}`,
      );
      assert.equal(resCss.status, 200, "T-WEB.STATIC.2: GET /style.css must return 200");
      assert.ok(
        (resCss.headers.get("content-type") ?? "").includes("css"),
        `T-WEB.STATIC.2: /style.css Content-Type must include 'css'; got: ${resCss.headers.get("content-type")}`,
      );
    } finally {
      await stopServer(server);
      cleanup();
    }
  });

  it("T-WEB.STATIC.3: traversal attempt GET /%2e%2e%2f%2e%2e%2fetc%2fpasswd → 404; resolved path escaping assetRoot is blocked", async () => {
    // Given: GET request with percent-encoded path traversal (G-P29.9)
    // When: fetch GET /%2e%2e%2f%2e%2e%2fetc%2fpasswd (URL-decoded: /../../../etc/passwd)
    // Then: 404; the path.resolve + startsWith(assetRoot) guard blocks it
    const { deps, cleanup } = makeFixture();
    const { server, port } = await startTestServer(deps, undefined);
    try {
      // Use the raw encoded URL (fetch will send it as-is)
      const res = await fetch(`http://127.0.0.1:${port}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
      assert.equal(res.status, 404, "T-WEB.STATIC.3: traversal attempt must return 404");
    } finally {
      await stopServer(server);
      cleanup();
    }
  });
});

// ─── T-WEB.WORKERS ────────────────────────────────────────────────────────────

describe("startWebHttp — GET /api/web/workers (G-P29.10)", () => {
  it("T-WEB.WORKERS.1: given 2 workers + lead_actions for one, when GET /api/web/workers, then workers.length===2; worker with actions has last_action.ts; other has null; no token_hash in JSON", async () => {
    // Given: 2 workers in workersDb; worker 'w1' has a lead_actions row, 'w2' has none (G-P29.10)
    // When: fetch GET /api/web/workers
    // Then: response.workers.length===2; w1.last_action !== null with action_type+ts;
    //       w2.last_action===null; JSON body does NOT contain the string 'token_hash'
    const { deps, cleanup } = makeFixture();
    addWorker(deps.workersDb!, "w1", "token-w1", "host-a", "persona-a");
    addWorker(deps.workersDb!, "w2", "token-w2", "host-b", "persona-b");
    insertLeadAction(deps.workersDb!, "https://linkedin.com/in/alice/", "connect", "w1", Date.now());
    const { server, port } = await startTestServer(deps, undefined);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/web/workers`);
      assert.equal(res.status, 200, "T-WEB.WORKERS.1: GET /api/web/workers must return 200");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const body = (await res.json()) as { workers: any[] };
      assert.equal(body.workers.length, 2, "T-WEB.WORKERS.1: must return 2 workers");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const w1 = body.workers.find((w: any) => w.worker_id === "w1");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const w2 = body.workers.find((w: any) => w.worker_id === "w2");
      assert.ok(w1, "T-WEB.WORKERS.1: w1 must be present in workers array");
      assert.ok(w1.last_action !== null, "T-WEB.WORKERS.1: w1.last_action must not be null (has lead_actions)");
      assert.ok(
        typeof w1.last_action.ts === "number",
        "T-WEB.WORKERS.1: w1.last_action.ts must be a number",
      );
      assert.ok(
        typeof w1.last_action.action_type === "string",
        "T-WEB.WORKERS.1: w1.last_action.action_type must be a string",
      );
      assert.ok(w2, "T-WEB.WORKERS.1: w2 must be present in workers array");
      assert.equal(w2.last_action, null, "T-WEB.WORKERS.1: w2.last_action must be null (no lead_actions)");
      const bodyStr = JSON.stringify(body);
      assert.ok(!bodyStr.includes("token_hash"), "T-WEB.WORKERS.1: JSON body must NOT contain token_hash");
    } finally {
      await stopServer(server);
      cleanup();
    }
  });
});

// ─── T-WEB.LEADS ──────────────────────────────────────────────────────────────

describe("startWebHttp — GET /api/web/leads pagination (G-P29.12)", () => {
  it("T-WEB.LEADS.1: given 5 memory events, when GET /api/web/leads?page=0&limit=2 then ?page=1&limit=2, first call returns newest 2; second returns next 2 (no overlap)", async () => {
    // Given: 5 person_memory_events with distinct created_at in memoryDb (G-P29.12)
    // When: GET /api/web/leads?page=0&limit=2 then page=1&limit=2
    // Then: page 0 → 2 newest events; page 1 → next 2 events; no overlap between pages
    const { deps, cleanup } = makeFixture();
    const base = new Date("2025-01-01T00:00:00.000Z");
    for (let i = 0; i < 5; i++) {
      appendPersonInteraction(
        {
          personName: `Person ${i}`,
          profileUrl: `https://linkedin.com/in/person${i}/`,
          interaction: "connect",
          summary: `Summary ${i}`,
          ts: base.getTime() + i * 60_000,
        },
        deps.memoryDb!,
      );
    }
    const { server, port } = await startTestServer(deps, undefined);
    try {
      const res0 = await fetch(`http://127.0.0.1:${port}/api/web/leads?page=0&limit=2`);
      const res1 = await fetch(`http://127.0.0.1:${port}/api/web/leads?page=1&limit=2`);
      assert.equal(res0.status, 200, "T-WEB.LEADS.1: page 0 must return 200");
      assert.equal(res1.status, 200, "T-WEB.LEADS.1: page 1 must return 200");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const body0 = (await res0.json()) as { events: any[]; page: number; limit: number };
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const body1 = (await res1.json()) as { events: any[]; page: number; limit: number };
      assert.equal(body0.events.length, 2, "T-WEB.LEADS.1: page 0 must return 2 events");
      assert.equal(body1.events.length, 2, "T-WEB.LEADS.1: page 1 must return 2 events");
      // Newest first ordering within page 0
      assert.ok(
        body0.events[0].created_at >= body0.events[1].created_at,
        "T-WEB.LEADS.1: page 0 events must be ordered newest-first",
      );
      // No overlap between pages
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const ids0 = body0.events.map((e: any) => e.id);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const ids1 = body1.events.map((e: any) => e.id);
      const overlap = ids0.filter((id: string) => ids1.includes(id));
      assert.equal(overlap.length, 0, "T-WEB.LEADS.1: no id overlap between page 0 and page 1");
    } finally {
      await stopServer(server);
      cleanup();
    }
  });
});

// ─── T-WEB.PERSONAS ───────────────────────────────────────────────────────────

describe("startWebHttp — GET /api/web/personas (G-P29.14)", () => {
  it("T-WEB.PERSONAS.1: given personasDir with 2 persona JSONs, when GET /api/web/personas, then personas has both with id/fullName/role/company", async () => {
    // Given: personasDir contains 2 valid persona JSON files (G-P29.14)
    // When: fetch GET /api/web/personas
    // Then: response.personas.length===2; each has id, fullName, role, company fields
    const { deps, personasDir, cleanup } = makeFixture();
    writePersonaTemplate(personasDir, "p1", {
      fullName: "Alice BD",
      role: "Business Development",
      company: "Acme Corp",
      priorities: [],
      traits: [],
      updatedAt: new Date().toISOString(),
    });
    writePersonaTemplate(personasDir, "p2", {
      fullName: "Bob Sales",
      role: "Sales Rep",
      company: "Beta Inc",
      priorities: [],
      traits: [],
      updatedAt: new Date().toISOString(),
    });
    const { server, port } = await startTestServer(deps, undefined);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/web/personas`);
      assert.equal(res.status, 200, "T-WEB.PERSONAS.1: GET /api/web/personas must return 200");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const body = (await res.json()) as { personas: any[] };
      assert.equal(body.personas.length, 2, "T-WEB.PERSONAS.1: must return 2 personas");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      for (const p of body.personas) {
        assert.ok("id" in p, "T-WEB.PERSONAS.1: each persona must have id field");
        assert.ok("fullName" in p, "T-WEB.PERSONAS.1: each persona must have fullName field");
        assert.ok("role" in p, "T-WEB.PERSONAS.1: each persona must have role field");
        assert.ok("company" in p, "T-WEB.PERSONAS.1: each persona must have company field");
      }
    } finally {
      await stopServer(server);
      cleanup();
    }
  });
});

// ─── T-WEB.INVITES ────────────────────────────────────────────────────────────

describe("startWebHttp — GET /api/web/invites (G-P29.15)", () => {
  it("T-WEB.INVITES.1: given invitesDb with a row for persona p1, when GET /api/web/invites?personaId=p1 → invite rows; when GET /api/web/invites (no param) → 400", async () => {
    // Given: invitesDb has 1 invite row for persona 'p1' (G-P29.15)
    // When A: GET /api/web/invites?personaId=p1 → invite array
    // When B: GET /api/web/invites (no personaId param) → 400 validation error
    const { deps, cleanup } = makeFixture();
    insertInvite(deps.invitesDb!, "a".repeat(64), "p1", null, Date.now() + 60_000);
    const { server, port } = await startTestServer(deps, undefined);
    try {
      const resOk = await fetch(`http://127.0.0.1:${port}/api/web/invites?personaId=p1`);
      const resBad = await fetch(`http://127.0.0.1:${port}/api/web/invites`);
      assert.equal(resOk.status, 200, "T-WEB.INVITES.1: GET /api/web/invites?personaId=p1 must return 200");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const bodyOk = (await resOk.json()) as { invites: any[] };
      assert.ok(Array.isArray(bodyOk.invites), "T-WEB.INVITES.1: invites must be an array");
      assert.equal(bodyOk.invites.length, 1, "T-WEB.INVITES.1: must return 1 invite row for p1");
      assert.equal(resBad.status, 400, "T-WEB.INVITES.1: GET /api/web/invites with no personaId must return 400");
    } finally {
      await stopServer(server);
      cleanup();
    }
  });
});

// ─── T-WEB.PROV ───────────────────────────────────────────────────────────────

describe("startWebHttp — POST /api/web/provision (G-P29.16, G-P29.17, G-P29.18, G-P29.19)", () => {
  it("T-WEB.PROV.1: given persona p1 + open invitesDb + serverUrl, when POST /api/web/provision {personaId:'p1'}, then 200 {ok:true, curlCommand, expiresAt, personaId}; 1 invite row inserted", async () => {
    // Given: persona 'p1' in personasDir; invitesDb open; serverUrl non-empty (G-P29.16)
    // When: POST /api/web/provision with {personaId:'p1'}
    // Then: 200 {ok:true, curlCommand matching /bootstrap\/[0-9a-f]{64}\.sh/, expiresAt, personaId:'p1'};
    //       invitesDb.prepare("SELECT COUNT(*)...").get() shows 1 inserted row
    const { deps, personasDir, cleanup } = makeFixture();
    writePersonaTemplate(personasDir, "p1", {
      fullName: "Alice BD",
      role: "BD",
      company: "Acme",
      priorities: [],
      traits: [],
      updatedAt: new Date().toISOString(),
    });
    const { server, port } = await startTestServer(deps, undefined);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/web/provision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personaId: "p1" }),
      });
      assert.equal(res.status, 200, "T-WEB.PROV.1: POST /api/web/provision with valid persona must return 200");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const body = (await res.json()) as any;
      assert.equal(body.ok, true, "T-WEB.PROV.1: response body must have ok:true");
      assert.ok(typeof body.curlCommand === "string", "T-WEB.PROV.1: curlCommand must be a string");
      assert.ok(
        /\/bootstrap\/[0-9a-f]{64}\.sh/.test(body.curlCommand),
        `T-WEB.PROV.1: curlCommand must contain 64-char hex token; got: ${body.curlCommand}`,
      );
      assert.ok(typeof body.expiresAt === "string", "T-WEB.PROV.1: expiresAt must be a string");
      assert.equal(body.personaId, "p1", "T-WEB.PROV.1: personaId must be 'p1'");
      // Verify invite row was inserted
      const row = deps.invitesDb!
        .prepare("SELECT COUNT(*) as cnt FROM invites WHERE persona_id='p1'")
        .get() as { cnt: number };
      assert.equal(row.cnt, 1, "T-WEB.PROV.1: exactly 1 invite row must be inserted for p1");
    } finally {
      await stopServer(server);
      cleanup();
    }
  });

  it("T-WEB.PROV.2: when POST /api/web/provision {personaId:'ghost'} (persona absent), then 422 {ok:false, error:'persona_not_found'}; zero invite rows", async () => {
    // Given: empty personasDir (persona 'ghost' does not exist) (G-P29.17)
    // When: POST /api/web/provision with {personaId:'ghost'}
    // Then: 422 {ok:false, error:'persona_not_found'}; invitesDb has 0 rows
    const { deps, cleanup } = makeFixture();
    const { server, port } = await startTestServer(deps, undefined);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/web/provision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personaId: "ghost" }),
      });
      assert.equal(res.status, 422, "T-WEB.PROV.2: absent persona must return 422");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const body = (await res.json()) as any;
      assert.equal(body.ok, false, "T-WEB.PROV.2: response body must have ok:false");
      assert.equal(body.error, "persona_not_found", "T-WEB.PROV.2: error must be 'persona_not_found'");
      // Zero invite rows
      const row = deps.invitesDb!.prepare("SELECT COUNT(*) as cnt FROM invites").get() as { cnt: number };
      assert.equal(row.cnt, 0, "T-WEB.PROV.2: no invite rows must be inserted for absent persona");
    } finally {
      await stopServer(server);
      cleanup();
    }
  });

  it("T-WEB.PROV.3: when POST /api/web/provision {} (missing personaId field), then 400 {ok:false, error:'validation'}", async () => {
    // Given: valid server (G-P29.18)
    // When: POST /api/web/provision with body={} (no personaId)
    // Then: 400 {ok:false, error:'validation'}
    const { deps, cleanup } = makeFixture();
    const { server, port } = await startTestServer(deps, undefined);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/web/provision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400, "T-WEB.PROV.3: missing personaId must return 400");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const body = (await res.json()) as any;
      assert.equal(body.ok, false, "T-WEB.PROV.3: response body must have ok:false");
      assert.equal(body.error, "validation", "T-WEB.PROV.3: error must be 'validation'");
    } finally {
      await stopServer(server);
      cleanup();
    }
  });

  it("T-WEB.PROV.4: given invitesDb=null, when POST /api/web/provision {personaId:'p1'}, then 503 {ok:false, error:'invites_db_unavailable'}", async () => {
    // Given: invitesDb is null (DB not available) (G-P29.19)
    // When: POST /api/web/provision with valid personaId
    // Then: 503 {ok:false, error:'invites_db_unavailable'}
    const { deps, personasDir, cleanup } = makeFixture({ invitesDb: null });
    writePersonaTemplate(personasDir, "p1", {
      fullName: "Alice BD",
      role: "BD",
      company: "Acme",
      priorities: [],
      traits: [],
      updatedAt: new Date().toISOString(),
    });
    const { server, port } = await startTestServer(deps, undefined);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/web/provision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personaId: "p1" }),
      });
      assert.equal(res.status, 503, "T-WEB.PROV.4: null invitesDb must return 503");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const body = (await res.json()) as any;
      assert.equal(body.ok, false, "T-WEB.PROV.4: response body must have ok:false");
      assert.equal(
        body.error,
        "invites_db_unavailable",
        "T-WEB.PROV.4: error must be 'invites_db_unavailable'",
      );
    } finally {
      await stopServer(server);
      cleanup();
    }
  });
});

// ─── T-WEB.404 ────────────────────────────────────────────────────────────────

describe("startWebHttp — unknown API route → 404 JSON", () => {
  it("T-WEB.404: when GET /api/web/nonexistent, then 404 JSON {error:'not_found'}", async () => {
    // Given: startWebHttp on ephemeral port (no matching route)
    // When: GET /api/web/nonexistent
    // Then: 404 JSON {error:'not_found'}
    const { deps, cleanup } = makeFixture();
    const { server, port } = await startTestServer(deps, undefined);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/web/nonexistent`);
      assert.equal(res.status, 404, "T-WEB.404: unknown /api/web/* route must return 404");
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const body = (await res.json()) as any;
      assert.equal(body.error, "not_found", "T-WEB.404: error must be 'not_found'");
    } finally {
      await stopServer(server);
      cleanup();
    }
  });
});
