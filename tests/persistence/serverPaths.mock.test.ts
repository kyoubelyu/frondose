/**
 * P-25 Step 4a scaffold — T-SRV.PATHS.*
 *
 * Tests for server path constant functions.
 * (src/persistence/serverPaths.ts — NEW at builder Step 4b.)
 *
 * Gate coverage: G-P25.1 (server uses server-distinct directory tree)
 *
 * All assertion bodies are TODO. Builder must make scaffolds reach assert.fail at Step 4b.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  SERVER_AUDIT_PATH,
  SERVER_CONFIG_PATH,
  SERVER_IDENTITY_PATH,
  SERVER_LOGS_DIR,
  SERVER_MEMORY_DB_PATH,
  SERVER_PID_PATH,
  SERVER_ROOT,
  SERVER_SECRETS_PATH,
  SERVER_SESSIONS_ROOT,
  SERVER_TELEGRAM_CONFIG_PATH,
} from "../../src/persistence/serverPaths.js";

// ─── T-SRV.PATHS ──────────────────────────────────────────────────────────────

describe("serverPaths constants (G-P25.1)", () => {
  it("T-SRV.PATHS.1: SERVER_ROOT() returns ~/.mai/server", () => {
    // Given: default HOME
    // When:  SERVER_ROOT() called
    // Then:  returns join(homedir(), ".mai", "server")
    assert.equal(SERVER_ROOT(), join(homedir(), ".mai", "server"));
  });

  it("T-SRV.PATHS.2: all sub-paths are under SERVER_ROOT() and have correct file names", () => {
    // Given: default HOME
    // When:  each path constant function called
    // Then:  each path starts with SERVER_ROOT() and ends with expected filename/subpath
    const root = SERVER_ROOT();
    assert.ok(SERVER_MEMORY_DB_PATH().startsWith(root), "memory.sqlite under root");
    assert.ok(SERVER_MEMORY_DB_PATH().endsWith("memory.sqlite"), "memory.sqlite name");
    assert.ok(SERVER_AUDIT_PATH().endsWith("audit.jsonl"), "audit.jsonl name");
    assert.ok(SERVER_SESSIONS_ROOT().endsWith("sessions"), "sessions dir");
    assert.ok(SERVER_PID_PATH().endsWith("server.pid"), "server.pid name");
    assert.ok(SERVER_TELEGRAM_CONFIG_PATH().endsWith("telegram.json"), "telegram.json name");
    assert.ok(SERVER_IDENTITY_PATH().endsWith("identity.json"), "identity.json name");
    assert.ok(SERVER_CONFIG_PATH().endsWith("config.json"), "config.json name");
    assert.ok(SERVER_SECRETS_PATH().endsWith("secrets.json"), "secrets.json name");
    assert.ok(SERVER_LOGS_DIR().endsWith("logs"), "logs dir");
  });

  it("T-SRV.PATHS.3: server paths are distinct from worker paths (no overlap with ~/.mai/agent/)", () => {
    // Given: default HOME
    // When:  SERVER_MEMORY_DB_PATH(), SERVER_IDENTITY_PATH(), SERVER_CONFIG_PATH() called
    // Then:  none contain "agent" path segment (they're under "server", not "agent")
    assert.ok(!SERVER_MEMORY_DB_PATH().includes("/agent/"), "memory DB not under agent/");
    assert.ok(!SERVER_IDENTITY_PATH().includes("/agent/"), "identity not under agent/");
    assert.ok(!SERVER_CONFIG_PATH().includes("/agent/"), "config not under agent/");
  });
});
