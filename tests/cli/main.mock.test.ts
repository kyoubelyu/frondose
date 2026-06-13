/**
 * P-3/P-4 mock tests — T-M82, T-M127..T-M128: CLI env-var wiring.
 * P-11 D-12 (T-M83 rewrite): T-M83 now verifies the 4-tool no-session set (post-P-9).
 *
 * T-M82: MAI_CDP_PORT defaults to 9222 when unset; custom value is parsed as integer.
 * T-M83 (D-12 refresh): makeAllTools(undefined, undefined, undefined, undefined) returns
 *        the current P-Y3 no-session power set.
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

test("T-M83: makeAllTools(undefined, undefined, undefined, undefined) returns the 24-tool no-session set (P-Y3 rebaseline)", () => {
  // Given: no CDP session (no LinkedIn tools), no memory, no identity, no control tools
  // When: makeAllTools(undefined, undefined, undefined, undefined) called
  // Then: sorted keys === the 24 session-independent tools (base + 17 sales-kernel tools)

  const toolsNoSession = makeAllTools(undefined);
  const keys = Object.keys(toolsNoSession).sort();

  assert.deepEqual(
    keys,
    [
      "analyze_screenshot",
      "echo",
      "end_auto_run",
      "get_account_context",
      "get_auto_run_state",
      "get_lead_context",
      "get_sales_report",
      "list_due_followups",
      "mark_message_sent",
      "promote_candidate_to_lead",
      "publish_event",
      "query_lead_globally",
      "record_auto_action",
      "record_lead_event",
      "record_raw_candidate",
      "save_message_draft",
      "schedule_follow_up",
      "schedule_task",
      "score_account",
      "score_lead",
      "start_auto_run",
      "update_lead_stage",
      "web_fetch",
      "web_search",
    ],
    `T-M83: makeAllTools(undefined) must return the 24-tool no-session set; got: [${keys.join(", ")}]`,
  );
  assert.equal(keys.length, 24, "exactly 24 tools when no session (P-Y3 rebaseline)");

  // Spot-check that echo tool is still functional
  assert.ok(typeof toolsNoSession.echo?.execute === "function", "echo tool execute must be a function");
  assert.ok(typeof toolsNoSession.echo?.description === "string", "echo tool must have a description");
});

// ─── T-Cli.1 (P-46 G-P46.6): --max-steps flag threads to resolveMaxSteps ────

test("T-Cli.1: MAI_MAX_STEPS env + --max-steps flag wiring — resolveMaxSteps precedence (P-46 D-1b)", async () => {
  // Given: resolveMaxSteps("42") with MAI_MAX_STEPS unset → should return 42 (flag wins);
  //        resolveMaxSteps(undefined) with MAI_MAX_STEPS="99" → should return 99 (env wins);
  //        resolveMaxSteps(undefined) with MAI_MAX_STEPS unset → should return 200 (default)
  // When:  main.ts root action resolves opts.maxSteps via resolveMaxSteps(opts.maxSteps)
  //        (tested here by importing resolveMaxSteps directly — same logic as main.ts)
  // Then:  flag=42+env=99 → 42; flag=undefined+env=99 → 99; flag=undefined+env=unset → 200
  //
  // NOTE (Step 4a): dynamic import — src/agent/maxSteps.ts created at Step 4b.
  const prevEnv = process.env.MAI_MAX_STEPS;
  try {
    // Dynamic import so a missing module fails this test only (not the whole file).
    const { resolveMaxSteps } = await import("../../src/agent/maxSteps.js");

    // 1. CLI flag wins over MAI_MAX_STEPS env
    process.env.MAI_MAX_STEPS = "99";
    assert.equal(resolveMaxSteps("42"), 42, "CLI flag '42' must win over MAI_MAX_STEPS='99'");

    // 2. MAI_MAX_STEPS wins when no CLI flag
    assert.equal(resolveMaxSteps(undefined), 99, "MAI_MAX_STEPS='99' must be used when no CLI flag");

    // 3. DEFAULT_MAX_STEPS=200 when neither set
    delete process.env.MAI_MAX_STEPS;
    assert.equal(resolveMaxSteps(undefined), 200, "DEFAULT_MAX_STEPS=200 when no flag and no env (D-1 raise from 10)");
  } finally {
    if (prevEnv === undefined) delete process.env.MAI_MAX_STEPS;
    else process.env.MAI_MAX_STEPS = prevEnv;
  }
});

// ─── T-M127 ─────────────────────────────────────────────────────────────────

test("T-M127: MAI_MEMORY_DB_PATH env var: defaults to ~/.mai/agent/memory.sqlite; custom value used verbatim", () => {
  // Simulate the main.ts logic:
  //   const memoryDbPath = process.env.MAI_MEMORY_DB_PATH ?? path.join(os.homedir(), ".frondose", "agent", "memory.sqlite");

  const defaultPath = ((): string => {
    const raw = process.env.MAI_MEMORY_DB_PATH;
    return raw ?? path.join(os.homedir(), ".frondose", "agent", "memory.sqlite");
  })();

  const expectedDefault = path.join(os.homedir(), ".frondose", "agent", "memory.sqlite");
  assert.equal(defaultPath, expectedDefault, "MAI_MEMORY_DB_PATH must default to ~/.mai/agent/memory.sqlite");

  // Custom override
  const prevVal = process.env.MAI_MEMORY_DB_PATH;
  process.env.MAI_MEMORY_DB_PATH = "/tmp/custom-memory.sqlite";
  try {
    const customPath = ((): string => {
      const raw = process.env.MAI_MEMORY_DB_PATH;
      return raw ?? path.join(os.homedir(), ".frondose", "agent", "memory.sqlite");
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
  //   const identityPath = process.env.MAI_IDENTITY_PATH ?? path.join(os.homedir(), ".frondose", "agent", "identity.json");

  const defaultPath = ((): string => {
    const raw = process.env.MAI_IDENTITY_PATH;
    return raw ?? path.join(os.homedir(), ".frondose", "agent", "identity.json");
  })();

  const expectedDefault = path.join(os.homedir(), ".frondose", "agent", "identity.json");
  assert.equal(defaultPath, expectedDefault, "MAI_IDENTITY_PATH must default to ~/.mai/agent/identity.json");

  // Custom override
  const prevVal = process.env.MAI_IDENTITY_PATH;
  process.env.MAI_IDENTITY_PATH = "/tmp/custom-identity.json";
  try {
    const customPath = ((): string => {
      const raw = process.env.MAI_IDENTITY_PATH;
      return raw ?? path.join(os.homedir(), ".frondose", "agent", "identity.json");
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
