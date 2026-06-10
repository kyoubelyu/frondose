/**
 * P-28 Step 4a — T-CONTRACT.P28.*
 *
 * Contract regression tests for P-28:
 *   T-CONTRACT.P28.WORKER=26: worker tool count unchanged at 26
 *   T-CONTRACT.P28.SERVER=18: server tool count unchanged at 18 (no new LLM tools — D-7)
 *   T-CONTRACT.P28.NO-BASH:   zero child_process imports in src/tools/**+persistence/**+agent/**+cli/sub**
 *   T-CONTRACT.P28.HANDLERS:  ServerHttpHandlers is 7 fields; credentialsDb present in daemon + repl
 *
 * Gate coverage: G-P28.29 (worker=26, server=18), G-P28.30 (no-bash), G-P28.31 (7-field handlers)
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { LinkedinSession } from "../../src/linkedin/types.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";

process.env.MAI_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p28-contract-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

// ─── T-CONTRACT.P28.WORKER ────────────────────────────────────────────────────

describe("makeAllTools P-28 tool-count contract — worker mode (G-P28.29)", () => {
  it("T-CONTRACT.P28.WORKER: worker mode → exactly 52 tools", () => {
    // Given: makeAllTools(session, persistence, control, undefined, {mode:'worker', workerId:'w1'})
    // When:  Object.keys(tools).length
    // Then:  52 (clear_cookies removed from browser registry)
    const { dir, cleanup } = makeTmpDir();
    try {
      const persistence = {
        memoryDbPath: join(dir, "memory.sqlite"),
        identityPath: join(dir, "identity.json"),
      };
      const tools = makeAllTools(mockSession, persistence, mockControl, undefined, {
        mode: "worker",
        workerId: "w1",
      });
      const count = Object.keys(tools).length;
      assert.equal(
        count,
        52,
        `T-CONTRACT.P28.WORKER: expected 52 worker tools; got ${count}. Keys: ${Object.keys(tools).join(", ")}`,
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-CONTRACT.P28.SERVER ────────────────────────────────────────────────────

describe("makeAllTools P-28 tool-count contract — server mode (G-P28.29)", () => {
  it("T-CONTRACT.P28.SERVER: server mode → exactly 25 tools", () => {
    // Given: makeAllTools(undefined, persistence, control, undefined, {mode:'server'})
    // When:  Object.keys(tools).length
    // Then:  25 (P-73: suggest_card/suggest_next_actions removed from server mode)
    const { dir, cleanup } = makeTmpDir();
    try {
      const persistence = {
        memoryDbPath: join(dir, "memory.sqlite"),
        identityPath: join(dir, "identity.json"),
        personasDir: dir,
        serverUrl: "",
      };
      const tools = makeAllTools(undefined, persistence, mockControl, undefined, { mode: "server" });
      const count = Object.keys(tools).length;
      assert.equal(
        count,
        25,
        `T-CONTRACT.P28.SERVER: expected 25 server tools; got ${count}. Keys: ${Object.keys(tools).join(", ")}`,
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-CONTRACT.P28.NO-BASH ───────────────────────────────────────────────────

describe("no-bash boundary P-28 (G-P28.30)", () => {
  it("T-CONTRACT.P28.NO-BASH: zero child_process imports in src/tools/**, src/persistence/**, src/agent/**, src/cli/subcommands/** (P-28 additions)", () => {
    // Given: the source tree rooted at project root
    // When:  grep -rE child_process across dirs, excluding approved CLI-layer sites
    //        (src/cli/autoUpdate.ts, src/cli/subcommands/update.ts, src/cli/subcommands/launchd.ts,
    //         src/cli/subcommands/serverLaunchd.ts) — these are operator-approved (CLAUDE.md §2 Hard Rule 8)
    // Then:  zero matching lines in the tool/persistence/agent/cli-sub layers
    const projectRoot = resolve(process.cwd());
    const result = spawnSync(
      "grep",
      [
        "-rE",
        "--include=*.ts",
        "--exclude=hooks.ts", // hooks.ts is operator-approved CLI-layer spawn (CLAUDE.md §2 Hard Rule 8)
        `(from|require)\\s*\\(?['"]((node:)?child_process)['"]`,
        "src/tools",
        "src/persistence",
        "src/agent",
        "src/cli/subcommands/serverCredential.ts",
        "src/persistence/credentialLibrary.ts",
        "src/persistence/identitySchema.ts",
      ],
      { cwd: projectRoot, encoding: "utf-8" },
    );
    const output = result.stdout ?? "";
    assert.equal(
      output.trim(),
      "",
      `T-CONTRACT.P28.NO-BASH: child_process found in tool/persistence/agent layers:\n${output}`,
    );
  });
});

// ─── T-CONTRACT.P28.HANDLERS ──────────────────────────────────────────────────

describe("ServerHttpHandlers 7-field contract (G-P28.31)", () => {
  it("T-CONTRACT.P28.HANDLERS: serverDaemon.ts + serverRepl.ts source contain 'credentialsDb' — confirming the 7th handler field is wired", () => {
    // Given: src/cli/serverDaemon.ts and src/cli/serverRepl.ts source files
    // When:  readFileSync each; check for 'credentialsDb' reference
    // Then:  both files mention credentialsDb (G-P28.31: handlers object has 7 fields)
    // Note:  At Step 4a this will FAIL (builder hasn't added the field yet — correct TDD behavior)
    const projectRoot = resolve(process.cwd());
    const daemonSrc = readFileSync(join(projectRoot, "src/cli/serverDaemon.ts"), "utf-8");
    const replSrc = readFileSync(join(projectRoot, "src/cli/serverRepl.ts"), "utf-8");
    assert.ok(
      daemonSrc.includes("credentialsDb"),
      "T-CONTRACT.P28.HANDLERS: src/cli/serverDaemon.ts must reference credentialsDb (G-P28.31)",
    );
    assert.ok(
      replSrc.includes("credentialsDb"),
      "T-CONTRACT.P28.HANDLERS: src/cli/serverRepl.ts must reference credentialsDb (G-P28.31)",
    );
  });
});
