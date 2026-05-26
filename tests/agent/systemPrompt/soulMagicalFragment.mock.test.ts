/**
 * P-SP-C scaffold — T-SP-C.SoulHabit.1 (F-9)
 * soulModeFragment("magical") text contract + existing fragments unchanged.
 *
 * Step 4a: assertion bodies are TODO stubs — ALL FAIL pre-builder.
 * Step 5:  builder extends soulModeFragment signature to "manual"|"magical"|"auto" (F-3 §5.3)
 *          → assertions filled.
 *
 * NOTE: current `soulModeFragment` signature is `"manual" | "auto"`. tsx (type-
 * erasure at runtime) allows calling it with "magical" — no crash, but returns the
 * "manual" default (falls through to the final return). The TODO assertion fires
 * regardless, so static import is safe pre-builder.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/agent/systemPrompt/soulMagicalFragment.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
// biome-ignore lint/suspicious/noExplicitAny: signature widened to include "magical" post-builder
import { soulModeFragment } from "../../../src/agent/systemPrompt/soul.js";

describe("T-SP-C.SoulHabit — soulModeFragment 3-mode extension (P-SP-C)", () => {
  // ─── T-SP-C.SoulHabit.1 ──────────────────────────────────────────────────────
  it(
    "T-SP-C.SoulHabit.1: soulModeFragment('magical') contains Magical behavioral text + no outbound imperative; manual+auto fragments unchanged",
    () => {
      // Given: soulModeFragment (post-builder: widened to "manual"|"magical"|"auto")
      // When:  called with "magical"
      // Then POSITIVE — ALL must be present in the returned string:
      //   "MAGICAL mode", "passive", "record_raw_candidate", "search_memory",
      //   "score_lead", "suggest_card", "NEVER initiate outbound"
      // Then NEGATIVE — outbound imperatives must NOT appear (only prohibitions):
      //   assert "connect" / "message" / "comment" only appear in "NEVER ... never call"
      //   prohibition lines, NOT as step directives
      //
      // Additionally: soulModeFragment("manual") still contains "MANUAL mode"
      //               soulModeFragment("auto") still contains "AUTO mode"
      //   (regression guards for existing fragments — covers G-SP-C.7)
      assert.ok(false, "TODO: fill at Step 5 — FAILS pre-builder");
    },
  );
});
