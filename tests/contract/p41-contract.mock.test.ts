/**
 * P-41 Step 5 — T-C.1-4 filled assertion bodies (G-P41.7, G-P41.8, G-P41.10)
 *
 * Strategy: structural checks — tool count, file existence, Zod schema parse,
 * grep for child_process IMPORTS (not bare substrings — see T-C.4 caveat).
 * No Chrome, no LLM, no network required.
 *
 * Gate covered: G-P41.7, G-P41.8, G-P41.10
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { secretsJsonSchema } from "../../src/persistence/secrets.js";
import { makeAllTools } from "../../src/tools/index.js";

process.env.FRONDOSE_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// ─── T-C.1 ────────────────────────────────────────────────────────────────────

// ─── T-C.1 ─── RETIRED with the fleet server mode ─────────────────────────────
// (server mode is deleted per T-RETIRE.Fleet.1; the single-mode App inventory
// is covered by the P-OPEN-SOURCE-SPLIT contract tests — 51 power / 49 consumer.)

// ─── T-C.2 ────────────────────────────────────────────────────────────────────

describe("P-41 contract — 4 retired source files do not exist (G-P41.8)", () => {
  it("T-C.2: the 4 files deleted in §2.1 do NOT exist on disk after P-41 Step 4b", () => {
    // Given: builder Step 4b (E-1..E-9) deleted the 4 source files (§2.1)
    // When:  existsSync(path) for each retired file
    // Then:  all 4 return false
    const retiredFiles = [
      "src/cli/serverBootstrapTemplate.ts",
      "src/persistence/invitesRegistry.ts",
      "src/cli/subcommands/serverInstallToken.ts",
      "src/cli/subcommands/bootstrapRegister.ts",
    ];
    for (const f of retiredFiles) {
      assert.ok(!existsSync(join(ROOT, f)), `T-C.2: retired file must NOT exist: ${f}`);
    }
  });
});

// ─── T-C.3 ────────────────────────────────────────────────────────────────────

describe("P-41 contract — secretsJsonSchema strips installToken (G-P41.8)", () => {
  it("T-C.3: secretsJsonSchema.parse({schema_version:1, server:{token:'x', installToken:'y'}}) → parsed object has no installToken key", () => {
    // Given: P-41 E-10 removes installToken from server sub-schema of secretsJsonSchema
    // When:  secretsJsonSchema.parse({ schema_version:1, server:{token:"x", installToken:"y"} })
    // Then:  result.server has 'token' but NOT 'installToken' (Zod strips unknown key by default)
    const raw = { schema_version: 1 as const, server: { token: "x", installToken: "y" } };
    const parsed = secretsJsonSchema.parse(raw);
    assert.ok(parsed.server?.token === "x", "T-C.3: server.token must be preserved");
    assert.ok(
      !("installToken" in (parsed.server ?? {})),
      `T-C.3: server must NOT have installToken (Zod strips unknown keys); got: ${JSON.stringify(parsed.server)}`,
    );
  });
});

// ─── T-C.4 ────────────────────────────────────────────────────────────────────

describe("P-41 contract — no child_process IMPORT in new/edited P-41 files (G-P41.10)", () => {
  it("T-C.4: grep import pattern for 'child_process' across P-41 new/edited source files → zero matches", () => {
    // Given: all P-41 new/edited files (E-1..E-12)
    // When:  grep for IMPORT patterns matching (node:)?child_process on those files
    // Then:  zero matches — runSshExec = ssh2 library (not child_process)
    //
    // IMPORTANT — T-C.4 caveat (builder flag 1):
    //   src/cli/serverSsh.ts:1 contains a doc-comment with the TEXT "child_process"
    //   ("ssh2 (pure-JS, NO child_process)"). This is NOT an import.
    //   This test uses a regex that matches only actual import forms to avoid false-positives.
    //   Patterns matched: `from "node:child_process"`, `from "child_process"`,
    //                     `require("node:child_process")`, `require("child_process")`
    const p41Files = [
      "src/cli/serverSsh.ts",
      "src/tools/server/provisionWorker.ts",
      "src/cli/serverHttp.ts",
      "src/cli/serverDaemon.ts",
      "src/cli/serverRepl.ts",
      "src/cli/serverWeb.ts",
      "src/cli/subcommands/serverWorker.ts",
      "src/cli/main.ts",
      "src/tools/index.ts",
      "src/persistence/secrets.ts",
      "src/persistence/serverPaths.ts",
    ];
    const importPattern =
      /\bfrom\s+["'](?:node:)?child_process["']|\brequire\s*\(\s*["'](?:node:)?child_process["']\s*\)/;

    const matches: string[] = [];
    for (const rel of p41Files) {
      const fullPath = join(ROOT, rel);
      if (!existsSync(fullPath)) continue;
      const content = readFileSync(fullPath, "utf-8");
      const lines = content.split("\n").filter((l) => importPattern.test(l));
      if (lines.length > 0) matches.push(`${rel}: ${lines.join(" | ")}`);
    }
    assert.equal(
      matches.length,
      0,
      `T-C.4: child_process IMPORT found in P-41 files (doc-comment hits indicate false-positive — fix the grep regex):\n${matches.join("\n")}`,
    );
  });
});

// Expose ROOT for Step 5 additions
export { ROOT };
