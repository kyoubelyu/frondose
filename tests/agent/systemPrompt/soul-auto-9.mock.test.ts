/**
 * P-AUTO-9 Step 3 — Test Scaffold — T-A9.Soul.1..5 (G-A9.10..14).
 * soulModeFragment("auto"): connectsRemaining clause + old-arithmetic removal + invariants.
 *
 * All assertion bodies are placed inline (string-grep assertions are inherently self-verifying
 * once the module loads — they fail NOW because the production soul.ts still has the OLD
 * sparse-arithmetic clause; they will pass after builder Step 4 replaces it).
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/agent/systemPrompt/soul-auto-9.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Dynamic import — soul.ts exists pre-builder; only its content changes in Step 4.
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder compatibility
let soulModeFragment: ((mode: "manual" | "magical" | "auto") => string) | undefined;

const soulMod = await import("../../../src/agent/systemPrompt/soul.js").catch(() => null);
soulModeFragment = soulMod?.soulModeFragment;

describe("T-A9.Soul — soulModeFragment('auto') connectsRemaining clause (P-AUTO-9)", () => {
  // ─── T-A9.Soul.1 ─────────────────────────────────────────────────────────────
  it("T-A9.Soul.1: soulModeFragment('auto') contains the new connectsRemaining clause", () => {
    // Given: soulModeFragment imported from soul.ts (builder has applied P-AUTO-9 substring swap)
    // When:  soulModeFragment("auto") is called
    // Then:  returned string includes 'connectsRemaining === null || connectsRemaining > 0'
    assert.ok(soulModeFragment !== undefined, "T-A9.Soul.1: soulModeFragment must be importable from soul.ts");
    const fragment = soulModeFragment!("auto");
    assert.ok(
      fragment.includes("connectsRemaining === null || connectsRemaining > 0"),
      "T-A9.Soul.1: auto fragment must contain 'connectsRemaining === null || connectsRemaining > 0'; " +
        `got fragment starting with: ${fragment.slice(0, 200)}`,
    );
  });

  // ─── T-A9.Soul.2 ─────────────────────────────────────────────────────────────
  it("T-A9.Soul.2: soulModeFragment('auto') no longer contains the old sparse-map arithmetic", () => {
    // Given: soulModeFragment("auto") after builder Step 4 has replaced the arithmetic
    // When:  the returned string is inspected
    // Then:  it does NOT contain 'counters.connect_sent < run.maxConnects'
    assert.ok(soulModeFragment !== undefined, "T-A9.Soul.2: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");
    assert.ok(
      !fragment.includes("counters.connect_sent < run.maxConnects"),
      "T-A9.Soul.2: auto fragment must NOT contain 'counters.connect_sent < run.maxConnects' (old sparse-map arithmetic)",
    );
  });

  // ─── T-A9.Soul.3 ─────────────────────────────────────────────────────────────
  it("T-A9.Soul.3: stop-sentence references `connectsRemaining === 0`", () => {
    // Given: soulModeFragment("auto") after builder Step 4
    // When:  the returned string is inspected for the new stop-condition wording
    // Then:  it includes the substring 'If `connectsRemaining === 0`'
    assert.ok(soulModeFragment !== undefined, "T-A9.Soul.3: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");
    assert.ok(
      fragment.includes("If `connectsRemaining === 0`"),
      "T-A9.Soul.3: auto fragment must contain 'If `connectsRemaining === 0`' (new stop-condition wording); " +
        `fragment has first 300 chars: ${fragment.slice(0, 300)}`,
    );
  });

  // ─── T-A9.Soul.4 ─────────────────────────────────────────────────────────────
  it("T-A9.Soul.4: other auto-fragment invariants preserved — no collateral edits", () => {
    // Given: soulModeFragment("auto") after builder Step 4
    // When:  the returned string is inspected for all required invariant substrings
    // Then:  all of the following are present:
    //   - 'HARD CAPTURE DIRECTIVE'
    //   - 'start_auto_run'
    //   - 'list_due_followups'
    //   - '(Date.now() - run.startedAt) / 60000 < run.maxDurationMinutes'
    //   - 'dailyOutbound.remaining > 0'
    //   - 'dailyOutbound.cooldownActive === false'
    //   - 'end_auto_run'
    //   - 'record_auto_action'
    //   - 'meeting_booked'
    //   - 'stopped_by_agent'    (stop conditions 2/4 wording)
    assert.ok(soulModeFragment !== undefined, "T-A9.Soul.4: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");

    const requiredSubstrings: Array<[string, string]> = [
      ["HARD CAPTURE DIRECTIVE", "auto fragment must still contain 'HARD CAPTURE DIRECTIVE'"],
      ["start_auto_run", "auto fragment must still contain 'start_auto_run'"],
      ["list_due_followups", "auto fragment must still contain 'list_due_followups'"],
      [
        "(Date.now() - run.startedAt) / 60000 < run.maxDurationMinutes",
        "auto fragment must still contain the duration clause",
      ],
      ["dailyOutbound.remaining > 0", "auto fragment must still contain 'dailyOutbound.remaining > 0'"],
      ["dailyOutbound.cooldownActive === false", "auto fragment must still contain 'dailyOutbound.cooldownActive === false'"],
      ["end_auto_run", "auto fragment must still contain 'end_auto_run'"],
      ["record_auto_action", "auto fragment must still contain 'record_auto_action'"],
      ["meeting_booked", "auto fragment must still contain 'meeting_booked' outcome guidance"],
      ["stopped_by_agent", "auto fragment must still contain 'stopped_by_agent' (stop conditions 2/4)"],
    ];

    for (const [substr, msg] of requiredSubstrings) {
      assert.ok(fragment.includes(substr), `T-A9.Soul.4: ${msg}`);
    }
  });

  // ─── T-A9.Soul.5 ─────────────────────────────────────────────────────────────
  it("T-A9.Soul.5: manual and magical fragments untouched — no connectsRemaining leakage", () => {
    // Given: soulModeFragment("manual") and soulModeFragment("magical") after builder Step 4
    // When:  both strings are inspected
    // Then:  neither contains 'connectsRemaining' nor the old 'counters.connect_sent < run.maxConnects'
    assert.ok(soulModeFragment !== undefined, "T-A9.Soul.5: soulModeFragment must be importable");

    const manualFragment = soulModeFragment!("manual");
    const magicalFragment = soulModeFragment!("magical");

    assert.ok(
      !manualFragment.includes("connectsRemaining"),
      "T-A9.Soul.5: manual fragment must NOT contain 'connectsRemaining' (auto-only change)",
    );
    assert.ok(
      !magicalFragment.includes("connectsRemaining"),
      "T-A9.Soul.5: magical fragment must NOT contain 'connectsRemaining' (auto-only change)",
    );
    assert.ok(
      !manualFragment.includes("counters.connect_sent < run.maxConnects"),
      "T-A9.Soul.5: manual fragment must NOT contain old sparse-map arithmetic (should never have been there)",
    );
    assert.ok(
      !magicalFragment.includes("counters.connect_sent < run.maxConnects"),
      "T-A9.Soul.5: magical fragment must NOT contain old sparse-map arithmetic (should never have been there)",
    );
  });
});
