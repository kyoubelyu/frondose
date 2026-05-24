/**
 * P-16 Step 4a — T-Tools.1 (tool count verification scaffold)
 *
 * Tests that all 24 tools are registered with a fake LinkedIn session.
 * Does NOT use real LLM calls — only makeAllTools + assertion.
 *
 * T-Tools.1: All 24 tools registered with fake session
 *
 * Gate coverage: G-P16.7
 *
 * Assertion bodies are TODO — filled at Step 5 after builder creates
 * FakeLinkedInWorld + harness at Step 4b.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ControlSignals } from "../../src/tools/control/stop.js";
import { makeAllTools } from "../../src/tools/index.js";
import { FakeLinkedInWorld } from "./fake-linkedin-world.js";

process.env.MAI_TIER = "power"; // P-58a: assert the FULL (power-tier) tool inventory (tiering reconciliation)

// Known browser + LinkedIn tool names (P-33: browser primitives in src/tools/browser/, launch in src/tools/linkedin/)
const LINKEDIN_TOOL_NAMES = [
  "launch",
  "inspect",
  "click",
  "type",
  "press",
  "upload",
  "close",
  "reload",
  "scroll",
  "screenshot",
];

// ─── T-Tools.1 ────────────────────────────────────────────────────
// Given: FakeLinkedInWorld session + test identity persistence
// When:  makeAllTools(session, { memoryDbPath: ":memory:", identityPath: "...control })
// Then:  returned ToolSet has exactly 24 keys. All 10 LinkedIn tool names present.

test("T-Tools.1: all 24 tools registered with fake session", async () => {
  const world = new FakeLinkedInWorld();
  const session = world.makeSession();
  const control: ControlSignals = {
    requestStop: () => {},
    auditPath: "",
  };

  const tools = makeAllTools(session, { memoryDbPath: ":memory:", identityPath: "" }, control);
  const toolNames = Object.keys(tools);

  // Total count assertion (P-Z3 rebaseline: was 24; default-mode makeAllTools is now 35
  // post-P-Y1 — +memory/coords/cron/suggestion/todo_write tools accreted since P-16)
  assert.equal(toolNames.length, 35, `Expected 35 tools, got ${toolNames.length}: ${toolNames.join(", ")}`);

  // All 10 LinkedIn tool names present
  const missing = LINKEDIN_TOOL_NAMES.filter((name) => !toolNames.includes(name));
  assert.equal(missing.length, 0, `LinkedIn tools missing from registry: ${missing.join(", ")}`);
});
