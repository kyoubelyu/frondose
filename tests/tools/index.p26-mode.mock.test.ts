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
  it("T-CONTRACT.WORKER.TOOLS: worker mode with session + persistence + control → exactly 26 tools", () => {
    // Given: makeAllTools(session, persistence, control, undefined, {mode:"worker"})
    // When:  Object.keys(tools).length computed
    // Then:  26
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
        26,
        `T-CONTRACT.WORKER.TOOLS: expected 26 worker tools; got ${count}. Keys: ${Object.keys(tools).sort().join(", ")}`,
      );
    } finally {
      cleanup();
    }
  });

  it("T-CONTRACT.SERVER.TOOLS: server mode with persistence + control (no session) → exactly 18 tools (P-27 updated: +provision_worker +revoke_worker +list_personas)", () => {
    // Given: makeAllTools(undefined, persistence, control, undefined, {mode:"server"})
    // When:  Object.keys(tools).length computed
    // Then:  18 (was 15 at P-26; P-27 adds provision_worker + revoke_worker + list_personas)
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
        18,
        `T-CONTRACT.SERVER.TOOLS: expected 18 server tools (P-27); got ${count}. Keys: ${Object.keys(tools).sort().join(", ")}`,
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
