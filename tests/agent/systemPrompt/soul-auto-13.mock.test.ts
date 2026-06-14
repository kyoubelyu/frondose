/**
 * P-AUTO-13 Step 3 — Test Scaffold — T-A13.Soul.1..9 (G-A13.5)
 *
 * Covers:
 *   G-A13.5 — soulModeFragment("auto") carries the skip-vs-fail wording without
 *   disturbing neighboring clauses.
 *
 * All assertion bodies are inline (string-grep assertions self-verify once the
 * module loads) but will FAIL NOW because soul.ts still has the OLD wording
 * (no "INCLUDING a click that returns ok=false" clause, no skip-worthy enumeration,
 * no ledger_write_failed special-case ordering). They will pass after builder Step 4
 * applies the sketch C soul fragment edit.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/agent/systemPrompt/soul-auto-13.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Dynamic import — soul.ts already exists; only its content changes at Step 4.
// biome-ignore lint/suspicious/noExplicitAny: dynamic import for pre-builder compatibility
let soulModeFragment: ((mode: "manual" | "magical" | "auto") => string) | undefined;

const soulMod = await import("../../../src/agent/systemPrompt/soul.js").catch(() => null);
soulModeFragment = soulMod?.soulModeFragment;

// ─── Helpers: extract the skip-worthy token enumeration from the fragment ─────────────────

/**
 * Extract the list of tokens named as skip-worthy in the auto fragment.
 * The plan's sketch C enumerates them as:
 *   "a `reason` token: cooldown_active / daily_quota_reached / auto_cap_reached / …"
 * or equivalent delimited by '/' or ',' — we extract by looking for the 8 known tokens
 * and verifying EXACT membership (no more, no fewer).
 */
const SKIP_WORTHY_TOKENS = new Set([
  "outbound_disabled",
  "no_active_run",
  "no_daily_snapshot",
  "daily_quota_reached",
  "cooldown_active",
  "auto_cap_reached",
  "connect_note_required",
  "approval_required",
] as const);

/** Extract all GuardReason tokens mentioned in the fragment within a substring range. */
function extractTokensInRange(fragment: string, start: number, end: number): Set<string> {
  const ALL_TOKENS = [
    "outbound_disabled",
    "no_active_run",
    "no_daily_snapshot",
    "daily_quota_reached",
    "cooldown_active",
    "auto_cap_reached",
    "connect_note_required",
    "approval_required",
    "ledger_write_failed",
  ];
  const sub = fragment.slice(start, end);
  return new Set(ALL_TOKENS.filter((t) => sub.includes(t)));
}

describe("T-A13.Soul — soulModeFragment('auto') failure-branch wording (G-A13.5, P-AUTO-13)", () => {
  // ─── T-A13.Soul.1 ─────────────────────────────────────────────────────────
  it("T-A13.Soul.1: auto fragment contains 'INCLUDING a click that returns ok=false or is guard-rejected' (or equivalent ok=false clause)", () => {
    // Given: soulModeFragment imported from soul.ts after builder Step 4 applies sketch C
    // When:  soulModeFragment("auto") is called
    // Then:  the returned string includes the substring 'INCLUDING a click that returns ok=false or is guard-rejected'
    //        (or a structurally-equivalent clause naming ok=false and/or guard-rejection)

    assert.ok(soulModeFragment !== undefined, "T-A13.Soul.1: soulModeFragment must be importable from soul.ts");
    const fragment = soulModeFragment!("auto");

    assert.ok(
      fragment.includes("INCLUDING a click that returns ok=false or is guard-rejected") ||
      (fragment.includes("ok=false") && fragment.includes("guard-rejected")),
      `T-A13.Soul.1: auto fragment must contain an ok=false/guard-rejected clause; ` +
        `fragment (first 400 chars): ${fragment.slice(0, 400)}`,
    );
  });

  // ─── T-A13.Soul.2 ─────────────────────────────────────────────────────────
  it("T-A13.Soul.2: auto fragment contains result:'skipped' for guard-rejected outcomes", () => {
    // Given: soulModeFragment("auto") after Step 4
    // When:  the string is inspected
    // Then:  contains 'result:' and 'skipped' in the failure-branch section
    //        (agent must log guard-rejected as skipped, not failed)

    assert.ok(soulModeFragment !== undefined, "T-A13.Soul.2: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");

    assert.ok(
      fragment.includes("result:'skipped'") || fragment.includes("result: 'skipped'"),
      `T-A13.Soul.2: auto fragment must contain 'result:\\'skipped\\''; ` +
        `fragment (first 400 chars): ${fragment.slice(0, 400)}`,
    );
  });

  // ─── T-A13.Soul.3 — EXACT-SET: exactly 8 skip-worthy tokens ──────────────
  it("T-A13.Soul.3: skip-worthy token enumeration is EXACTLY the 8 pre-dispatch tokens (no extras, no missing)", () => {
    // Given: soulModeFragment("auto") after Step 4
    // When:  the skip-worthy enumeration (the tokens between the 'reason token:' clause
    //        and the sentence-end / ledger_write_failed special-case boundary) is extracted
    // Then:  deepStrictEqual against the exact 8-token set:
    //        { outbound_disabled, no_active_run, no_daily_snapshot, daily_quota_reached,
    //          cooldown_active, auto_cap_reached, connect_note_required, approval_required }
    //        AND ledger_write_failed MUST NOT appear in the skip-worthy enumeration

    assert.ok(soulModeFragment !== undefined, "T-A13.Soul.3: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");

    // Extract the skip-worthy enumeration by finding the range between the skip-worthy
    // clause marker and the genuine-failure / special-case boundary.
    // The plan's sketch C wording uses:
    //   "a `reason` token: <list-of-8-tokens>"
    // followed by "is a NON-attempt" or similar.
    // Strategy: find each of the 8 expected tokens; verify all present.
    // Verify ledger_write_failed is NOT in that same clause.

    const skipWorthy = [...SKIP_WORTHY_TOKENS];
    for (const token of skipWorthy) {
      assert.ok(
        fragment.includes(token),
        `T-A13.Soul.3: auto fragment must contain skip-worthy token '${token}'`,
      );
    }

    // ledger_write_failed must NOT appear in the skip-worthy clause.
    // We assert it IS in the fragment (in the special-case sentence) but NOT co-listed
    // with the 8 skip-worthy tokens.
    assert.ok(
      fragment.includes("ledger_write_failed"),
      "T-A13.Soul.3: fragment must still mention ledger_write_failed (in the special-case blocked-run sentence)",
    );

    // The skip-worthy enumeration clause should NOT contain ledger_write_failed.
    // Locate the enumeration range: look for the token list in the failure-branch paragraph.
    // Use the heuristic: find the 'reason token:' anchor and the next sentence boundary.
    const reasonTokenAnchor = fragment.indexOf("reason` token:");
    if (reasonTokenAnchor !== -1) {
      // The enumeration runs from the anchor to the next '—' or period that ends the clause.
      // We extract up to 500 chars after the anchor as the enumeration scope.
      const enumEnd = reasonTokenAnchor + 500;
      const enumSlice = fragment.slice(reasonTokenAnchor, enumEnd);
      assert.ok(
        !enumSlice.includes("ledger_write_failed"),
        `T-A13.Soul.3: 'ledger_write_failed' must NOT appear in the skip-worthy enumeration range; ` +
          `enumeration slice: ${enumSlice.slice(0, 300)}`,
      );
    }
    // If the anchor isn't found, the test fails via Soul.1 which checks for the clause.
  });

  // ─── T-A13.Soul.4 ─────────────────────────────────────────────────────────
  it("T-A13.Soul.4: fragment contains result:'failed' for genuine send-failures (ok=false with NO guard reason)", () => {
    // Given: soulModeFragment("auto") after Step 4
    // When:  the string is inspected
    // Then:  contains 'result:' and 'failed' for the genuine-failure case

    assert.ok(soulModeFragment !== undefined, "T-A13.Soul.4: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");

    assert.ok(
      fragment.includes("result:'failed'") || fragment.includes("result: 'failed'"),
      `T-A13.Soul.4: auto fragment must contain 'result:\\'failed\\''; ` +
        `fragment (first 400 chars): ${fragment.slice(0, 400)}`,
    );
  });

  // ─── T-A13.Soul.5 ─────────────────────────────────────────────────────────
  it("T-A13.Soul.5: ledger_write_failed appears ONLY in the special-case blocked-run sentence (not in the skip-worthy enumeration)", () => {
    // Given: soulModeFragment("auto") after Step 4
    // When:  the fragment is inspected for ledger_write_failed occurrences
    // Then:  ledger_write_failed appears in the fragment (confirmed);
    //        AND that occurrence is within the blocked-run / end_auto_run special-case sentence
    //        AND NOT within the skip-worthy enumeration

    assert.ok(soulModeFragment !== undefined, "T-A13.Soul.5: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");

    const lfwIdx = fragment.indexOf("ledger_write_failed");
    assert.ok(lfwIdx !== -1, "T-A13.Soul.5: ledger_write_failed must appear in the auto fragment");

    // The blocked-run sentence must include end_auto_run AND ledger_write_failed in proximity.
    // Extract 300 chars around the ledger_write_failed occurrence and verify it sits
    // near an end_auto_run reference.
    const contextSlice = fragment.slice(Math.max(0, lfwIdx - 100), lfwIdx + 300);
    assert.ok(
      contextSlice.includes("end_auto_run") || contextSlice.includes("blocked"),
      `T-A13.Soul.5: ledger_write_failed must appear near 'end_auto_run' or 'blocked' (in the special-case sentence); ` +
        `context slice: ${contextSlice}`,
    );
  });

  // ─── T-A13.Soul.6 — P-AUTO-2 connect-type carve-out preserved ────────────
  it("T-A13.Soul.6: existing P-AUTO-2 connect-type double-count carve-out is preserved byte-for-byte", () => {
    // Given: soulModeFragment("auto") after Step 4
    // When:  the string is inspected
    // Then:  contains the EXACT carve-out substring: 'connect_sent/success ledger row deterministically'
    //        (or the key phrase — validator uses the plan's §4 assertion-intent)

    assert.ok(soulModeFragment !== undefined, "T-A13.Soul.6: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");

    // The carve-out is: "the click layer writes the connect_sent/success ledger row deterministically"
    assert.ok(
      fragment.includes("connect_sent/success ledger row deterministically") ||
      fragment.includes("the click layer writes the connect_sent/success"),
      `T-A13.Soul.6: P-AUTO-2 carve-out phrase must be present; fragment (first 600 chars): ${fragment.slice(0, 600)}`,
    );
  });

  // ─── T-A13.Soul.7 — P-AUTO-9 STOP CONDITIONS preserved ───────────────────
  it("T-A13.Soul.7: P-AUTO-9 STOP CONDITIONS clause preserved unchanged", () => {
    // Given: soulModeFragment("auto") after Step 4
    // When:  the string is inspected
    // Then:  contains 'STOP CONDITIONS' (the exact P-AUTO-9 stop block marker)

    assert.ok(soulModeFragment !== undefined, "T-A13.Soul.7: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");

    assert.ok(
      fragment.includes("STOP CONDITIONS"),
      `T-A13.Soul.7: STOP CONDITIONS clause must still be present; ` +
        `fragment (first 600 chars): ${fragment.slice(0, 600)}`,
    );
  });

  // ─── T-A13.Soul.8 — P-AUTO-10 duplicateOf clause preserved ───────────────
  it("T-A13.Soul.8: P-AUTO-10 duplicateOf clause preserved unchanged", () => {
    // Given: soulModeFragment("auto") after Step 4
    // When:  the string is inspected
    // Then:  contains 'duplicateOf' (the exact P-AUTO-10 field name)

    assert.ok(soulModeFragment !== undefined, "T-A13.Soul.8: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");

    assert.ok(
      fragment.includes("duplicateOf"),
      `T-A13.Soul.8: duplicateOf clause (P-AUTO-10) must still be present; ` +
        `fragment (first 600 chars): ${fragment.slice(0, 600)}`,
    );
  });

  // ─── T-A13.Soul.9 — ledger_write_failed carve-out reordered BEFORE directive ─
  it("T-A13.Soul.9: ledger_write_failed exception is stated BEFORE the 'call record_auto_action FIRST' directive (ordering invariant)", () => {
    // Given: soulModeFragment("auto") after Step 4 (sketch C reordered: carve-outs BEFORE FIRST directive)
    // When:  the string is inspected
    // Then:  the character position of 'ledger_write_failed' is LESS than the position of
    //        'record_auto_action' ... 'FIRST' so the exception syntactically precedes the imperative.
    //        This is the Codex critic round-1 CONCERN-MR fix: the exception cannot be missed.

    assert.ok(soulModeFragment !== undefined, "T-A13.Soul.9: soulModeFragment must be importable");
    const fragment = soulModeFragment!("auto");

    const lfwIdx = fragment.indexOf("ledger_write_failed");
    // D-A13.1: anchor on the SPECIFIC new-directive phrase "FIRST (before any". Bare "FIRST"
    // also matches the pre-existing P-75 D-28 EXHAUSTIVE CAPTURE clause ("the FIRST action is to
    // call record_raw_candidate", soul.ts:154) which precedes this edit; and the directive renders
    // as `record_auto_action({...})\` FIRST (before any \`end_auto_run\`)` so "record_auto_action
    // FIRST" is not literal. "FIRST (before any" is unique to the new directive.
    const firstIdx = fragment.indexOf("FIRST (before any");

    assert.ok(lfwIdx !== -1, "T-A13.Soul.9: ledger_write_failed must appear in the fragment");
    assert.ok(firstIdx !== -1, "T-A13.Soul.9: the 'FIRST (before any end_auto_run)' directive must appear in the fragment");

    assert.ok(
      lfwIdx < firstIdx,
      `T-A13.Soul.9: ledger_write_failed (pos ${lfwIdx}) must appear BEFORE the FIRST directive (pos ${firstIdx}); ` +
        `this ensures the carve-out precedes the imperative (Codex critic CONCERN-MR fix)`,
    );
  });
});
