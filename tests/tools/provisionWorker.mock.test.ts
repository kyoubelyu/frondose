/**
 * P-27 Step 5 — T-PROV.1..5
 *
 * Tests for src/tools/server/provisionWorker.ts — makeProvisionWorkerTool.
 * Gate coverage: G-P27.11 (happy path: curl command + invite row),
 *                G-P27.12 (persona missing or invitesDb null → {ok:false})
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openInvitesDb } from "../../src/persistence/invitesRegistry.js";
import { personaTemplateSchema } from "../../src/persistence/personaLibrary.js";
import { makeProvisionWorkerTool } from "../../src/tools/server/provisionWorker.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p27-prov-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function validPersonaJson(): string {
  return JSON.stringify(
    personaTemplateSchema.parse({
      fullName: "BD Alice",
      role: "BD Specialist",
      company: "Acme",
      priorities: [],
      traits: [],
      updatedAt: new Date().toISOString(),
    }),
  );
}

const SERVER_URL = "http://100.64.0.5:3031";

// ─── T-PROV.1 ─────────────────────────────────────────────────────────────────

describe("provision_worker — happy path (G-P27.11)", () => {
  it("T-PROV.1: given invitesDb open + persona 'p1' present, execute returns {ok:true, curlCommand, expiresAt, personaId:'p1'} and invite row inserted", async () => {
    // Given: invitesDb = openInvitesDb(':memory:');
    //        personasDir has 'p1.json' (valid PersonaTemplate, fullName='BD Alice')
    //        serverUrl='http://100.64.0.5:3031'
    // When:  tool.execute({personaId:'p1'})
    // Then:  result.ok=true;
    //        result.curlCommand matches /^curl -sf .+\/bootstrap\/[0-9a-f]{64}\.sh \| bash$/
    //        result.personaId='p1'; result.expiresAt is ISO string;
    //        invitesDb has 1 row with persona_id='p1' and status='pending'
    const { dir, cleanup } = makeTmpDir();
    try {
      const invitesDb = openInvitesDb(":memory:");
      writeFileSync(join(dir, "p1.json"), validPersonaJson(), "utf-8");
      const tool = makeProvisionWorkerTool(invitesDb, dir, SERVER_URL);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = await (tool.execute as unknown as (a: unknown, o: object) => Promise<any>)({ personaId: "p1" }, {});
      assert.equal(result.ok, true, `expected ok=true; got: ${JSON.stringify(result)}`);
      assert.ok(
        /^curl -sf .+\/bootstrap\/[0-9a-f]{64}\.sh \| bash$/.test(result.curlCommand),
        `curlCommand must match bootstrap URL pattern; got: ${result.curlCommand}`,
      );
      assert.equal(result.personaId, "p1");
      assert.ok(typeof result.expiresAt === "string", "expiresAt must be ISO string");
      // Invite row must be in DB
      const rows = invitesDb
        .prepare("SELECT persona_id, status FROM invites WHERE persona_id='p1'")
        .all() as Array<{ persona_id: string; status: string }>;
      assert.equal(rows.length, 1, "one invite row must exist for persona_id='p1'");
      assert.equal(rows[0].status, "pending");
      invitesDb.close();
    } finally {
      cleanup();
    }
  });
});

// ─── T-PROV.2 ─────────────────────────────────────────────────────────────────

describe("provision_worker — persona not found (G-P27.12)", () => {
  it("T-PROV.2: given invitesDb open but persona 'unknown' absent from personasDir, execute returns {ok:false, error:'Persona not found: unknown...'}", async () => {
    // Given: invitesDb = openInvitesDb(':memory:'); empty personasDir
    // When:  tool.execute({personaId:'unknown'})
    // Then:  result.ok=false; result.error contains 'Persona not found: unknown'
    const { dir, cleanup } = makeTmpDir();
    try {
      const invitesDb = openInvitesDb(":memory:");
      const tool = makeProvisionWorkerTool(invitesDb, dir, SERVER_URL);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = await (tool.execute as unknown as (a: unknown, o: object) => Promise<any>)({ personaId: "unknown" }, {});
      assert.equal(result.ok, false);
      assert.ok(
        typeof result.error === "string" && result.error.includes("Persona not found: unknown"),
        `error must contain 'Persona not found: unknown'; got: ${result.error}`,
      );
      invitesDb.close();
    } finally {
      cleanup();
    }
  });
});

// ─── T-PROV.3 ─────────────────────────────────────────────────────────────────

describe("provision_worker — invitesDb null (G-P27.12)", () => {
  it("T-PROV.3: given invitesDb=null, execute returns {ok:false, error:'invites.sqlite not initialized'}", async () => {
    // Given: invitesDb=null (DB not initialized — e.g. open failed at server boot)
    // When:  tool.execute({personaId:'p1'})
    // Then:  result.ok=false; result.error='invites.sqlite not initialized'
    const { dir, cleanup } = makeTmpDir();
    try {
      const tool = makeProvisionWorkerTool(null, dir, SERVER_URL);
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = await (tool.execute as unknown as (a: unknown, o: object) => Promise<any>)({ personaId: "p1" }, {});
      assert.equal(result.ok, false);
      assert.equal(result.error, "invites.sqlite not initialized");
    } finally {
      cleanup();
    }
  });
});

// ─── T-PROV.4 ─────────────────────────────────────────────────────────────────

describe("provision_worker — TTL lower bound (G-P27.11)", () => {
  it("T-PROV.4: given ttlMin=5 (lower bound), invite expires_at is ~5 minutes from now (±5s)", async () => {
    // Given: invitesDb open; persona 'p1' present; ttlMin=5
    // When:  tool.execute({personaId:'p1', ttlMin:5})
    // Then:  result.ok=true;
    //        invite row in invitesDb has expires_at in range [now+295_000, now+305_000]
    const { dir, cleanup } = makeTmpDir();
    try {
      const invitesDb = openInvitesDb(":memory:");
      writeFileSync(join(dir, "p1.json"), validPersonaJson(), "utf-8");
      const tool = makeProvisionWorkerTool(invitesDb, dir, SERVER_URL);
      const beforeMs = Date.now();
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = await (tool.execute as unknown as (a: unknown, o: object) => Promise<any>)({ personaId: "p1", ttlMin: 5 }, {});
      assert.equal(result.ok, true, `expected ok=true; got: ${JSON.stringify(result)}`);
      const row = invitesDb
        .prepare("SELECT expires_at FROM invites WHERE persona_id='p1'")
        .get() as { expires_at: number } | undefined;
      assert.ok(row, "invite row must exist");
      const expiresAt = row.expires_at;
      assert.ok(
        expiresAt >= beforeMs + 295_000 && expiresAt <= beforeMs + 305_000,
        `expires_at=${expiresAt} must be in [now+295000, now+305000]; beforeMs=${beforeMs}`,
      );
      invitesDb.close();
    } finally {
      cleanup();
    }
  });
});

// ─── T-PROV.5 ─────────────────────────────────────────────────────────────────

describe("provision_worker — TTL below minimum (Zod validation) (G-P27.11)", () => {
  it("T-PROV.5: given ttlMin=2 (below Zod min=5), tool.parameters.safeParse({personaId:'p1',ttlMin:2}) returns {success:false}", () => {
    // Given: valid invitesDb + persona; ttlMin=2
    // When:  access tool.parameters and call .safeParse({personaId:'p1', ttlMin:2})
    // Then:  {success: false} — Zod .min(5) constraint rejects 2
    const { dir, cleanup } = makeTmpDir();
    try {
      const invitesDb = openInvitesDb(":memory:");
      writeFileSync(join(dir, "p1.json"), validPersonaJson(), "utf-8");
      const tool = makeProvisionWorkerTool(invitesDb, dir, SERVER_URL);
      // tool.parameters is the Zod schema
      const params = tool.parameters as { safeParse: (v: unknown) => { success: boolean } };
      const parsed = params.safeParse({ personaId: "p1", ttlMin: 2 });
      assert.equal(parsed.success, false, "ttlMin=2 must fail Zod min(5) validation");
      // Confirm ttlMin=5 passes
      const valid = params.safeParse({ personaId: "p1", ttlMin: 5 });
      assert.equal(valid.success, true, "ttlMin=5 must pass Zod min(5) validation");
      invitesDb.close();
    } finally {
      cleanup();
    }
  });
});
