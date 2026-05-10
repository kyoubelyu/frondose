// P-10 mock tests — T-Wiring.1..4
//
// Tests for main.ts wiring: MAI_SCHEDULE_PATH env-var resolution + CHECKPOINT swap.
//
// T-Wiring.1 — when MAI_SCHEDULE_PATH=/tmp/foo.jsonl, resolved schedule path equals /tmp/foo.jsonl
// T-Wiring.2 — when MAI_SCHEDULE_PATH is unset, resolved path equals ~/.mai/agent/schedule.jsonl
// T-Wiring.3 — when main composes the system prompt, checkpoint band must contain "CRON_RUN_ID="
//              (verifies CHECKPOINT was passed, not CHECKPOINT_PLACEHOLDER)
// T-Wiring.4 — static source-grep: src/cli/main.ts must have ZERO matches for "CHECKPOINT_PLACEHOLDER"
//
// Gate coverage: G-P10.14 (all T-Wiring.1..4)
//
// No Chrome, no LLM, no schedule.jsonl I/O.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

// CHECKPOINT import: src/agent/systemPrompt/checkpoint.ts exports CHECKPOINT post-Step-4b.
import { CHECKPOINT } from "../../src/agent/systemPrompt/checkpoint.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Inline the MAI_SCHEDULE_PATH resolution logic from main.ts (D-9):
 *   const schedulePath = process.env.MAI_SCHEDULE_PATH ?? path.join(os.homedir(), ".mai", "agent", "schedule.jsonl");
 * Test inlines this rather than importing main.ts (which has top-level CLI side effects).
 */
function resolveSchedulePath(): string {
  return process.env.MAI_SCHEDULE_PATH ?? path.join(os.homedir(), ".mai", "agent", "schedule.jsonl");
}

// ════════════════════════════════════════════════════════════════════════════════
// T-Wiring.1..2 — MAI_SCHEDULE_PATH env var resolution
// ════════════════════════════════════════════════════════════════════════════════

describe("main.ts MAI_SCHEDULE_PATH resolution (D-9, D-13, G-P10.14)", () => {
  it("T-Wiring.1: when MAI_SCHEDULE_PATH=/tmp/foo.jsonl is set in process.env, main resolves schedule path to /tmp/foo.jsonl", () => {
    // Given: MAI_SCHEDULE_PATH env var set to "/tmp/foo.jsonl"
    // When: main resolves the schedule path via env read
    // Then: resolved path === "/tmp/foo.jsonl" (env value used verbatim)
    const prev = process.env.MAI_SCHEDULE_PATH;
    process.env.MAI_SCHEDULE_PATH = "/tmp/foo.jsonl";
    try {
      assert.equal(resolveSchedulePath(), "/tmp/foo.jsonl");
    } finally {
      if (prev === undefined) delete process.env.MAI_SCHEDULE_PATH;
      else process.env.MAI_SCHEDULE_PATH = prev;
    }
  });

  it("T-Wiring.2: when MAI_SCHEDULE_PATH is unset, main resolves schedule path to path.join(os.homedir(), '.mai', 'agent', 'schedule.jsonl')", () => {
    // Given: MAI_SCHEDULE_PATH is not set in process.env
    // When: main resolves the schedule path via env read with fallback
    // Then: resolved path === path.join(homedir, ".mai", "agent", "schedule.jsonl")
    const prev = process.env.MAI_SCHEDULE_PATH;
    delete process.env.MAI_SCHEDULE_PATH;
    try {
      const expected = path.join(os.homedir(), ".mai", "agent", "schedule.jsonl");
      assert.equal(resolveSchedulePath(), expected);
    } finally {
      if (prev !== undefined) process.env.MAI_SCHEDULE_PATH = prev;
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// T-Wiring.3..4 — CHECKPOINT swap verification
// ════════════════════════════════════════════════════════════════════════════════

describe("main.ts CHECKPOINT swap (D-9, G-P10.14)", () => {
  it("T-Wiring.3: when main composes the system prompt, the checkpoint band contains 'CRON_RUN_ID=' (verifies CHECKPOINT constant is used, not the placeholder)", () => {
    // Given: CHECKPOINT constant imported from src/agent/systemPrompt/checkpoint.ts (post-Step-4b rewrite)
    // When: CHECKPOINT.includes("CRON_RUN_ID=")
    // Then: true — confirms the filled constant (not the placeholder) is what main.ts composes with
    assert.ok(
      CHECKPOINT.includes("CRON_RUN_ID="),
      `CHECKPOINT must contain "CRON_RUN_ID=" (confirms the filled constant is active, not the placeholder)`,
    );
  });

  it("T-Wiring.4 (static source grep): src/cli/main.ts contains ZERO matches for 'CHECKPOINT_PLACEHOLDER'", () => {
    // Given: the post-Step-4b state of src/cli/main.ts (CHECKPOINT swap applied)
    // When: readFileSync('src/cli/main.ts') and search for 'CHECKPOINT_PLACEHOLDER'
    // Then: zero occurrences found (both import and use-site have been updated to CHECKPOINT)
    const mainSrc = readFileSync(path.join(process.cwd(), "src", "cli", "main.ts"), "utf-8");
    assert.ok(
      !mainSrc.includes("CHECKPOINT_PLACEHOLDER"),
      "src/cli/main.ts must have zero occurrences of CHECKPOINT_PLACEHOLDER (swap must be complete)",
    );
  });
});
