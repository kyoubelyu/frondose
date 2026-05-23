// P-10 mock tests — T-Wiring.1..4 (P-10) + T-Wiring.1..4 (P-11)
//
// P-10 tests for main.ts wiring: MAI_SCHEDULE_PATH env-var resolution + CHECKPOINT swap.
//   T-Wiring.1 — when MAI_SCHEDULE_PATH=/tmp/foo.jsonl, resolved schedule path equals /tmp/foo.jsonl
//   T-Wiring.2 — when MAI_SCHEDULE_PATH is unset, resolved path equals ~/.mai/agent/schedule.jsonl
//   T-Wiring.3 — when main composes the system prompt, checkpoint band must contain "CRON_RUN_ID="
//                (verifies CHECKPOINT was passed, not CHECKPOINT_PLACEHOLDER)
//   T-Wiring.4 — static source-grep: src/cli/main.ts must have ZERO matches for "CHECKPOINT_PLACEHOLDER"
//
// P-11 tests for main.ts wiring (Step 4a scaffolds — assertion bodies are TODO):
//   T-Wiring.p11.1 — MAI_TELEGRAM_CONFIG_PATH env var resolves to correct path
//   T-Wiring.p11.2 — MAI_TELEGRAM_CONFIG_PATH unset resolves to ~/.mai/agent/telegram.json
//   T-Wiring.p11.3 — TurnLock instance constructed in main.ts and passed to runRepl
//   T-Wiring.p11.4 — grep CLAUDE.md for MAI_TELEGRAM_CONFIG_PATH (≥1) and MAI_NO_CHROME (0)
//
// Gate coverage: G-P10.14 (T-Wiring.1..4 P-10), G-P11.20 (T-Wiring.p11.1..4)
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

// ════════════════════════════════════════════════════════════════════════════════
// P-11 Step 4a scaffolds — T-Wiring.p11.1..4: MAI_TELEGRAM_CONFIG_PATH + TurnLock
// All assertion bodies are TODO. Tests fail at Step 4a if src/agent/turnSemaphore.js
// does not yet exist (import error). At Step 5, validator fills bodies.
// ════════════════════════════════════════════════════════════════════════════════

describe("main.ts P-11 wiring: MAI_TELEGRAM_CONFIG_PATH + TurnLock (G-P11.20)", () => {
  /** Inline the MAI_TELEGRAM_CONFIG_PATH resolution logic from main.ts (D-4 / §6.10). */
  function resolveTelegramConfigPath(): string {
    return process.env.MAI_TELEGRAM_CONFIG_PATH ?? path.join(os.homedir(), ".mai", "agent", "telegram.json");
  }

  it("T-Wiring.p11.1: when MAI_TELEGRAM_CONFIG_PATH=/tmp/foo.json is set, main resolves telegram config path to /tmp/foo.json", () => {
    // Given: MAI_TELEGRAM_CONFIG_PATH env var set to "/tmp/foo.json"
    // When: main resolves the telegram config path via env read
    // Then: resolved path === "/tmp/foo.json" (env value used verbatim)
    const prev = process.env.MAI_TELEGRAM_CONFIG_PATH;
    process.env.MAI_TELEGRAM_CONFIG_PATH = "/tmp/foo.json";
    try {
      assert.equal(resolveTelegramConfigPath(), "/tmp/foo.json");
    } finally {
      if (prev === undefined) delete process.env.MAI_TELEGRAM_CONFIG_PATH;
      else process.env.MAI_TELEGRAM_CONFIG_PATH = prev;
    }
  });

  it("T-Wiring.p11.2: when MAI_TELEGRAM_CONFIG_PATH is unset, main resolves telegram config path to path.join(homedir, '.mai', 'agent', 'telegram.json')", () => {
    // Given: MAI_TELEGRAM_CONFIG_PATH is not set
    // When: main resolves via env read with fallback
    // Then: resolved path === path.join(homedir, ".mai", "agent", "telegram.json")
    const prev = process.env.MAI_TELEGRAM_CONFIG_PATH;
    delete process.env.MAI_TELEGRAM_CONFIG_PATH;
    try {
      const expected = path.join(os.homedir(), ".mai", "agent", "telegram.json");
      assert.equal(resolveTelegramConfigPath(), expected);
    } finally {
      if (prev !== undefined) process.env.MAI_TELEGRAM_CONFIG_PATH = prev;
    }
  });

  it("T-Wiring.p11.3: a single TurnLock instance is constructed in the boot path and passed into runRepl({turnLock}) — static grep of src/cli/workerBoot.ts", () => {
    // Given: post-P-45 state — the boot-then-run-agent sequence was extracted from main.ts
    //        into src/cli/workerBoot.ts (P-45 C-1/F-8), which now constructs the TurnLock + calls runRepl.
    // When: readFileSync('src/cli/workerBoot.ts') and check for TurnLock construction + runRepl arg.
    // Then: workerBoot.ts contains 'new TurnLock()' AND passes 'turnLock' to runRepl AND imports TurnLock.
    const bootSrc = readFileSync(path.join(process.cwd(), "src", "cli", "workerBoot.ts"), "utf-8");
    assert.ok(
      bootSrc.includes("new TurnLock()"),
      "src/cli/workerBoot.ts must contain 'new TurnLock()' (D-19: single binary-lifetime mutex; P-Z3: moved from main.ts at P-45)",
    );
    assert.ok(bootSrc.includes("turnLock"), "src/cli/workerBoot.ts must contain 'turnLock' (passed to runRepl)");
    assert.ok(bootSrc.includes("runRepl"), "src/cli/workerBoot.ts must call runRepl with the turnLock");
    assert.ok(bootSrc.includes("TurnLock"), "src/cli/workerBoot.ts must import/use TurnLock");
  });

  it("T-Wiring.p11.4 (TS/grep): the env-var reference (ROADMAP.md) lists MAI_TELEGRAM_CONFIG_PATH AND has no active MAI_NO_CHROME table row", () => {
    // Given: P-Z3 — the MAI_* env-var enumeration moved from CLAUDE.md to ROADMAP.md § Env-var
    //        reference (per the CLAUDE.md LLM-Configuration note: "MAI_* env-var enumeration moved
    //        to ROADMAP.md"). MAI_NO_CHROME was removed (P-11) and now appears in ROADMAP only as
    //        historical phase-completion prose, NOT as an active env-var table row.
    // When:  readFileSync('ROADMAP.md') + search.
    // Then:  MAI_TELEGRAM_CONFIG_PATH is documented (≥1, the active table row) AND there is no
    //        active `| `MAI_NO_CHROME` |` table-row entry (historical prose mentions are allowed).
    const roadmap = readFileSync(path.join(process.cwd(), "ROADMAP.md"), "utf-8");
    assert.ok(
      roadmap.includes("MAI_TELEGRAM_CONFIG_PATH"),
      "ROADMAP.md § Env-var reference must contain MAI_TELEGRAM_CONFIG_PATH (added in P-11)",
    );
    assert.ok(
      !roadmap.includes("| `MAI_NO_CHROME`"),
      "ROADMAP.md must NOT have an active MAI_NO_CHROME env-var table row (removed P-11; only historical prose remains)",
    );
  });
});
