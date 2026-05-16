/**
 * P-26 Step 5 — T-CONTRACT.WORKER.TOOLS, T-CONTRACT.SERVER.TOOLS,
 *               T-CONTRACT.NO-BASH
 *
 * Contract regression tests: worker tool count = 26, server tool count = 15,
 * no child_process imports in tool/persistence/agent layers.
 * Gate coverage: G-P26.26, G-P26.27
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { LinkedinSession } from "../../src/linkedin/types.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p26-contract-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Minimal LinkedinSession mock — only satisfies the interface; never boots Chrome. */
const mockSession: LinkedinSession = {
  getOrInitClient: async () => ({ ok: false as const, error: "chrome_unavailable" as const, message: "mock" }),
  getClient: () => undefined,
  heartbeat: async () => true,
  setLastContext: () => {},
  getLastContext: () => undefined,
};

const mockControl: ControlSignals = { requestStop: () => {} };

describe("makeAllTools tool-count contract (G-P26.26)", () => {
  it("T-CONTRACT.WORKER.TOOLS: worker mode with session + persistence + control → exactly 28 tools", () => {
    // Given: makeAllTools(session, persistence, control, undefined, {mode:"worker"})
    // When:  Object.keys(tools).length computed
    // Then:  28 (was 26 at P-26; P-28.5 adds navigate_to_url + clear_cookies)
    const { dir, cleanup } = makeTmpDir();
    try {
      const persistence = {
        memoryDbPath: join(dir, "memory.sqlite"),
        identityPath: join(dir, "identity.json"),
      };
      const tools = makeAllTools(mockSession, persistence, mockControl, undefined, { mode: "worker" });
      const count = Object.keys(tools).length;
      assert.equal(
        count,
        28, // P-28.5: +navigate_to_url +clear_cookies (was 26 at P-26)
        `T-CONTRACT.WORKER.TOOLS: expected 28 worker tools; got ${count}. Keys: ${Object.keys(tools).sort().join(", ")}`,
      );
    } finally {
      cleanup();
    }
  });

  it("T-CONTRACT.SERVER.TOOLS: server mode with persistence + control (no session) → exactly 19 tools (P-28.5 updated: +dispatch_google_login)", () => {
    // Given: makeAllTools(undefined, persistence, control, undefined, {mode:"server"})
    // When:  Object.keys(tools).length computed
    // Then:  19 (was 18 at P-26/P-27; P-28.5 adds dispatch_google_login)
    const { dir, cleanup } = makeTmpDir();
    try {
      const persistence = {
        memoryDbPath: join(dir, "memory.sqlite"),
        identityPath: join(dir, "identity.json"),
      };
      const tools = makeAllTools(undefined, persistence, mockControl, undefined, { mode: "server" });
      const count = Object.keys(tools).length;
      assert.equal(
        count,
        19, // P-28.5: +dispatch_google_login (was 18 at P-26/P-27)
        `T-CONTRACT.SERVER.TOOLS: expected 19 server tools (P-28.5); got ${count}. Keys: ${Object.keys(tools).sort().join(", ")}`,
      );
    } finally {
      cleanup();
    }
  });
});

describe("no-bash boundary (G-P26.27)", () => {
  it("T-CONTRACT.NO-BASH: zero child_process imports under src/tools/**, src/persistence/**, src/agent/** except hooks.ts", () => {
    // Given: the source tree rooted at project root
    // When:  grep -r --include='*.ts' 'child_process' across the three dirs, excluding hooks.ts
    // Then:  zero matching lines
    const projectRoot = resolve(process.cwd());
    // biome-ignore lint/correctness/noUnusedVariables: used at Step 5
    // Use extended regex to match only actual import/require statements — not comment text.
    // Matches: from "child_process", from 'node:child_process', require("child_process"), etc.
    // Does NOT match comment lines like "// No child_process import".
    const result = spawnSync(
      "grep",
      [
        "-rE",
        "--include=*.ts",
        "--exclude=hooks.ts",
        `(from|require)\\s*\\(?['"]((node:)?child_process)['"]`,
        "src/tools",
        "src/persistence",
        "src/agent",
      ],
      { cwd: projectRoot, encoding: "utf-8" },
    );
    // grep returns exit code 1 when no matches found — that means CLEAN
    // exit code 0 would mean matches found (violation)
    const output = result.stdout ?? "";
    assert.equal(
      output.trim(),
      "",
      `T-CONTRACT.NO-BASH: child_process found in tool/persistence/agent layers (Hard Rule 8 violation):\n${output}`,
    );
  });
});
