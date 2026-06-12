/**
 * P-27 Step 5 — T-PERS.1..7
 *
 * Tests for src/persistence/personaLibrary.ts — filesystem CRUD for persona templates.
 * Gate coverage: G-P27.14 (list), G-P27.15 (add/write), G-P27.16 (show/remove),
 *                G-P27.28 (malformed / schema-fail returns null + stderr warning)
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  deletePersonaTemplate,
  listPersonaTemplates,
  personaTemplateSchema,
  readPersonaTemplate,
  writePersonaTemplate,
} from "../../src/persistence/personaLibrary.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p27-persona-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function validTemplate() {
  return personaTemplateSchema.parse({
    fullName: "Test Worker",
    role: "BD Specialist",
    company: "Acme",
    priorities: ["Close deals"],
    traits: ["persistent"],
    updatedAt: new Date().toISOString(),
  });
}

// ─── T-PERS.1 ─────────────────────────────────────────────────────────────────

describe("listPersonaTemplates — empty dir (G-P27.14)", () => {
  it("T-PERS.1: given empty personasDir, listPersonaTemplates returns []", () => {
    // Given: empty tmp directory
    // When:  listPersonaTemplates(dir)
    // Then:  returns empty array
    const { dir, cleanup } = makeTmpDir();
    try {
      const ids = listPersonaTemplates(dir);
      assert.deepEqual(ids, []);
    } finally {
      cleanup();
    }
  });
});

// ─── T-PERS.2 ─────────────────────────────────────────────────────────────────

describe("listPersonaTemplates — multiple files (G-P27.14)", () => {
  it("T-PERS.2: given p1.json + p2.json in personasDir, listPersonaTemplates returns sorted ['p1','p2']", () => {
    // Given: tmp dir with p2.json and p1.json (inserted out of order)
    // When:  listPersonaTemplates(dir)
    // Then:  returns ['p1', 'p2'] (sorted); notes.txt ignored
    const { dir, cleanup } = makeTmpDir();
    try {
      writeFileSync(join(dir, "p2.json"), "{}", "utf-8");
      writeFileSync(join(dir, "p1.json"), "{}", "utf-8");
      writeFileSync(join(dir, "notes.txt"), "ignored", "utf-8");
      const ids = listPersonaTemplates(dir);
      assert.deepEqual(ids, ["p1", "p2"]);
    } finally {
      cleanup();
    }
  });
});

// ─── T-PERS.3 ─────────────────────────────────────────────────────────────────

describe("readPersonaTemplate — valid file (G-P27.15)", () => {
  it("T-PERS.3: given valid p1.json, readPersonaTemplate returns parsed PersonaTemplate object", () => {
    // Given: tmp dir with valid p1.json
    // When:  readPersonaTemplate(dir, 'p1')
    // Then:  returns non-null PersonaTemplate with fullName='Test Worker'
    const { dir, cleanup } = makeTmpDir();
    try {
      const t = validTemplate();
      writeFileSync(join(dir, "p1.json"), JSON.stringify(t), "utf-8");
      const result = readPersonaTemplate(dir, "p1");
      assert.ok(result !== null, "must return non-null for valid file");
      assert.equal(result.fullName, "Test Worker");
      assert.equal(result.role, "BD Specialist");
      assert.equal(result.company, "Acme");
    } finally {
      cleanup();
    }
  });
});

// ─── T-PERS.4 ─────────────────────────────────────────────────────────────────

describe("readPersonaTemplate — missing file (G-P27.16)", () => {
  it("T-PERS.4: given missing file, readPersonaTemplate returns null", () => {
    // Given: empty personasDir (no p1.json)
    // When:  readPersonaTemplate(dir, 'nope')
    // Then:  returns null; no throw
    const { dir, cleanup } = makeTmpDir();
    try {
      const result = readPersonaTemplate(dir, "nope");
      assert.equal(result, null);
    } finally {
      cleanup();
    }
  });
});

// ─── T-PERS.5 ─────────────────────────────────────────────────────────────────

describe("readPersonaTemplate — malformed JSON (G-P27.28)", () => {
  it("T-PERS.5: given p1.json with invalid JSON, readPersonaTemplate emits stderr warning and returns null", () => {
    // Given: p1.json contains invalid JSON
    // When:  readPersonaTemplate(dir, 'p1')
    // Then:  returns null; stderr contains [frondose] persona template
    const { dir, cleanup } = makeTmpDir();
    try {
      writeFileSync(join(dir, "p1.json"), "{ not valid json }", "utf-8");
      const stderrChunks: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // biome-ignore lint/suspicious/noExplicitAny: stderr capture
      process.stderr.write = (chunk: any) => {
        stderrChunks.push(String(chunk));
        return true;
      };
      let result: ReturnType<typeof readPersonaTemplate>;
      try {
        result = readPersonaTemplate(dir, "p1");
      } finally {
        process.stderr.write = origWrite;
      }
      assert.equal(result, null, "must return null for malformed JSON");
      const stderr = stderrChunks.join("");
      assert.ok(
        stderr.includes("[frondose] persona template"),
        `stderr must contain [frondose] persona template; got: ${stderr}`,
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-PERS.6 ─────────────────────────────────────────────────────────────────

describe("readPersonaTemplate — invalid schema (G-P27.28)", () => {
  it("T-PERS.6: given p1.json missing required 'fullName', readPersonaTemplate emits stderr warning and returns null", () => {
    // Given: p1.json is valid JSON but fails personaTemplateSchema (no fullName)
    // When:  readPersonaTemplate(dir, 'p1')
    // Then:  returns null; stderr warning emitted
    const { dir, cleanup } = makeTmpDir();
    try {
      writeFileSync(join(dir, "p1.json"), JSON.stringify({ role: "BD", updatedAt: new Date().toISOString() }), "utf-8");
      const stderrChunks: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      // biome-ignore lint/suspicious/noExplicitAny: stderr capture
      process.stderr.write = (chunk: any) => {
        stderrChunks.push(String(chunk));
        return true;
      };
      let result: ReturnType<typeof readPersonaTemplate>;
      try {
        result = readPersonaTemplate(dir, "p1");
      } finally {
        process.stderr.write = origWrite;
      }
      assert.equal(result, null, "must return null for schema-invalid file");
      assert.ok(stderrChunks.join("").includes("[frondose]"), "must emit stderr warning");
    } finally {
      cleanup();
    }
  });
});

// ─── T-PERS.7 ─────────────────────────────────────────────────────────────────

describe("writePersonaTemplate — atomic write (G-P27.15)", () => {
  it("T-PERS.7: writePersonaTemplate creates p1.json atomically (tmp+rename) and file is parseable", () => {
    // Given: empty tmp personasDir
    // When:  writePersonaTemplate(dir, 'p1', validTemplate())
    // Then:  p1.json exists; re-parses correctly; no .tmp file left behind
    const { dir, cleanup } = makeTmpDir();
    try {
      const t = validTemplate();
      writePersonaTemplate(dir, "p1", t);
      const path = join(dir, "p1.json");
      assert.ok(existsSync(path), "p1.json must exist after write");
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      assert.equal(parsed.fullName, "Test Worker");
      // No .tmp leftover
      assert.ok(!existsSync(`${path}.tmp`), "no .tmp file should remain");
      // deletePersonaTemplate smoke
      const deleted = deletePersonaTemplate(dir, "p1");
      assert.equal(deleted, true, "deletePersonaTemplate must return true");
      assert.ok(!existsSync(path), "p1.json must be gone after delete");
      const deletedAgain = deletePersonaTemplate(dir, "p1");
      assert.equal(deletedAgain, false, "deletePersonaTemplate must return false when file absent");
    } finally {
      cleanup();
    }
  });
});
