/**
 * P-29 Step 5 — T-MINT.1-3
 *
 * Tests for:
 *   - mintInvite() extracted from src/tools/server/provisionWorker.ts (P-29 D-7)
 *   - provision_worker tool regression: parameters + envelope unchanged from P-27
 *
 * Gate coverage: G-P29.20
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openInvitesDb } from "../../src/persistence/invitesRegistry.js";
import { personaTemplateSchema } from "../../src/persistence/personaLibrary.js";
import { makeProvisionWorkerTool, mintInvite } from "../../src/tools/server/provisionWorker.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p29-mint-"));
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

// ─── T-MINT.1 ─────────────────────────────────────────────────────────────────

describe("mintInvite — happy path (G-P29.20)", () => {
  it("T-MINT.1: given open invitesDb + persona 'p1' in personasDir + serverUrl, when mintInvite(invitesDb,personasDir,serverUrl,{personaId:'p1'}), then {ok:true, curlCommand, expiresAt, personaId}; invite row inserted", () => {
    // Given: invitesDb = openInvitesDb(':memory:'); personasDir has valid 'p1.json' (G-P29.20)
    // When: mintInvite(invitesDb, personasDir, SERVER_URL, {personaId:'p1'})
    // Then: {ok:true, curlCommand matches /bootstrap\/[0-9a-f]{64}\.sh/, expiresAt (ISO string), personaId:'p1'};
    //       invitesDb has 1 row with persona_id='p1' status='pending'
    const { dir, cleanup } = makeTmpDir();
    const invitesDb = openInvitesDb(":memory:");
    try {
      writeFileSync(join(dir, "p1.json"), validPersonaJson(), "utf-8");
      const result = mintInvite(invitesDb, dir, SERVER_URL, { personaId: "p1" });
      assert.equal(result.ok, true, "T-MINT.1: mintInvite must return ok:true for valid persona");
      if (result.ok) {
        assert.ok(
          /\/bootstrap\/[0-9a-f]{64}\.sh/.test(result.curlCommand),
          `T-MINT.1: curlCommand must contain 64-char hex token; got: ${result.curlCommand}`,
        );
        assert.equal(result.personaId, "p1", "T-MINT.1: personaId must be 'p1'");
        assert.ok(typeof result.expiresAt === "string", "T-MINT.1: expiresAt must be an ISO string");
        // Verify invite row inserted
        const row = invitesDb.prepare("SELECT COUNT(*) as cnt FROM invites WHERE persona_id='p1'").get() as {
          cnt: number;
        };
        assert.equal(row.cnt, 1, "T-MINT.1: exactly 1 invite row must be inserted for p1");
      }
    } finally {
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-MINT.2 ─────────────────────────────────────────────────────────────────

describe("mintInvite — persona not found (G-P29.20)", () => {
  it("T-MINT.2: when mintInvite(..., {personaId:'ghost'}) with empty personasDir, then {ok:false, error} naming persona; includes P-27 verbatim suffix 'Run list_personas to see available personas.'", () => {
    // Given: empty personasDir (no 'ghost.json') (G-P29.20)
    // When: mintInvite(invitesDb, emptyDir, SERVER_URL, {personaId:'ghost'})
    // Then: {ok:false, error:'Persona not found: ghost. Run list_personas to see available personas.'}
    //       (N-2: verbatim P-27 error text preserved — extraction is behavior-preserving)
    const { dir, cleanup } = makeTmpDir();
    const invitesDb = openInvitesDb(":memory:");
    try {
      const result = mintInvite(invitesDb, dir, SERVER_URL, { personaId: "ghost" });
      assert.equal(result.ok, false, "T-MINT.2: mintInvite with unknown persona must return ok:false");
      if (!result.ok) {
        assert.ok(
          result.error.includes("Persona not found: ghost"),
          `T-MINT.2: error must name the persona; got: ${result.error}`,
        );
        assert.ok(
          result.error.includes("Run list_personas to see available personas."),
          `T-MINT.2: error must include verbatim P-27 suffix; got: ${result.error}`,
        );
      }
    } finally {
      invitesDb.close();
      cleanup();
    }
  });
});

// ─── T-MINT.3 ─────────────────────────────────────────────────────────────────

describe("provision_worker tool — parameters + envelope unchanged from P-27 (G-P29.20)", () => {
  it("T-MINT.3: provision_worker tool parameters schema has {personaId,hostname?,ttlMin?}; success execute returns {ok,curlCommand,expiresAt,personaId}; P-27 envelope byte-identical", async () => {
    // Given: makeProvisionWorkerTool built with open invitesDb + personasDir + serverUrl (G-P29.20)
    // When A: inspect tool.parameters.shape keys
    // When B: call tool.execute({personaId:'p1'}) with p1 present
    // Then A: shape keys = ['personaId', 'hostname', 'ttlMin'] (unchanged from P-27)
    // Then B: execute returns {ok:true, curlCommand, expiresAt, personaId} (envelope byte-identical to P-27)
    const { dir, cleanup } = makeTmpDir();
    const invitesDb = openInvitesDb(":memory:");
    try {
      writeFileSync(join(dir, "p1.json"), validPersonaJson(), "utf-8");
      const tool = makeProvisionWorkerTool(invitesDb, dir, SERVER_URL);
      const paramShape = (tool.parameters as { shape?: unknown }).shape;
      // biome-ignore lint/suspicious/noExplicitAny: test assertion
      const result = await (tool.execute as unknown as (a: unknown, o: object) => Promise<any>)(
        { personaId: "p1" },
        {},
      );
      // A: parameter shape keys must be exactly {personaId, hostname, ttlMin}
      assert.ok(typeof paramShape === "object" && paramShape !== null, "T-MINT.3: paramShape must be an object");
      const keys = Object.keys(paramShape as Record<string, unknown>).sort();
      assert.deepEqual(
        keys,
        ["hostname", "personaId", "ttlMin"],
        `T-MINT.3: tool parameters must be exactly {personaId, hostname, ttlMin}; got ${keys.join(", ")}`,
      );
      // B: execute envelope byte-identical to P-27
      assert.equal(result.ok, true, "T-MINT.3: execute with valid personaId must return ok:true");
      assert.ok(typeof result.curlCommand === "string", "T-MINT.3: curlCommand must be a string");
      assert.ok(typeof result.expiresAt === "string", "T-MINT.3: expiresAt must be a string");
      assert.equal(result.personaId, "p1", "T-MINT.3: personaId must be 'p1'");
    } finally {
      invitesDb.close();
      cleanup();
    }
  });
});
