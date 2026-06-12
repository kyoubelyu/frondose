/**
 * P-25 Step 5 — T-MODE.WORKER.1, T-MODE.SERVER.1..2,
 *               T-CONTRACT.WORKER.TOOLS, T-CONTRACT.SERVER.TOOLS,
 *               T-CONTRACT.NO-BASH
 *
 * Tests for makeAllTools mode parameter + tool-count contracts.
 * Gate coverage: G-P25.2, G-P25.3, G-P25.18
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createLinkedinSession } from "../../src/linkedin/index.js";
import { makeAllTools } from "../../src/tools/index.js";

process.env.MAI_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): { memoryDbPath: string; identityPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p25-tools-"));
  return {
    memoryDbPath: join(dir, "memory.sqlite"),
    identityPath: join(dir, "identity.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const fakeControl = { requestStop: () => {}, auditPath: "/tmp/fake-audit.jsonl" };

// ─── T-MODE / T-CONTRACT ──────────────────────────────────────────────────────

describe("makeAllTools mode parameter (G-P25.2, G-P25.3)", () => {
  it("T-MODE.WORKER.1: makeAllTools with session + persistence + no mode returns 52 tools; no 'list_workers'", () => {
    // Given: full worker startup path — session present, persistence present, mode defaults to "worker"
    // When:  makeAllTools(session, persistence, control, undefined) — no 5th opts arg
    // Then:  returns ToolSet with 52 keys (clear_cookies removed from browser registry)
    //        does NOT include "list_workers"
    const { cleanup, ...paths } = makeTmpDir();
    try {
      const session = createLinkedinSession({ port: 9999, profileDir: "/tmp/fake-profile" });
      const tools = makeAllTools(session, paths, fakeControl, undefined);
      const count = Object.keys(tools).length;
      assert.equal(count, 52, `worker mode must have 52 tools; got ${count}: ${Object.keys(tools).join(", ")}`);
      assert.ok(!("list_workers" in tools), "worker mode must NOT include 'list_workers'");
    } finally {
      cleanup();
    }
  });

  it("T-MODE.SERVER.1: makeAllTools(undefined, persistence, control, undefined, {mode:'server'}) returns 25 tools; includes echo, list_workers; does NOT include launch, inspect, qualify_profile", () => {
    // Given: makeAllTools called with mode='server' (5th opts arg)
    // When:  makeAllTools(undefined, persistence, control, undefined, {mode:"server"})
    // Then:  Object.keys result has length 25 (P-73: suggest_card/suggest_next_actions removed from server).
    //        includes "echo", "recall", "remember", "telegram_notify", "list_workers";
    //        does NOT include "launch", "inspect", "qualify_profile"
    const { cleanup, ...paths } = makeTmpDir();
    try {
      const tools = makeAllTools(undefined, paths, fakeControl, undefined, { mode: "server" });
      const count = Object.keys(tools).length;
      assert.equal(count, 25, `server mode must have 25 tools; got ${count}: ${Object.keys(tools).join(", ")}`);
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

  it("T-CONTRACT.WORKER.TOOLS: worker startup tool count is 52", () => {
    // Given: worker startup path — session present, persistence present, mode not set
    // When:  Object.keys(makeAllTools(session, persistence, control)).length checked
    // Then:  52 (clear_cookies removed from browser registry)
    const { cleanup, ...paths } = makeTmpDir();
    try {
      const session = createLinkedinSession({ port: 9999, profileDir: "/tmp/fake-profile" });
      const tools = makeAllTools(session, paths, fakeControl);
      const count = Object.keys(tools).length;
      assert.equal(count, 52, `worker tool count must be 52; got ${count}: ${Object.keys(tools).join(", ")}`);
    } finally {
      cleanup();
    }
  });

  it("T-CONTRACT.SERVER.TOOLS: server startup tool count is 25", () => {
    // Given: server startup path — no session, persistence present, mode='server'
    // When:  Object.keys(tools).length checked
    // Then:  25 (P-73: suggest_card/suggest_next_actions removed from server mode)
    const { cleanup, ...paths } = makeTmpDir();
    try {
      const tools = makeAllTools(undefined, paths, fakeControl, undefined, { mode: "server" });
      const count = Object.keys(tools).length;
      assert.equal(count, 25, `server tool count must be 25; got ${count}: ${Object.keys(tools).join(", ")}`);
    } finally {
      cleanup();
    }
  });

  it("T-CONTRACT.NO-BASH: zero child_process imports under src/tools/**, src/persistence/**, src/agent/**", () => {
    // Given: source tree at current HEAD
    // When:  grep -r 'child_process' under src/tools, src/persistence, src/agent
    // Then:  zero hits (Hard Rule 8 enforcement — G-P25.18)
    const projectRoot = new URL("../../../", import.meta.url).pathname;
    const result = execSync(
      "grep -r --include='*.ts' 'child_process' src/tools src/persistence src/agent 2>/dev/null || true",
      { cwd: projectRoot, encoding: "utf-8" },
    );
    assert.strictEqual(result.trim(), "", `child_process found in no-bash zones: ${result.trim()}`);
  });
});
