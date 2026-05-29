/**
 * P-30 Step 4a — T-CONTRACT.NO-BASH, T-CONTRACT.TOOLS, T-CONTRACT.DEPS, T-CONTRACT.LOG
 *
 * Contract regression tests for P-30:
 *   - No new child_process imports in P-30 diff (G-P30.17)
 *   - makeAllTools tool counts unchanged: worker=28, server=19 (G-P30.17, D-11)
 *   - package.json: ssh2+ws under dependencies; 4 type/xterm packages under devDependencies (G-P30.1)
 *   - No P-30 source line logs req.url or req.headers.authorization (G-P30.20, D-7)
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { LinkedinSession } from "../../src/linkedin/types.js";
import { configJsonSchema } from "../../src/persistence/config.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";

process.env.MAI_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p30-contract-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const mockSession: LinkedinSession = {
  inputMode: "cdp" as const,
  getOrInitClient: async () => ({ ok: false as const, error: "chrome_unavailable" as const, message: "mock" }),
  getClient: () => undefined,
  heartbeat: async () => true,
  setLastContext: () => {},
  getLastContext: () => undefined,
};

const mockControl: ControlSignals = { requestStop: () => {} };

// ─── T-CONTRACT.NO-BASH ───────────────────────────────────────────────────────

describe("no-bash boundary — P-30 new/edited files (G-P30.17)", () => {
  it("T-CONTRACT.NO-BASH: grep child_process across P-30 new/edited src files → zero hits", () => {
    // Given: P-30 new/edited source files: src/cli/serverSsh.ts, src/cli/serverVnc.ts,
    //        src/cli/serverWeb.ts, src/persistence/workerNodeConfig.ts,
    //        src/cli/serverDaemon.ts, src/cli/serverRepl.ts, src/persistence/config.ts
    // When:  grep for child_process imports across those files
    // Then:  zero matches — P-30 introduces NO child_process (ssh2 + ws are pure-JS libs)

    const projectRoot = resolve(process.cwd());
    const filesToCheck = [
      "src/cli/serverSsh.ts",
      "src/cli/serverVnc.ts",
      "src/cli/serverWeb.ts",
      "src/persistence/workerNodeConfig.ts",
      "src/cli/serverDaemon.ts",
      "src/cli/serverRepl.ts",
      "src/persistence/config.ts",
      "src/persistence/serverPaths.ts",
    ];

    const result = spawnSync(
      "grep",
      ["-lE", `(from|require)\\s*\\(?['"]((node:)?child_process)['"]`, ...filesToCheck],
      { cwd: projectRoot, encoding: "utf-8" },
    );
    // grep exit 1 = no matches (clean); exit 0 = matches found (violation)
    const output = (result.stdout ?? "").trim();
    assert.equal(output, "", `T-CONTRACT.NO-BASH: child_process found in P-30 files:\n${output}`);
  });
});

// ─── T-CONTRACT.TOOLS ─────────────────────────────────────────────────────────

describe("makeAllTools tool counts — unchanged at P-30 (D-11, G-P30.17)", () => {
  it("T-CONTRACT.TOOLS (worker): makeAllTools worker mode → exactly 53 tools", () => {
    // Given: makeAllTools(session, persistence, control, undefined, {mode:'worker'})
    // When:  Object.keys(tools).length
    // Then:  53 (P-Y3 rebaseline: present_summary + current 17-tool sales kernel)

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
        `T-CONTRACT.TOOLS worker: expected 53 tools; got ${count}. Keys: ${Object.keys(tools).sort().join(", ")}`,
      );
    } finally {
      cleanup();
    }
  });

  it("T-CONTRACT.TOOLS (server): makeAllTools server mode → exactly 25 tools", () => {
    // Given: makeAllTools(undefined, persistence, control, undefined, {mode:'server'})
    // When:  Object.keys(tools).length
    // Then:  25 (P-73: suggest_card/suggest_next_actions removed from server mode)

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
        25,
        `T-CONTRACT.TOOLS server: expected 25 tools; got ${count}. Keys: ${Object.keys(tools).sort().join(", ")}`,
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-CONTRACT.DEPS ─────────────────────────────────────────────────────────

describe("package.json dependency check — P-30 new deps (G-P30.1)", () => {
  it("T-CONTRACT.DEPS: ssh2 + ws are in dependencies; @types/ssh2, @types/ws, @xterm/xterm, @xterm/addon-fit are in devDependencies", () => {
    // Given: package.json at project root
    // When:  parse JSON; check dependencies + devDependencies
    // Then:  ssh2 and ws under dependencies; the 4 type/xterm packages under devDependencies

    const projectRoot = resolve(process.cwd());
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const deps = pkg.dependencies ?? {};
    const devDeps = pkg.devDependencies ?? {};

    assert.ok(
      "ssh2" in deps,
      `T-CONTRACT.DEPS: 'ssh2' must be in dependencies; found: ${Object.keys(deps).join(", ")}`,
    );
    assert.ok("ws" in deps, `T-CONTRACT.DEPS: 'ws' must be in dependencies; found: ${Object.keys(deps).join(", ")}`);
    assert.ok("@types/ssh2" in devDeps, `T-CONTRACT.DEPS: '@types/ssh2' must be in devDependencies`);
    assert.ok("@types/ws" in devDeps, `T-CONTRACT.DEPS: '@types/ws' must be in devDependencies`);
    assert.ok("@xterm/xterm" in devDeps, `T-CONTRACT.DEPS: '@xterm/xterm' must be in devDependencies`);
    assert.ok("@xterm/addon-fit" in devDeps, `T-CONTRACT.DEPS: '@xterm/addon-fit' must be in devDependencies`);
  });
});

// ─── T-CONTRACT.CONFIG ────────────────────────────────────────────────────────

describe("config.server P-30 SSH defaults (G-P30.2)", () => {
  it("T-CONTRACT.CONFIG: configJsonSchemaV2.parse({schema_version:2}) → server.ssh_user===null + server.ssh_port===22", () => {
    // Given: a minimal v2 config JSON with no ssh_user / ssh_port override
    // When:  configJsonSchemaV2.parse({schema_version: 2})
    // Then:  server.ssh_user defaults to null; server.ssh_port defaults to 22

    const cfg = configJsonSchema.parse({ schema_version: 2 });
    assert.equal(
      cfg.server.ssh_user,
      null,
      "T-CONTRACT.CONFIG: server.ssh_user must default to null (OS username fallback)",
    );
    assert.equal(cfg.server.ssh_port, 22, "T-CONTRACT.CONFIG: server.ssh_port must default to 22");
  });
});

// ─── T-CONTRACT.LOG ──────────────────────────────────────────────────────────

describe("credential log-safety — P-30 WS source (G-P30.20, D-7)", () => {
  it("T-CONTRACT.LOG: no P-30 source line logs req.url or req.headers.authorization (token never emitted to logs)", () => {
    // Given: P-30 source files that handle WS upgrade: src/cli/serverWeb.ts, src/cli/serverSsh.ts, src/cli/serverVnc.ts
    // When:  grep for req.url or req.headers.authorization in log-statement patterns
    // Then:  zero matches — WS auth credentials are never logged (D-7 defence-in-depth)

    const projectRoot = resolve(process.cwd());
    const filesToCheck = ["src/cli/serverWeb.ts", "src/cli/serverSsh.ts", "src/cli/serverVnc.ts"];

    // Check for req.url or req.headers.authorization in log contexts
    const result = spawnSync(
      "grep",
      ["-nE", "(log|write|console\\.(log|warn|error|info)).*req\\.(url|headers)", ...filesToCheck],
      { cwd: projectRoot, encoding: "utf-8" },
    );
    const output = (result.stdout ?? "").trim();

    // Also check for direct authorization header logging
    const result2 = spawnSync("grep", ["-nE", "authorization", ...filesToCheck], {
      cwd: projectRoot,
      encoding: "utf-8",
    });
    // The only authorization reference should be the checkBasicAuth function call — NOT in a log line
    const authOutput = (result2.stdout ?? "").trim();
    const loggedAuthLines = authOutput
      .split("\n")
      .filter((l) => l.includes("log") || l.includes("write") || l.includes("console"));

    assert.equal(output, "", `T-CONTRACT.LOG: found log lines emitting req.url/headers in P-30 WS files:\n${output}`);
    assert.equal(
      loggedAuthLines.length,
      0,
      `T-CONTRACT.LOG: found authorization logged in P-30 WS files:\n${loggedAuthLines.join("\n")}`,
    );
  });
});
