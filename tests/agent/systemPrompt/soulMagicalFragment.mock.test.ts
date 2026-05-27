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
  it("T-SP-C.SoulHabit.1: soulModeFragment('magical') contains Magical behavioral text + no outbound imperative; manual+auto fragments unchanged", () => {
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
    // ── Positive: magical fragment must contain all required terms ─────────
    const magical = soulModeFragment("magical" as any);
    assert.ok(
      magical.includes("MAGICAL mode"),
      `soulModeFragment("magical") must contain "MAGICAL mode". Got: ${magical.slice(0, 120)}`,
    );
    assert.ok(magical.includes("passive"), `must contain "passive"`);
    assert.ok(magical.includes("record_raw_candidate"), `must contain "record_raw_candidate"`);
    assert.ok(magical.includes("search_memory"), `must contain "search_memory"`);
    assert.ok(magical.includes("score_lead"), `must contain "score_lead"`);
    assert.ok(magical.includes("suggest_card"), `must contain "suggest_card"`);
    assert.ok(magical.includes("NEVER initiate outbound"), `must contain "NEVER initiate outbound" prohibition`);

    // ── Negative: outbound verbs must only appear in prohibition lines ────
    // The "NEVER initiate outbound (connect/message/comment/follow)" prohibition
    // line mentions them as examples — that is the ONLY allowed occurrence.
    // No step directive should instruct the agent to connect/message/comment as an action.
    // Strategy: strip the prohibition line, then check no imperative use remains.
    const magicalMinusProhibition = magical
      .split("\n")
      .filter((line) => !line.includes("NEVER") && !line.includes("never call"))
      .join("\n");
    assert.ok(
      !magicalMinusProhibition.includes("initiate connect") &&
        !magicalMinusProhibition.includes("send message") &&
        !magicalMinusProhibition.includes("post comment"),
      `After removing prohibition line, no outbound imperatives should remain. Fragment (stripped): ${magicalMinusProhibition.slice(0, 200)}`,
    );

    // ── Regression: manual and auto fragments unchanged ───────────────────
    const manual = soulModeFragment("manual");
    assert.ok(manual.includes("MANUAL mode"), `soulModeFragment("manual") must still contain "MANUAL mode"`);
    const auto = soulModeFragment("auto");
    assert.ok(auto.includes("AUTO mode"), `soulModeFragment("auto") must still contain "AUTO mode"`);
  });
});
