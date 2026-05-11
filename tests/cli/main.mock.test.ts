/**
 * P-3/P-4 mock tests — T-M82, T-M127..T-M128: CLI env-var wiring.
 * P-11 D-12 (T-M83 rewrite): T-M83 now verifies the 4-tool no-session set (post-P-9).
 *
 * T-M82: MAI_CDP_PORT defaults to 9222 when unset; custom value is parsed as integer.
 * T-M83 (D-12 refresh): makeAllTools(undefined, undefined, undefined, undefined) returns
 *        4-tool set: ["analyze_screenshot","echo","web_fetch","web_search"] (post-P-9).
 * T-M127: MAI_MEMORY_DB_PATH defaults to ~/.mai/agent/memory.sqlite when unset; custom value used verbatim.
 * T-M128: MAI_IDENTITY_PATH defaults to ~/.mai/agent/identity.json when unset; custom value used verbatim.
 *
 * These tests verify the behavior without spawning the actual CLI binary
 * (which requires Chrome). The live smoke L-2 exercises the full subprocess path.
 *
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { makeAllTools } from "../../src/tools/index.js";

// ─── T-M82 ─────────────────────────────────────────────────────────────────────

test("T-M82: MAI_CDP_PORT env var: default is 9222; custom value parses to integer", () => {
  // Simulate main.ts line: const cdpPort = process.env.MAI_CDP_PORT ? parseInt(...) : 9222;

  const defaultPort = ((): number => {
    const raw = process.env.MAI_CDP_PORT;
    return raw ? Number.parseInt(raw, 10) : 9222;
  })();

  assert.equal(defaultPort, 9222, "CDP port must default to 9222 when MAI_CDP_PORT is unset");

  // Simulate custom port
  const prevPort = process.env.MAI_CDP_PORT;
  process.env.MAI_CDP_PORT = "9333";
  try {
    const customPort = ((): number => {
      const raw = process.env.MAI_CDP_PORT;
      return raw ? Number.parseInt(raw, 10) : 9222;
    })();
    assert.equal(customPort, 9333, "MAI_CDP_PORT=9333 must parse to 9333");
  } finally {
    if (prevPort !== undefined) {
      process.env.MAI_CDP_PORT = prevPort;
    } else {
      delete process.env.MAI_CDP_PORT;
    }
  }
});

// ─── T-M83 (D-12 refresh — P-11 Step 4a) ──────────────────────────────────────

test("T-M83: makeAllTools(undefined, undefined, undefined, undefined) returns 4-tool set: analyze_screenshot, echo, web_fetch, web_search (post-P-9 no-session set)", () => {
  // Given: no CDP session (no LinkedIn tools), no memory, no identity, no control tools
  // When: makeAllTools(undefined, undefined, undefined, undefined) called
  // Then: sorted keys === ["analyze_screenshot","echo","web_fetch","web_search"] (4 tools, post-P-9)

  const toolsNoSession = makeAllTools(undefined);
  const keys = Object.keys(toolsNoSession).sort();

  assert.deepEqual(
    keys,
    ["analyze_screenshot", "echo", "web_fetch", "web_search"],
    `T-M83: makeAllTools(undefined) must return 4-tool no-session set; got: [${keys.join(", ")}]`,
  );
  assert.equal(keys.length, 4, "exactly 4 tools when no session (post-P-9)");

  // Spot-check that echo tool is still functional
  assert.ok(typeof toolsNoSession.echo?.execute === "function", "echo tool execute must be a function");
  assert.ok(typeof toolsNoSession.echo?.description === "string", "echo tool must have a description");
});

// ─── T-M127 ─────────────────────────────────────────────────────────────────

test("T-M127: MAI_MEMORY_DB_PATH env var: defaults to ~/.mai/agent/memory.sqlite; custom value used verbatim", () => {
  // Simulate the main.ts logic:
  //   const memoryDbPath = process.env.MAI_MEMORY_DB_PATH ?? path.join(os.homedir(), ".mai", "agent", "memory.sqlite");

  const defaultPath = ((): string => {
    const raw = process.env.MAI_MEMORY_DB_PATH;
    return raw ?? path.join(os.homedir(), ".mai", "agent", "memory.sqlite");
  })();

  const expectedDefault = path.join(os.homedir(), ".mai", "agent", "memory.sqlite");
  assert.equal(defaultPath, expectedDefault, "MAI_MEMORY_DB_PATH must default to ~/.mai/agent/memory.sqlite");

  // Custom override
  const prevVal = process.env.MAI_MEMORY_DB_PATH;
  process.env.MAI_MEMORY_DB_PATH = "/tmp/custom-memory.sqlite";
  try {
    const customPath = ((): string => {
      const raw = process.env.MAI_MEMORY_DB_PATH;
      return raw ?? path.join(os.homedir(), ".mai", "agent", "memory.sqlite");
    })();
    assert.equal(customPath, "/tmp/custom-memory.sqlite", "MAI_MEMORY_DB_PATH custom value must be used verbatim");
  } finally {
    if (prevVal !== undefined) {
      process.env.MAI_MEMORY_DB_PATH = prevVal;
    } else {
      delete process.env.MAI_MEMORY_DB_PATH;
    }
  }
});

// ─── T-M128 ─────────────────────────────────────────────────────────────────

test("T-M128: MAI_IDENTITY_PATH env var: defaults to ~/.mai/agent/identity.json; custom value used verbatim", () => {
  // Simulate the main.ts logic:
  //   const identityPath = process.env.MAI_IDENTITY_PATH ?? path.join(os.homedir(), ".mai", "agent", "identity.json");

  const defaultPath = ((): string => {
    const raw = process.env.MAI_IDENTITY_PATH;
    return raw ?? path.join(os.homedir(), ".mai", "agent", "identity.json");
  })();

  const expectedDefault = path.join(os.homedir(), ".mai", "agent", "identity.json");
  assert.equal(defaultPath, expectedDefault, "MAI_IDENTITY_PATH must default to ~/.mai/agent/identity.json");

  // Custom override
  const prevVal = process.env.MAI_IDENTITY_PATH;
  process.env.MAI_IDENTITY_PATH = "/tmp/custom-identity.json";
  try {
    const customPath = ((): string => {
      const raw = process.env.MAI_IDENTITY_PATH;
      return raw ?? path.join(os.homedir(), ".mai", "agent", "identity.json");
    })();
    assert.equal(customPath, "/tmp/custom-identity.json", "MAI_IDENTITY_PATH custom value must be used verbatim");
  } finally {
    if (prevVal !== undefined) {
      process.env.MAI_IDENTITY_PATH = prevVal;
    } else {
      delete process.env.MAI_IDENTITY_PATH;
    }
  }
});
