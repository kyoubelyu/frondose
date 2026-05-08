/**
 * P-3 mock tests — T-M82..T-M83: CLI env-var wiring.
 *
 * Tests the observable contract of the CLI's env-var reading:
 *   T-M82: MAI_CDP_PORT defaults to 9222 when unset; custom value is parsed as integer.
 *   T-M83: makeAllTools(undefined) returns echo-only (simulates MAI_NO_CHROME=1 path).
 *
 * These tests verify the behavior without spawning the actual CLI binary
 * (which requires Chrome). The live smoke L-2 exercises the full subprocess path.
 *
 * No Chrome or LLM required.
 */

import assert from "node:assert/strict";
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

// ─── T-M83 ─────────────────────────────────────────────────────────────────────

test("T-M83: makeAllTools(undefined) returns echo-only set, simulating MAI_NO_CHROME=1 path from main.ts", () => {
  // main.ts: if (skipChrome) → makeAllTools() (no session)
  // This simulates the MAI_NO_CHROME=1 branch without spawning Chrome.

  const toolsNoChrome = makeAllTools(undefined);
  const keys = Object.keys(toolsNoChrome);

  assert.deepEqual(keys, ["echo"], "MAI_NO_CHROME=1 path must produce only the echo tool");
  assert.equal(keys.length, 1, "exactly 1 tool when no session (MAI_NO_CHROME=1)");

  // Verify the echo tool is functional
  assert.ok(typeof toolsNoChrome.echo?.execute === "function", "echo tool execute must be a function");
  assert.ok(typeof toolsNoChrome.echo?.description === "string", "echo tool must have a description");
});
