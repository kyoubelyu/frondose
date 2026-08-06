/**
 * P-25 Step 5 — T-MODE.WORKER.1, T-MODE.SERVER.1..2,
 *               T-CONTRACT.WORKER.TOOLS, T-CONTRACT.SERVER.TOOLS,
 *               T-CONTRACT.NO-BASH
 *
 * Tests for makeAllTools mode parameter + tool-count contracts.
 * Gate coverage: G-P25.2, G-P25.3, G-P25.18
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createLinkedinSession } from "../../src/linkedin/index.js";
import { makeAllTools } from "../../src/tools/index.js";
import { findChildProcessImports } from "../_helpers/childProcessAst.js";
import { cleanupTmpDir } from "../_helpers/tmp";

process.env.FRONDOSE_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): { memoryDbPath: string; identityPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p25-tools-"));
  return {
    memoryDbPath: join(dir, "memory.sqlite"),
    identityPath: join(dir, "identity.json"),
    cleanup: () => cleanupTmpDir(dir),
  };
}

const fakeControl = { requestStop: () => {}, auditPath: "/tmp/fake-audit.jsonl" };

// P-FIX-NOBASH-DETECTOR round-2 BLOCKER 3 + round-3 BLOCKER 2: widened from
// .ts-only to the broad extension set used elsewhere, incl. .mts/.cts
// (tsconfig.json's Node16 module resolution treats these as valid source
// extensions; a .js/.mts file under src/tools/** previously evaded this walker).
const SOURCE_FILE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(path);
    return entry.isFile() && SOURCE_FILE_RE.test(entry.name) ? [path] : [];
  });
}

// ─── T-MODE / T-CONTRACT ──────────────────────────────────────────────────────

describe("makeAllTools mode parameter (G-P25.2, G-P25.3)", () => {
  it("T-MODE.WORKER.1: makeAllTools with session + persistence returns 51 tools; no 'list_workers'", () => {
    // Given: the single-mode App startup path — session present, persistence present, no mode opts
    // When:  makeAllTools(session, persistence, control, undefined) — no 5th opts arg
    // Then:  returns ToolSet with 51 keys (P-OPEN-SOURCE-SPLIT: 54 − report_issue −
    //        query_lead_globally − publish_event) and does NOT include "list_workers"
    const { cleanup, ...paths } = makeTmpDir();
    try {
      const session = createLinkedinSession({ port: 9999, profileDir: "/tmp/fake-profile" });
      const tools = makeAllTools(session, paths, fakeControl, undefined);
      const count = Object.keys(tools).length;
      assert.equal(count, 51, `the App registry must have 51 tools; got ${count}: ${Object.keys(tools).join(", ")}`);
      assert.ok(!("list_workers" in tools), "the App registry must NOT include 'list_workers'");
    } finally {
      cleanup();
    }
  });

  // ─── T-MODE.SERVER.1/2 ─── RETIRED with the fleet server mode ────────────
  // (server mode and its session-ignoring warning are deleted per T-RETIRE.Fleet.1.)

  it("T-CONTRACT.WORKER.TOOLS: App startup tool count is 51", () => {
    // Given: the single-mode App startup path — session present, persistence present
    // When:  Object.keys(makeAllTools(session, persistence, control)).length checked
    // Then:  51 (P-OPEN-SOURCE-SPLIT single-mode inventory)
    const { cleanup, ...paths } = makeTmpDir();
    try {
      const session = createLinkedinSession({ port: 9999, profileDir: "/tmp/fake-profile" });
      const tools = makeAllTools(session, paths, fakeControl);
      const count = Object.keys(tools).length;
      assert.equal(count, 51, `App tool count must be 51; got ${count}: ${Object.keys(tools).join(", ")}`);
    } finally {
      cleanup();
    }
  });

  // (T-CONTRACT.SERVER.TOOLS — server startup count — retired with the fleet server mode.)

  it("T-CONTRACT.NO-BASH: zero child_process imports under src/tools/**", () => {
    // Given: source tree at current HEAD
    // When:  TypeScript files under the LLM-callable src/tools/** tree are AST-scanned for child_process
    //        imports/requires/re-exports (P-FIX-NOBASH-DETECTOR: replaces a regex that missed
    //        side-effect-only `import "child_process"` and string-concat/wrapped-callee obfuscation)
    // Then:  zero violations (Hard Rule 8 lint boundary — G-P25.18)
    const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
    const toolsRoot = join(projectRoot, "src", "tools");
    const hits = tsFilesUnder(toolsRoot).flatMap((file) => {
      const source = readFileSync(file, "utf-8");
      return findChildProcessImports(relative(projectRoot, file), source).length > 0
        ? [relative(projectRoot, file)]
        : [];
    });
    assert.deepStrictEqual(hits, [], `child_process imports found in src/tools/**: ${hits.join(", ")}`);
  });
});
