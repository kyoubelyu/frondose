/**
 * P-28 Step 4a — T-PERS.CRED.1..3
 *
 * Tests for persona credential reference fields in src/persistence/personaLibrary.ts
 * and src/cli/subcommands/serverPersona.ts.
 * Gate coverage: G-P28.27 (personaTemplateSchema accepts llmKeyRef + googleAccountRef),
 *                G-P28.28 (serverPersona add writes refs into persona file via fromTemplate path)
 *
 * T-PERS.CRED.3 notes:
 *   The interactive prompter path requires process.stdin/stdout to be a TTY
 *   (isInteractive() check). In test runners this is false. We therefore use the
 *   non-interactive fromTemplate path with HOME override to control SERVER_PERSONAS_DIR().
 *   This path tests the same contract: a persona file written by runServerPersonaSubcommand
 *   preserves llmKeyRef + googleAccountRef (the schematic correctness gate).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  personaTemplateSchema,
  readPersonaTemplate,
  writePersonaTemplate,
} from "../../src/persistence/personaLibrary.js";
import { runServerPersonaSubcommand } from "../../src/cli/subcommands/serverPersona.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p28-persona-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ─── T-PERS.CRED.1 ────────────────────────────────────────────────────────────

describe("personaTemplateSchema: accepts llmKeyRef + googleAccountRef (G-P28.27)", () => {
  it("T-PERS.CRED.1: given persona JSON with llmKeyRef + googleAccountRef set, personaTemplateSchema.parse + readPersonaTemplate round-trip preserve both fields", () => {
    // Given: persona JSON = {fullName:'BD Alice', ..., llmKeyRef:'k1', googleAccountRef:'g1'}
    // When:  personaTemplateSchema.parse(json); writePersonaTemplate + readPersonaTemplate round-trip
    // Then:  parsed.llmKeyRef === 'k1'; parsed.googleAccountRef === 'g1'; no throw
    const { dir, cleanup } = makeTmpDir();
    try {
      const parsed = personaTemplateSchema.parse({
        fullName: "BD Alice",
        role: "BD",
        company: "Acme",
        priorities: [],
        traits: [],
        llmKeyRef: "k1",
        googleAccountRef: "g1",
        updatedAt: new Date().toISOString(),
      });
      assert.equal(parsed.llmKeyRef, "k1", "T-PERS.CRED.1: personaTemplateSchema.parse must accept llmKeyRef='k1' (G-P28.27)");
      assert.equal(parsed.googleAccountRef, "g1", "T-PERS.CRED.1: personaTemplateSchema.parse must accept googleAccountRef='g1'");

      // Round-trip via writePersonaTemplate + readPersonaTemplate
      writePersonaTemplate(dir, "p1", parsed);
      const readBack = readPersonaTemplate(dir, "p1");
      assert.ok(readBack !== null, "T-PERS.CRED.1: readPersonaTemplate must return non-null after write");
      assert.equal(readBack.llmKeyRef, "k1", "T-PERS.CRED.1: readPersonaTemplate must preserve llmKeyRef='k1'");
      assert.equal(readBack.googleAccountRef, "g1", "T-PERS.CRED.1: readPersonaTemplate must preserve googleAccountRef='g1'");
    } finally {
      cleanup();
    }
  });
});

// ─── T-PERS.CRED.2 ────────────────────────────────────────────────────────────

describe("personaTemplateSchema: P-27-era persona (no refs) still parses (G-P28.27 backward compat)", () => {
  it("T-PERS.CRED.2: given a P-27-era persona JSON WITHOUT llmKeyRef or googleAccountRef, personaTemplateSchema.parse succeeds with both refs undefined", () => {
    // Given: persona JSON = {fullName:'BD Alice', role:'BD', company:'Acme', ...} — no llmKeyRef/googleAccountRef
    // When:  personaTemplateSchema.parse(json)
    // Then:  parsed.llmKeyRef === undefined; parsed.googleAccountRef === undefined; no throw
    let parsed: ReturnType<typeof personaTemplateSchema.parse> | undefined;
    assert.doesNotThrow(() => {
      parsed = personaTemplateSchema.parse({
        fullName: "BD Alice",
        role: "BD",
        company: "Acme",
        priorities: [],
        traits: [],
        updatedAt: new Date().toISOString(),
      });
    }, "T-PERS.CRED.2: P-27-era persona (no refs) must parse without throw");
    assert.equal(parsed?.llmKeyRef, undefined, "T-PERS.CRED.2: llmKeyRef must be undefined when not provided (backward compat G-P28.27)");
    assert.equal(parsed?.googleAccountRef, undefined, "T-PERS.CRED.2: googleAccountRef must be undefined when not provided");
  });
});

// ─── T-PERS.CRED.3 ────────────────────────────────────────────────────────────

describe("runServerPersonaSubcommand add: fromTemplate path writes llmKeyRef + googleAccountRef (G-P28.28)", () => {
  it("T-PERS.CRED.3: given fromTemplate JSON with llmKeyRef='k1' + googleAccountRef='g1', runServerPersonaSubcommand add writes both refs into the persona file", async () => {
    // Given: tmp dir as HOME so SERVER_PERSONAS_DIR() resolves under tmp;
    //        fromTemplate JSON string with llmKeyRef='k1' + googleAccountRef='g1'
    //        Non-interactive mode (test runner has no TTY) → fromTemplate is written directly
    // When:  runServerPersonaSubcommand('add', {personaId:'p1', fromTemplate: jsonStr})
    // Then:  readPersonaTemplate(personasDir, 'p1').llmKeyRef === 'k1';
    //        readPersonaTemplate(personasDir, 'p1').googleAccountRef === 'g1'; no throw
    // NOTE:  Interactive prompter path requires TTY; this test uses the fromTemplate
    //        non-interactive code path which exercises the same schema correctness gate.
    const { dir, cleanup } = makeTmpDir();
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = dir;
      const template = JSON.stringify(
        personaTemplateSchema.parse({
          fullName: "BD Alice",
          role: "BD Specialist",
          company: "Acme",
          priorities: [],
          traits: [],
          llmKeyRef: "k1",
          googleAccountRef: "g1",
          updatedAt: new Date().toISOString(),
        }),
      );

      await assert.doesNotReject(
        () => runServerPersonaSubcommand("add", { personaId: "p1", fromTemplate: template }),
        "T-PERS.CRED.3: runServerPersonaSubcommand add must not throw",
      );

      // SERVER_PERSONAS_DIR() = join(homedir(), ".mai", "server", "personas") → join(dir, ".mai", "server", "personas")
      const personasDir = join(dir, ".mai", "server", "personas");
      const readBack = readPersonaTemplate(personasDir, "p1");
      assert.ok(readBack !== null, "T-PERS.CRED.3: readPersonaTemplate must return non-null after runServerPersonaSubcommand add");
      assert.equal(readBack.llmKeyRef, "k1", "T-PERS.CRED.3: written persona must preserve llmKeyRef='k1' (G-P28.28)");
      assert.equal(readBack.googleAccountRef, "g1", "T-PERS.CRED.3: written persona must preserve googleAccountRef='g1'");
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
      cleanup();
    }
  });
});
