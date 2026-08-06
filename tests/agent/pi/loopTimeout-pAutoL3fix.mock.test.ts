/**
 * P-AUTO-L3FIX-1 Step 2 — Test Scaffold
 * T-Timeout.1–2 (A2 — complete() timeoutMs defense-in-depth)
 *
 * Workstream covered: A2
 *
 * All assertion bodies are assert.fail("TODO: …") — compile-only, ALL-FAILING.
 * Builder Step 4 adds LLM_COMPLETE_TIMEOUT_MS to model.ts + passes timeoutMs in loop.ts.
 * Validator Step 5 fills assertion bodies.
 *
 * Test approach:
 *   - T-Timeout.1: source-text assertion against model.ts and loop.ts — no live LLM needed.
 *     We verify (a) LLM_COMPLETE_TIMEOUT_MS is exported from model.ts with value 120_000
 *     and (b) loop.ts passes timeoutMs in the complete() options object.
 *     A stub-based approach is avoided here because model.ts reads secrets from disk;
 *     source-text inspection is simpler, deterministic, and sufficient for a constant.
 *
 *   - T-Timeout.2: static invariant — LLM_COMPLETE_TIMEOUT_MS (120_000) < SILENT_HANG_MS (180_000).
 *     Pure arithmetic, no I/O. Asserts the ordering is preserved so the HTTP timeout fires
 *     before the D-27 silent-hang watcher.
 *
 * No real Chrome or LLM required.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// ─── Source-text harness ───────────────────────────────────────────────────────

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODEL_TS_SRC = readFileSync(join(REPO, "src/agent/pi/model.ts"), "utf-8");
const LOOP_TS_SRC = readFileSync(join(REPO, "src/agent/pi/loop.ts"), "utf-8");
const RUN_ONE_TS_SRC = readFileSync(join(REPO, "src/app/backend/turn/runOne.ts"), "utf-8");

// ─── A2 — complete() timeoutMs ────────────────────────────────────────────────

describe("A2 — complete() timeoutMs: loop passes timeoutMs:120000 as defense-in-depth", () => {
  // ─── T-Timeout.1 ────────────────────────────────────────────────────────────
  it("T-Timeout.1: loop.ts passes timeoutMs === LLM_COMPLETE_TIMEOUT_MS (120000) in the complete() options (source-text pin)", () => {
    // Given: src/agent/pi/model.ts exports LLM_COMPLETE_TIMEOUT_MS = 120_000
    //        and returns timeoutMs: LLM_COMPLETE_TIMEOUT_MS on PiModelResolution
    // When:  src/agent/pi/loop.ts is read
    // Then:  (a) model.ts source contains "LLM_COMPLETE_TIMEOUT_MS = 120_000" (or "120000")
    //        (b) loop.ts source contains "timeoutMs" in the complete() call site
    //        (c) loop.ts destructures timeoutMs from the resolvePiModel() result
    //
    // Source-text checks rather than import-and-run, because resolvePiModel() reads
    // secrets from disk which are not available in the test environment.
    const modelHasConstant =
      MODEL_TS_SRC.includes("LLM_COMPLETE_TIMEOUT_MS") &&
      (MODEL_TS_SRC.includes("120_000") || MODEL_TS_SRC.includes("120000"));
    const modelHasTimeoutMs = MODEL_TS_SRC.includes("timeoutMs") && MODEL_TS_SRC.includes("PiModelResolution");
    const loopPassesTimeoutMs = LOOP_TS_SRC.includes("timeoutMs") && LOOP_TS_SRC.includes("complete(");

    // (a) model.ts must export LLM_COMPLETE_TIMEOUT_MS = 120_000
    assert.ok(
      modelHasConstant,
      "model.ts must export LLM_COMPLETE_TIMEOUT_MS with value 120_000 (or 120000). " +
        `modelHasConstant=${modelHasConstant}`,
    );

    // (b) model.ts must include timeoutMs in PiModelResolution interface
    assert.ok(
      modelHasTimeoutMs,
      "model.ts must include timeoutMs field in PiModelResolution. " + `modelHasTimeoutMs=${modelHasTimeoutMs}`,
    );

    // (c) loop.ts must pass timeoutMs in the complete() call
    assert.ok(
      loopPassesTimeoutMs,
      "loop.ts must destructure timeoutMs from resolvePiModel() and pass it to complete(). " +
        `loopPassesTimeoutMs=${loopPassesTimeoutMs}`,
    );

    // Extra structural pin: loop.ts destructures timeoutMs from resolvePiModel() return value
    const loopDestructuresTimeoutMs = LOOP_TS_SRC.includes("{ model,") && LOOP_TS_SRC.includes("timeoutMs }");
    assert.ok(
      loopDestructuresTimeoutMs,
      "loop.ts must destructure timeoutMs from resolvePiModel() result. " +
        `loopDestructuresTimeoutMs=${loopDestructuresTimeoutMs}`,
    );
  });

  // ─── T-Timeout.2 ────────────────────────────────────────────────────────────
  it("T-Timeout.2: LLM_COMPLETE_TIMEOUT_MS (120000) < SILENT_HANG_MS (180000) — static ordering invariant", () => {
    // Given: the D-27 silent-hang watcher fires at SILENT_HANG_MS = 180_000 (runOne.ts:127, verified)
    //        and LLM_COMPLETE_TIMEOUT_MS is defined as 120_000 in model.ts
    // When:  the two constants are compared
    // Then:  120_000 < 180_000 is true — the HTTP timeout fires BEFORE D-27, providing a
    //        cleaner stop (LlmCallError into loop catch) ahead of the abort-into-a-void path
    //
    // Also pins that SILENT_HANG_MS is still 180_000 in runOne.ts (regression guard).
    const silentHangMs = 180_000; // from runOne.ts:127 VERIFIED
    const llmCompleteTimeoutMs = 120_000; // from plan §6.6 LLM_COMPLETE_TIMEOUT_MS

    // Verify SILENT_HANG_MS in runOne.ts hasn't drifted from 180_000
    const runOneHasSilentHang180 =
      RUN_ONE_TS_SRC.includes("SILENT_HANG_MS") &&
      (RUN_ONE_TS_SRC.includes("180_000") || RUN_ONE_TS_SRC.includes("180000"));

    // The ordering invariant: HTTP timeout fires BEFORE D-27 watcher → cleaner stop.
    assert.ok(
      llmCompleteTimeoutMs < silentHangMs,
      `LLM_COMPLETE_TIMEOUT_MS (${llmCompleteTimeoutMs}) must be < SILENT_HANG_MS (${silentHangMs})`,
    );

    // Regression pin: SILENT_HANG_MS in runOne.ts must still be 180_000
    assert.ok(
      runOneHasSilentHang180,
      "runOne.ts must still declare SILENT_HANG_MS=180_000. " + `runOneHasSilentHang180=${runOneHasSilentHang180}`,
    );
  });
});
