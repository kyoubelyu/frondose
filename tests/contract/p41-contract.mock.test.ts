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

describe("P-41 contract — makeAllTools server mode count (G-P41.7)", () => {
  it("T-C.1: makeAllTools({ mode:'server', ... }) returns 26 tools including 'provision_worker' and 'present_summary'", () => {
    // Given: src/tools/index.ts P-41 rewrite (E-9); makeAllTools called in server mode
    // When:  count keys in the returned ToolSet
    // Then:  Object.keys(tools).length === 26; "provision_worker" and "present_summary" are in the key set
    //
    // Server mode tool list (26 total; P-73 rebaseline: removed suggest_card/suggest_next_actions):
    //   echo (1) + memory x5 + identity x2 + operator-output x2 + control x3 (stop/sleep/escalate)
    //   + web x3 + server-specific x6 (list_workers/send_worker_message/provision_worker/
    //     revoke_worker/list_personas/dispatch_google_login) + schedule_task + stop_auto (2, P-REBASE-TOOL-COUNT: cron
    //     tools added at P-AUTO-ISOLATE) + todo_write [P-Y1] + present_summary [P-Y3] = 26
    //     (suggest_card/suggest_next_actions worker-only per P-73)
    const tools = makeAllTools(
      undefined, // no session (server mode ignores it)
      {
        memoryDbPath: ":memory:",
        identityPath: join(tmpdir(), "mai-test-identity-nonexistent.json"),
      },
      { requestStop: () => {} }, // control signals — enables operator-output + control tools
      undefined, // no hookRunner
      { mode: "server" },
    );
    const keys = Object.keys(tools);
    assert.equal(
      keys.length,
      26,
      `T-C.1: server mode must have 26 tools; got ${keys.length}: ${keys.sort().join(", ")}`,
    );
    assert.ok(keys.includes("provision_worker"), "T-C.1: 'provision_worker' must be in server tool set");
    assert.ok(keys.includes("present_summary"), "T-C.1: 'present_summary' must be in server tool set");
  });
});

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
