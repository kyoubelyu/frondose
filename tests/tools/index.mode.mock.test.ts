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
  it("T-MODE.WORKER.1: makeAllTools with session + persistence + no mode returns 54 tools; no 'list_workers'", () => {
    // Given: full worker startup path — session present, persistence present, mode defaults to "worker"
    // When:  makeAllTools(session, persistence, control, undefined) — no 5th opts arg
    // Then:  returns ToolSet with 54 keys (P-REBASE-TOOL-COUNT: stop_auto added at P-AUTO-ISOLATE)
    //        does NOT include "list_workers"
    const { cleanup, ...paths } = makeTmpDir();
    try {
      const session = createLinkedinSession({ port: 9999, profileDir: "/tmp/fake-profile" });
      const tools = makeAllTools(session, paths, fakeControl, undefined);
      const count = Object.keys(tools).length;
      assert.equal(count, 54, `worker mode must have 54 tools; got ${count}: ${Object.keys(tools).join(", ")}`);
      assert.ok(!("list_workers" in tools), "worker mode must NOT include 'list_workers'");
    } finally {
      cleanup();
    }
  });

  it("T-MODE.SERVER.1: makeAllTools(undefined, persistence, control, undefined, {mode:'server'}) returns 27 tools; includes echo, list_workers; does NOT include launch, inspect, qualify_profile", () => {
    // Given: makeAllTools called with mode='server' (5th opts arg)
    // When:  makeAllTools(undefined, persistence, control, undefined, {mode:"server"})
    // Then:  Object.keys result has length 27 (P-ISSUE-BOARD: suggest_card/suggest_next_actions removed from server;
    //        P-REBASE-TOOL-COUNT: stop_auto added at P-AUTO-ISOLATE).
    //        includes "echo", "recall", "remember", "telegram_notify", "list_workers";
    //        does NOT include "launch", "inspect", "qualify_profile"
    const { cleanup, ...paths } = makeTmpDir();
    try {
      const tools = makeAllTools(undefined, paths, fakeControl, undefined, { mode: "server" });
      const count = Object.keys(tools).length;
      assert.equal(count, 27, `server mode must have 27 tools; got ${count}: ${Object.keys(tools).join(", ")}`);
      assert.ok("echo" in tools, "server must include 'echo'");
      assert.ok("getMemory" in tools, "server must include 'getMemory'");
      assert.ok("remember" in tools, "server must include 'remember'");
      assert.ok("telegram_notify" in tools, "server must include 'telegram_notify'");
      assert.ok("list_workers" in tools, "server must include 'list_workers'");
      assert.ok(!("launch" in tools), "server must NOT include 'launch' (LinkedIn)");
      assert.ok(!("inspect" in tools), "server must NOT include 'inspect' (LinkedIn)");
      assert.ok(!("qualify_profile" in tools), "server must NOT include 'qualify_profile' (methodology)");
    } finally {
      cleanup();
    }
  });

  it("T-MODE.SERVER.2: when mode='server' AND session is truthy, LinkedIn tools still excluded; stderr contains warning", () => {
    // Given: fake session object (non-null) passed with mode="server"
    // When:  makeAllTools(fakeSession, persistence, control, undefined, {mode:"server"})
    // Then:  tool set still excludes LinkedIn tools (mode guard overrides session);
    //        process.stderr receives "[frondose] makeAllTools: ignoring session in server mode" message
    const { cleanup, ...paths } = makeTmpDir();
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process.stderr as any).write = (chunk: string | Buffer) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };
    try {
      const fakeSession = createLinkedinSession({ port: 9999, profileDir: "/tmp/fake-profile" });
      const tools = makeAllTools(fakeSession, paths, fakeControl, undefined, { mode: "server" });

      // LinkedIn tools still excluded despite session being present
      assert.ok(!("launch" in tools), "server mode must exclude LinkedIn tools even with session");
      assert.ok(!("inspect" in tools), "server mode must exclude LinkedIn tools even with session");

      // Warning emitted to stderr
      const stderr = stderrChunks.join("");
      assert.ok(
        stderr.includes("[frondose] makeAllTools: ignoring session in server mode"),
        `stderr must contain warning; got: ${stderr}`,
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stderr as any).write = origWrite;
      cleanup();
    }
  });

  it("T-CONTRACT.WORKER.TOOLS: worker startup tool count is 54", () => {
    // Given: worker startup path — session present, persistence present, mode not set
    // When:  Object.keys(makeAllTools(session, persistence, control)).length checked
    // Then:  54 (P-REBASE-TOOL-COUNT: stop_auto added at P-AUTO-ISOLATE)
    const { cleanup, ...paths } = makeTmpDir();
    try {
      const session = createLinkedinSession({ port: 9999, profileDir: "/tmp/fake-profile" });
      const tools = makeAllTools(session, paths, fakeControl);
      const count = Object.keys(tools).length;
      assert.equal(count, 54, `worker tool count must be 54; got ${count}: ${Object.keys(tools).join(", ")}`);
    } finally {
      cleanup();
    }
  });

  it("T-CONTRACT.SERVER.TOOLS: server startup tool count is 27", () => {
    // Given: server startup path — no session, persistence present, mode='server'
    // When:  Object.keys(tools).length checked
    // Then:  27 (P-ISSUE-BOARD: report_issue added power-tier)
    const { cleanup, ...paths } = makeTmpDir();
    try {
      const tools = makeAllTools(undefined, paths, fakeControl, undefined, { mode: "server" });
      const count = Object.keys(tools).length;
      assert.equal(count, 27, `server tool count must be 27; got ${count}: ${Object.keys(tools).join(", ")}`);
    } finally {
      cleanup();
    }
  });

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
