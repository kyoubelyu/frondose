/**
 * P-AUTO-ISOLATE Step 2 — Test Scaffold — `soulModeFragment("auto")` rewrite
 * for the stateless-tick model (plan §6.6).
 *
 * Covers (plan §5): T-Progress.3, T-Soul.StatelessNote, T-Soul.ProgressWriteHabit,
 * T-Soul.StopAutoAnnounced, T-Soul.ByteBudget.
 *
 * Per outside-in TDD + BDD-light: ALL assertion bodies are
 * `assert.fail("TODO Step 5: …")` — RED at Step 2/3/4a. `soulModeFragment` ALREADY
 * exists and is a real export (no dynamic-import guard needed) — only its
 * "auto" branch's TEXT changes at Step 4b (src/agent/systemPrompt/soul.ts:143-171).
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/agent/systemPrompt/soulAutoIsolate-pAutoIsolate.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { soulModeFragment } from "../../../src/agent/systemPrompt/soul.js";

const autoFragment = soulModeFragment("auto");

// ─── T-Progress.3 — soul fragment instructs the write ───────────────────────

describe("soulModeFragment('auto') — instructs writing the auto:progress note before ending each tick (T-Progress.3, LOCKED-1 corollary)", () => {
  it("T-Progress.3: soulModeFragment('auto') contains BOTH 'set_memory_note' AND 'auto:progress', AND it contains 'stop_auto'", () => {
    // Given: the current soulModeFragment("auto") string
    // When:  scanned for the progress-write habit + stop_auto announce literals
    // Then:  contains 'set_memory_note' AND 'auto:progress' AND 'stop_auto' — none of these
    //        substrings exist in the pre-phase fragment (verified at plan research §0.5)
    const hasSetMemoryNote = autoFragment.includes("set_memory_note");
    const hasProgressKey = autoFragment.includes("auto:progress");
    const hasStopAuto = autoFragment.includes("stop_auto");

    assert.fail(
      `TODO Step 5: assert hasSetMemoryNote===true (currently ${hasSetMemoryNote}), ` +
        `hasProgressKey===true (currently ${hasProgressKey}), hasStopAuto===true (currently ${hasStopAuto})`,
    );
  });
});

// ─── T-Soul.StatelessNote ────────────────────────────────────────────────────

describe("soulModeFragment('auto') — stateless-tick preamble (T-Soul.StatelessNote)", () => {
  it("T-Soul.StatelessNote: soulModeFragment('auto') matches /each cron tick[^\\n]*fresh context/i OR contains the exact §6.6 preamble literal", () => {
    // Given: the current soulModeFragment("auto") string
    // When:  matched against the stateless-tick preamble pattern (plan §6.6)
    // Then:  matches /each cron tick[^\n]*fresh context/i (or the exact preamble literal)
    const pattern = /each cron tick[^\n]*fresh context/i;
    const matches = pattern.test(autoFragment);

    assert.fail(
      `TODO Step 5: assert the stateless-tick preamble pattern matches (currently matches=${matches}); ` +
        `fragment starts: ${JSON.stringify(autoFragment.slice(0, 200))}`,
    );
  });
});

// ─── T-Soul.ProgressWriteHabit ───────────────────────────────────────────────

describe("soulModeFragment('auto') — progress-write habit substrings (T-Soul.ProgressWriteHabit)", () => {
  it("T-Soul.ProgressWriteHabit: contains BOTH 'set_memory_note' AND 'auto:progress' (duplicate coverage of T-Progress.3 at the T-Soul.* naming per plan §5)", () => {
    // Given: the current soulModeFragment("auto") string
    // When:  scanned for the two progress-write habit literals
    // Then:  BOTH 'set_memory_note' AND 'auto:progress' are present
    const hasSetMemoryNote = autoFragment.includes("set_memory_note");
    const hasProgressKey = autoFragment.includes("auto:progress");

    assert.fail(
      `TODO Step 5: assert hasSetMemoryNote===true AND hasProgressKey===true; currently ` +
        `hasSetMemoryNote=${hasSetMemoryNote}, hasProgressKey=${hasProgressKey}`,
    );
  });
});

// ─── T-Soul.StopAutoAnnounced ────────────────────────────────────────────────

describe("soulModeFragment('auto') — stop_auto announced as a bare word (T-Soul.StopAutoAnnounced)", () => {
  it("T-Soul.StopAutoAnnounced: contains 'stop_auto' as a bare word", () => {
    // Given: the current soulModeFragment("auto") string
    // When:  scanned for the literal tool name
    // Then:  contains 'stop_auto' (announcing the new tool per plan §6.6 append)
    const hasStopAuto = /\bstop_auto\b/.test(autoFragment);

    assert.fail(`TODO Step 5: assert hasStopAuto===true; currently ${hasStopAuto}`);
  });
});

// ─── T-Soul.ByteBudget ───────────────────────────────────────────────────────

describe("soulModeFragment('auto') — byte-budget headroom under the composeSoulBand cap (T-Soul.ByteBudget, defensive)", () => {
  it("T-Soul.ByteBudget: soulModeFragment('auto').length < 8000", () => {
    // Given: the current soulModeFragment("auto") string (post-rewrite, with the
    //        §6.6 preamble PREPENDED and the stop_auto sentence APPENDED)
    // When:  its length is measured
    // Then:  length < 8000 (defensive — the composeSoulBand hard cap surfaced in
    //        T-ICP-PRECISION was 8500; plan §Appendix A notes current fragment ~5.7KB,
    //        adds ~600 bytes — should have headroom, but MUST be re-measured for real)
    const length = autoFragment.length;

    assert.fail(`TODO Step 5: assert length < 8000; currently length=${length}`);
  });
});
