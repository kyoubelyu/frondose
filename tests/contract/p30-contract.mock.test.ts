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
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { LinkedinSession } from "../../src/linkedin/types.js";
import { configJsonSchemaV2 } from "../../src/persistence/config.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";
import { cleanupTmpDir } from "../_helpers/tmp";

process.env.FRONDOSE_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p30-contract-"));
  return { dir, cleanup: () => cleanupTmpDir(dir) };
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
  it("T-CONTRACT.TOOLS (single-mode): makeAllTools → exactly 51 tools", () => {
    // Given: makeAllTools(session, persistence, control) (single-mode App registry)
    // When:  Object.keys(tools).length
    // Then:  51 (P-OPEN-SOURCE-SPLIT: 54 − report_issue − query_lead_globally − publish_event)

    const { dir, cleanup } = makeTmpDir();
    try {
      const persistence = {
        memoryDbPath: join(dir, "memory.sqlite"),
        configPath: join(dir, "config.json"),
      };
      const tools = makeAllTools(mockSession, persistence, mockControl);
      const count = Object.keys(tools).length;
      assert.equal(
        count,
        51,
        `T-CONTRACT.TOOLS: expected 51 tools; got ${count}. Keys: ${Object.keys(tools).sort().join(", ")}`,
      );
    } finally {
      cleanup();
    }
  });

  // (T-CONTRACT.TOOLS (server) — retired with the fleet server mode.)
});

// ─── T-CONTRACT.DEPS ─────────────────────────────────────────────────────────

describe("package.json dependency check — P-30 new deps (G-P30.1)", () => {
  it("T-CONTRACT.DEPS: ssh2, ws, react, react-dom, xterm, tailwind and noVNC have NO direct/root ownership (P-OPEN-SOURCE-SPLIT §15.2)", () => {
    // Given: package.json at project root
    // When:  parse JSON; check dependencies + devDependencies
    // Then:  the retired fleet packages are absent from both; ws may remain only
    //        as a transitive dependency owned by Pi/MCP/CDP (verified in the lockfile)
    const projectRoot = resolve(process.cwd());
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const deps = pkg.dependencies ?? {};
    const devDeps = pkg.devDependencies ?? {};
    for (const retired of [
      "ssh2",
      "ws",
      "react",
      "react-dom",
      "@xterm/xterm",
      "@xterm/addon-fit",
      "@tailwindcss/cli",
      "@novnc/novnc",
    ]) {
      assert.ok(
        !(retired in deps),
        `T-CONTRACT.DEPS: '${retired}' must NOT be a direct dependency (retired fleet package)`,
      );
      assert.ok(
        !(retired in devDeps),
        `T-CONTRACT.DEPS: '${retired}' must NOT be a devDependency (retired fleet package)`,
      );
    }
  });
});

// ─── T-CONTRACT.CONFIG ────────────────────────────────────────────────────────

describe("config.server P-30 SSH defaults (G-P30.2)", () => {
  it("T-CONTRACT.CONFIG: configJsonSchemaV2.parse({schema_version:2}) → server.ssh_user===null + server.ssh_port===22", () => {
    // Given: a minimal v2 config JSON with no ssh_user / ssh_port override
    // When:  configJsonSchemaV2.parse({schema_version: 2})
    // Then:  server.ssh_user defaults to null; server.ssh_port defaults to 22

    const cfg = configJsonSchemaV2.parse({ schema_version: 2 });
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
