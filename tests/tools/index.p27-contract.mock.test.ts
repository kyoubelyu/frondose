/**
 * P-27 Step 5 — T-CONTRACT.P27.*
 *
 * Contract regression tests for P-27:
 *   T-CONTRACT.P27.WORKER=26: worker tool count unchanged at 26
 *   T-CONTRACT.P27.SERVER=18: server tool count increases 15→18 (+ provision_worker, revoke_worker, list_personas)
 *   T-CONTRACT.P27.NO-BASH:   no child_process imports in tool/persistence/agent layers
 *
 * Gate coverage: G-P27.23 (worker=26), G-P27.24 (server=18), G-P27.25 (no-bash)
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { LinkedinSession } from "../../src/linkedin/types.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";
import { cleanupTmpDir } from "../_helpers/tmp";

process.env.FRONDOSE_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p27-contract-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
}

/** Minimal LinkedinSession mock — only satisfies the interface; never boots Chrome. */
const mockSession: LinkedinSession = {
  inputMode: "cdp" as const,
  getOrInitClient: async () => ({ ok: false as const, error: "chrome_unavailable" as const, message: "mock" }),
  getClient: () => undefined,
  heartbeat: async () => true,
  setLastContext: () => {},
  getLastContext: () => undefined,
};

const mockControl: ControlSignals = { requestStop: () => {} };

// ─── T-CONTRACT.P27.WORKER ────────────────────────────────────────────────────

describe("makeAllTools P-27 tool-count contract — worker mode (G-P27.23)", () => {
  it("T-CONTRACT.P27.WORKER: worker mode → exactly 53 tools", () => {
    // Given: makeAllTools(session, persistence, control, undefined, {mode:'worker'})
    // When:  Object.keys(tools).length
    // Then:  53 (P-REBASE-TOOL-COUNT: stop_auto added at P-AUTO-ISOLATE)
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
        53,
        `T-CONTRACT.P27.WORKER: expected 53 worker tools; got ${count}. Keys: ${Object.keys(tools).join(", ")}`,
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-CONTRACT.P27.SERVER ───────────────────────────────────────────────────

describe("makeAllTools P-27 tool-count contract — server mode (G-P27.24)", () => {
  it("T-CONTRACT.P27.SERVER: server mode → exactly 26 tools", () => {
    // Given: makeAllTools(undefined, persistence {+invitesDbPath +personasDir +serverUrl}, control, undefined, {mode:'server'})
    //        invitesDbPath omitted → invitesDb=null; provision_worker still registers with null DB
    // When:  Object.keys(tools).length
    // Then:  26 (P-73: suggest_card/suggest_next_actions removed from server mode; P-REBASE-TOOL-COUNT: stop_auto added at P-AUTO-ISOLATE)
    const { dir, cleanup } = makeTmpDir();
    try {
      const persistence = {
        memoryDbPath: join(dir, "memory.sqlite"),
        identityPath: join(dir, "identity.json"),
        // P-27 fields — can omit; tools still register with null DBs
        personasDir: dir,
        serverUrl: "",
      };
      const tools = makeAllTools(undefined, persistence, mockControl, undefined, { mode: "server" });
      const count = Object.keys(tools).length;
      assert.equal(
        count,
        26,
        `T-CONTRACT.P27.SERVER: expected 26 server tools; got ${count}. Keys: ${Object.keys(tools).join(", ")}`,
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-CONTRACT.P27.TOOL-NAMES ───────────────────────────────────────────────

describe("makeAllTools P-27 new server tool names present (G-P27.24)", () => {
  it("T-CONTRACT.P27.TOOL-NAMES: server mode tool set contains 'provision_worker', 'revoke_worker', 'list_personas'", () => {
    // Given: makeAllTools(undefined, persistence, control, undefined, {mode:'server'})
    // When:  Object.keys(tools) includes all three new P-27 tool names
    // Then:  all three present; no name typos
    const { dir, cleanup } = makeTmpDir();
    try {
      const persistence = {
        memoryDbPath: join(dir, "memory.sqlite"),
        identityPath: join(dir, "identity.json"),
        personasDir: dir,
        serverUrl: "",
      };
      const tools = makeAllTools(undefined, persistence, mockControl, undefined, { mode: "server" });
      const keys = Object.keys(tools);
      assert.ok(
        keys.includes("provision_worker"),
        `'provision_worker' must be in server tools; got: ${keys.join(", ")}`,
      );
      assert.ok(keys.includes("revoke_worker"), `'revoke_worker' must be in server tools; got: ${keys.join(", ")}`);
      assert.ok(keys.includes("list_personas"), `'list_personas' must be in server tools; got: ${keys.join(", ")}`);
    } finally {
      cleanup();
    }
  });
});

// ─── T-CONTRACT.P27.NO-BASH ──────────────────────────────────────────────────

describe("no-bash boundary (G-P27.25)", () => {
  it("T-CONTRACT.P27.NO-BASH: zero child_process imports under src/tools/**, src/persistence/**, src/agent/**", () => {
    // Given: the source tree rooted at project root
    // When:  grep -rE child_process across the three dirs, excluding hooks.ts
    // Then:  zero matching lines (Hard Rule 8 holds for P-27 additions)
    const projectRoot = resolve(process.cwd());
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
      `T-CONTRACT.P27.NO-BASH: child_process found in tool/persistence/agent layers (Hard Rule 8 violation):\n${output}`,
    );
  });
});
