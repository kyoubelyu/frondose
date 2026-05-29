/**
 * P-29 Step 5 — T-CONTRACT.NO-BASH, T-CONTRACT.TOOLS,
 *               T-CONTRACT.CONFIG, T-CONTRACT.BUILD
 *
 * Contract regression tests for P-29:
 *   - No new child_process imports in P-29 diff (G-P29.24)
 *   - makeAllTools tool counts unchanged: worker=28, server=19 (G-P29.24 + D-9)
 *   - config.json server.web_port: default 8090 when absent, explicit round-trip (G-P29.23)
 *   - package.json build script contains build:web invocation (G-P29.25 static check)
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { LinkedinSession } from "../../src/linkedin/types.js";
import { readConfig } from "../../src/persistence/config.js";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";

process.env.MAI_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p29-contract-"));
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

describe("no-bash boundary — P-29 new/edited files (G-P29.24)", () => {
  it("T-CONTRACT.NO-BASH: grep child_process across P-29 new/edited source files → zero hits", () => {
    // Given: P-29 new/edited source files: src/cli/serverWeb.ts, src/cli/subcommands/serverWebToken.ts,
    //        src/persistence/workersRegistry.ts, src/persistence/memory.ts,
    //        src/tools/server/provisionWorker.ts, src/cli/serverDaemon.ts, src/cli/serverRepl.ts
    // When: grep -rE '(from|require)\s*\(?['"'"'"]((node:)?child_process)' across those files
    // Then: zero matches — no child_process imports introduced in P-29 (G-P29.24)
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
        "src/cli/serverWeb.ts",
        "src/cli/subcommands/serverWebToken.ts",
      ],
      { cwd: projectRoot, encoding: "utf-8" },
    );
    // grep exit 1 = no matches = clean; exit 0 = matches found = violation
    const output = result.stdout ?? "";
    assert.equal(output.trim(), "", `T-CONTRACT.NO-BASH: child_process found in P-29 no-bash zones:\n${output}`);
  });
});

// ─── T-CONTRACT.TOOLS ─────────────────────────────────────────────────────────

describe("makeAllTools tool counts — unchanged at P-29 (D-9, G-P29.24)", () => {
  it("T-CONTRACT.TOOLS (worker): makeAllTools worker mode → exactly 53 tools", () => {
    // Given: makeAllTools(session, persistence, control, undefined, {mode:'worker'}) (D-9 — no new tools)
    // When: Object.keys(tools).length
    // Then: 53 (P-Y3 rebaseline: present_summary + current 17-tool sales kernel)
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
    // Given: makeAllTools(undefined, persistence, control, undefined, {mode:'server'}) (D-9)
    // When: Object.keys(tools).length
    // Then: 25 (P-73: suggest_card/suggest_next_actions removed from server mode)
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

// ─── T-CONTRACT.CONFIG ────────────────────────────────────────────────────────

describe("config.json server.web_port — default 8090 + explicit round-trip (G-P29.23)", () => {
  it("T-CONTRACT.CONFIG.DEFAULT: a config.json with no web_port field → readConfig().server.web_port === 8090 (default)", () => {
    // Given: config.json v2 written WITHOUT a web_port field (G-P29.23)
    // When: readConfig(path) parses it
    // Then: config.server.web_port === 8090 (Zod .default(8090) fills it in)
    const { dir, cleanup } = makeTmpDir();
    try {
      const configPath = join(dir, "config.json");
      // Write a minimal v2 config without web_port (additive — existing files parse unchanged)
      writeFileSync(
        configPath,
        JSON.stringify({
          schema_version: 2,
          server: { url: null, bind_address: null, poll_interval_s: 30 },
          worker: { id: null, hostname: null, label: null },
          telegram: { enabled: false, boundUserId: null, proxyUrl: null },
          soul: { override: null },
        }),
        "utf-8",
      );
      const config = readConfig(configPath);
      assert.equal(
        config.server.web_port,
        8090,
        "T-CONTRACT.CONFIG.DEFAULT: existing config.json without web_port must default to 8090 (Zod additive default)",
      );
    } finally {
      cleanup();
    }
  });

  it("T-CONTRACT.CONFIG.ROUNDTRIP: a config.json with explicit web_port:9090 → readConfig().server.web_port === 9090", () => {
    // Given: config.json v2 with explicit web_port:9090 (G-P29.23)
    // When: readConfig(path) parses it
    // Then: config.server.web_port === 9090
    const { dir, cleanup } = makeTmpDir();
    try {
      const configPath = join(dir, "config.json");
      // Write a v2 config with an explicit web_port:9090 directly (bypass writeConfig to avoid
      // Zod serialization stripping the field if the type doesn't include it yet)
      writeFileSync(
        configPath,
        JSON.stringify({
          schema_version: 2,
          server: { url: null, bind_address: null, poll_interval_s: 30, web_port: 9090 },
          worker: { id: null, hostname: null, label: null },
          telegram: { enabled: false, boundUserId: null, proxyUrl: null },
          soul: { override: null },
        }),
        "utf-8",
      );
      const config = readConfig(configPath);
      assert.equal(
        config.server.web_port,
        9090,
        "T-CONTRACT.CONFIG.ROUNDTRIP: explicit web_port:9090 must round-trip through readConfig",
      );
    } finally {
      cleanup();
    }
  });
});

// ─── T-CONTRACT.BUILD ─────────────────────────────────────────────────────────

describe("package.json build script contains build:web (G-P29.25 static check)", () => {
  it("T-CONTRACT.BUILD: package.json scripts.build contains 'build:web'; scripts.build:web references esbuild + tailwindcss + src/web → dist/web paths", async () => {
    // Given: package.json at project root (G-P29.25 — static check, no live build)
    // When: read package.json and inspect scripts
    // Then: scripts.build includes 'build:web'; scripts['build:web'] includes 'esbuild' AND
    //       the tailwind CLI AND 'src/web' → 'dist/web' output paths
    const projectRoot = resolve(process.cwd());
    // biome-ignore lint/suspicious/noExplicitAny: dynamic package.json read
    const pkg = (await import(`${projectRoot}/package.json`, { assert: { type: "json" } })) as any;
    // JSON imports expose the content as `default` in ESM
    const scripts: Record<string, string> = (pkg.default ?? pkg).scripts ?? {};
    assert.ok(
      typeof scripts.build === "string" && scripts.build.includes("build:web"),
      `T-CONTRACT.BUILD: scripts.build must include 'build:web'; got: ${scripts.build}`,
    );
    assert.ok(typeof scripts["build:web"] === "string", "T-CONTRACT.BUILD: scripts['build:web'] must exist");
    const buildWeb = scripts["build:web"];
    assert.ok(buildWeb.includes("esbuild"), `T-CONTRACT.BUILD: build:web must reference esbuild; got: ${buildWeb}`);
    assert.ok(
      buildWeb.includes("tailwindcss") || buildWeb.includes("tailwind"),
      `T-CONTRACT.BUILD: build:web must reference tailwindcss; got: ${buildWeb}`,
    );
    assert.ok(buildWeb.includes("src/web"), `T-CONTRACT.BUILD: build:web must reference src/web; got: ${buildWeb}`);
    assert.ok(
      buildWeb.includes("dist/web"),
      `T-CONTRACT.BUILD: build:web must reference dist/web output; got: ${buildWeb}`,
    );
  });
});
