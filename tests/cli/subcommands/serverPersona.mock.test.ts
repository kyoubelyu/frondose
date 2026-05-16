/**
 * P-27 Step 5 — T-CLI.PERS.*
 *
 * Tests for src/cli/subcommands/serverPersona.ts — runServerPersonaSubcommand.
 * Gate coverage: G-P27.15 (add/list/show/remove CLI actions),
 *                G-P27.16 (persona add idempotent write; remove non-existent)
 *
 * Strategy: override process.env.HOME to a tmpDir so SERVER_PERSONAS_DIR()
 * resolves to tmpDir/.mai/server/personas (lazy homedir() evaluation).
 * writePersonaTemplate creates dirs atomically; no pre-setup needed for 'add'.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runServerPersonaSubcommand } from "../../../src/cli/subcommands/serverPersona.js";
import { personaTemplateSchema } from "../../../src/persistence/personaLibrary.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p27-sp-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Minimal PersonaPrompter stub — satisfies the `question(key,prompt)` interface
 *  required by runServerPersonaSubcommand. Cast to `any` to bypass TypeScript's
 *  resolution of PersonaPrompter against the full `Prompter` type from _prompts.ts. */
// biome-ignore lint/suspicious/noExplicitAny: test DI stub — PersonaPrompter only needs `question`
function makePrompterStub(answers: Record<string, string> = {}): any {
  return {
    question: async (key: string, _prompt: string): Promise<string> => answers[key] ?? "",
  };
}

function validTemplateJson(fullName = "BD Alice"): string {
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

/** Returns the personas dir for the given HOME tmpDir. */
function personasDirFor(homeDir: string): string {
  return join(homeDir, ".mai", "server", "personas");
}

// ─── T-CLI.PERS.ADD.1 ────────────────────────────────────────────────────────

describe("mai server persona add — happy path (G-P27.15)", () => {
  it("T-CLI.PERS.ADD.1: given fromTemplate='{valid JSON}' and personaId='p1', persona file written to personasDir/p1.json", async () => {
    // Given: personasDir is empty; opts.fromTemplate contains valid PersonaTemplate JSON;
    //        opts.personaId='p1'; process.stdin.isTTY is false in tests (non-interactive)
    // When:  runServerPersonaSubcommand('add', {personaId:'p1', fromTemplate: '<json>'}, prompter)
    // Then:  no error thrown; personasDir/p1.json exists with fullName='BD Alice'
    const { dir, cleanup } = makeTmpDir();
    const originalHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      await runServerPersonaSubcommand(
        "add",
        { personaId: "p1", fromTemplate: validTemplateJson("BD Alice") },
        makePrompterStub(),
      );
      const expectedPath = join(personasDirFor(dir), "p1.json");
      assert.ok(existsSync(expectedPath), `p1.json must exist at ${expectedPath}`);
      const parsed = JSON.parse(readFileSync(expectedPath, "utf-8"));
      assert.equal(parsed.fullName, "BD Alice", "fullName must match template");
    } finally {
      process.env.HOME = originalHome;
      cleanup();
    }
  });
});

// ─── T-CLI.PERS.ADD.2 ────────────────────────────────────────────────────────

describe("mai server persona add — idempotent overwrite (G-P27.16)", () => {
  it("T-CLI.PERS.ADD.2: given persona 'p1' already exists, add with new fullName overwrites file (idempotent)", async () => {
    // Given: personasDir/p1.json exists with fullName='Alice';
    //        new add call with fromTemplate has fullName='Alice Updated'
    // When:  runServerPersonaSubcommand('add', {personaId:'p1', fromTemplate: '<updated json>'}, prompter)
    // Then:  no error; personasDir/p1.json updated; fullName='Alice Updated'
    const { dir, cleanup } = makeTmpDir();
    const originalHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      // Write original
      await runServerPersonaSubcommand(
        "add",
        { personaId: "p1", fromTemplate: validTemplateJson("Alice") },
        makePrompterStub(),
      );
      // Overwrite with new name
      await runServerPersonaSubcommand(
        "add",
        { personaId: "p1", fromTemplate: validTemplateJson("Alice Updated") },
        makePrompterStub(),
      );
      const expectedPath = join(personasDirFor(dir), "p1.json");
      const parsed = JSON.parse(readFileSync(expectedPath, "utf-8"));
      assert.equal(parsed.fullName, "Alice Updated", "fullName must be updated after second add");
    } finally {
      process.env.HOME = originalHome;
      cleanup();
    }
  });
});

// ─── T-CLI.PERS.LIST.1 ───────────────────────────────────────────────────────

describe("mai server persona list — 2 personas (G-P27.15)", () => {
  it("T-CLI.PERS.LIST.1: given personasDir has p1.json + p2.json, list resolves without error", async () => {
    // Given: personasDir has p1.json + p2.json (valid PersonaTemplates)
    // When:  runServerPersonaSubcommand('list', {json: false}, prompter)
    // Then:  no error thrown (stdout output is side effect; test verifies function resolves)
    const { dir, cleanup } = makeTmpDir();
    const originalHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      // Pre-create persona files via add (uses same HOME override)
      await runServerPersonaSubcommand(
        "add",
        { personaId: "p1", fromTemplate: validTemplateJson("BD Alice") },
        makePrompterStub(),
      );
      await runServerPersonaSubcommand(
        "add",
        { personaId: "p2", fromTemplate: validTemplateJson("BD Bob") },
        makePrompterStub(),
      );
      // list — should not throw
      await assert.doesNotReject(
        () => runServerPersonaSubcommand("list", { json: false }, makePrompterStub()),
        "list must not throw with 2 personas present",
      );
    } finally {
      process.env.HOME = originalHome;
      cleanup();
    }
  });
});

// ─── T-CLI.PERS.LIST.2 ───────────────────────────────────────────────────────

describe("mai server persona list — json flag (G-P27.15)", () => {
  it("T-CLI.PERS.LIST.2: given opts.json=true, list writes JSON array to stdout without throwing", async () => {
    // Given: personasDir has p1.json; opts.json=true
    // When:  runServerPersonaSubcommand('list', {json: true}, prompter)
    // Then:  no error thrown; stdout output captured via redirect contains persona JSON
    const { dir, cleanup } = makeTmpDir();
    const originalHome = process.env.HOME;
    process.env.HOME = dir;
    // Capture stdout
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // biome-ignore lint/suspicious/noExplicitAny: stdout capture
    process.stdout.write = (chunk: any) => { chunks.push(String(chunk)); return true; };
    try {
      await runServerPersonaSubcommand(
        "add",
        { personaId: "p1", fromTemplate: validTemplateJson("BD Alice") },
        makePrompterStub(),
      );
      // Reset capture for the list call
      chunks.length = 0;
      await runServerPersonaSubcommand("list", { json: true }, makePrompterStub());
      const output = chunks.join("");
      const parsed = JSON.parse(output.trim());
      assert.ok(Array.isArray(parsed), "json list output must be an array");
      assert.ok(parsed.length >= 1, "must have at least 1 persona");
      const p1 = parsed.find((p: { id: string }) => p.id === "p1");
      assert.ok(p1, "must contain p1 in json list");
      assert.equal(p1.fullName, "BD Alice");
    } finally {
      process.stdout.write = origWrite;
      process.env.HOME = originalHome;
      cleanup();
    }
  });
});

// ─── T-CLI.PERS.SHOW.1 ───────────────────────────────────────────────────────

describe("mai server persona show — persona exists (G-P27.15)", () => {
  it("T-CLI.PERS.SHOW.1: given personaId='p1' exists, show prints persona details without throwing", async () => {
    // Given: personasDir/p1.json has fullName='BD Alice'; opts.personaId='p1'
    // When:  runServerPersonaSubcommand('show', {personaId:'p1'}, prompter)
    // Then:  no error thrown; output contains fullName
    const { dir, cleanup } = makeTmpDir();
    const originalHome = process.env.HOME;
    process.env.HOME = dir;
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // biome-ignore lint/suspicious/noExplicitAny: stdout capture
    process.stdout.write = (chunk: any) => { chunks.push(String(chunk)); return true; };
    try {
      await runServerPersonaSubcommand(
        "add",
        { personaId: "p1", fromTemplate: validTemplateJson("BD Alice") },
        makePrompterStub(),
      );
      chunks.length = 0;
      await runServerPersonaSubcommand("show", { personaId: "p1" }, makePrompterStub());
      const output = chunks.join("");
      const parsed = JSON.parse(output.trim());
      assert.equal(parsed.fullName, "BD Alice", "show output must contain fullName='BD Alice'");
    } finally {
      process.stdout.write = origWrite;
      process.env.HOME = originalHome;
      cleanup();
    }
  });
});

// ─── T-CLI.PERS.REMOVE.1 ─────────────────────────────────────────────────────

describe("mai server persona remove — happy path (G-P27.15)", () => {
  it("T-CLI.PERS.REMOVE.1: given personaId='p1' exists, remove deletes personasDir/p1.json", async () => {
    // Given: personasDir/p1.json exists; opts.personaId='p1'
    // When:  runServerPersonaSubcommand('remove', {personaId:'p1'}, prompter)
    // Then:  no error; personasDir/p1.json no longer exists
    const { dir, cleanup } = makeTmpDir();
    const originalHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      await runServerPersonaSubcommand(
        "add",
        { personaId: "p1", fromTemplate: validTemplateJson("BD Alice") },
        makePrompterStub(),
      );
      const expectedPath = join(personasDirFor(dir), "p1.json");
      assert.ok(existsSync(expectedPath), "p1.json must exist before remove");
      await runServerPersonaSubcommand("remove", { personaId: "p1" }, makePrompterStub());
      assert.ok(!existsSync(expectedPath), "p1.json must be gone after remove");
    } finally {
      process.env.HOME = originalHome;
      cleanup();
    }
  });
});

// ─── T-CLI.PERS.REMOVE.2 ─────────────────────────────────────────────────────

describe("mai server persona remove — non-existent (G-P27.16)", () => {
  it("T-CLI.PERS.REMOVE.2: given personaId='ghost' not in personasDir, remove throws (does not silently succeed)", async () => {
    // Given: personasDir is empty; opts.personaId='ghost'
    // When:  runServerPersonaSubcommand('remove', {personaId:'ghost'}, prompter)
    // Then:  throws Error containing 'not found' — does not silently no-op
    const { dir, cleanup } = makeTmpDir();
    const originalHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      // Pre-create the personas dir so it exists but is empty
      mkdirSync(join(personasDirFor(dir)), { recursive: true });
      await assert.rejects(
        () => runServerPersonaSubcommand("remove", { personaId: "ghost" }, makePrompterStub()),
        (err: Error) => {
          assert.ok(
            err.message.includes("not found") || err.message.includes("ghost"),
            `error must mention 'not found' or 'ghost'; got: ${err.message}`,
          );
          return true;
        },
        "remove of non-existent persona must throw",
      );
    } finally {
      process.env.HOME = originalHome;
      cleanup();
    }
  });
});
