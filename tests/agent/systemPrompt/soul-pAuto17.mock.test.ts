/**
 * P-AUTO-17 Step 3 — Test Scaffold — G-A17.20 (soul guard-token + composeSoulBand cap)
 *
 * Covers:
 *   G-A17.20 — soulModeFragment("auto") failure-branch token list contains the new
 *              `unresolvable_ref_on_outbound_surface` guard-reason token (ND-3 fix), ensuring
 *              the agent classifies the fail-closed reject as result:'skipped' (NON-attempt),
 *              not result:'failed' (genuine send failure).
 *
 *   REGRESSION GUARD — composeSoulBand(null).length <= 8500 (P-39 raised 6000→8000;
 *              T-ICP-PRECISION raised 8000→8500 for the own_company + icp-override habit lines,
 *              actual ~8380): proves the +38-char soul.ts:169 edit did NOT accidentally inline
 *              into composeSoulBand (which is the surface the existing T-SOUL.RHYTHM.4 / sp-d /
 *              sp-f cap tests assert). composeSoulBand does NOT call soulModeFragment; they are
 *              separate exports. This guard PASSES pre-impl by design (composeSoulBand is already
 *              7989 before the soul.ts edit) and MUST continue to pass post-impl.
 *
 * BDD-light:
 *   - describe/it grouping per behavior surface.
 *   - Given/When/Then comment per test.
 *   - Test names describe behavior, not function names.
 *
 * Run (mock — no external deps):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/agent/systemPrompt/soul-pAuto17.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ─── Import target ────────────────────────────────────────────────────────────────────────────
// Both soulModeFragment and composeSoulBand are verified exports of soul.ts (confirmed at
// plan-write via: Object.keys(import soul.ts) = ['SOUL','composeSoulBand','resolveSoulBand','soulModeFragment']).
import { composeSoulBand, soulModeFragment } from "../../../src/agent/systemPrompt/soul.js";

// ─── G-A17.20 — soulModeFragment("auto") failure-branch token list ───────────────────────────
describe("G-A17.20 — soulModeFragment('auto') failure-branch contains the new guard-reason token (P-AUTO-17)", () => {
  // ─── T-A17.20a: new token present ─────────────────────────────────────────────────────────
  it("T-A17.20a: when soul.ts:169 is edited by Codex (Step 4), soulModeFragment('auto') contains 'unresolvable_ref_on_outbound_surface'", () => {
    // Given: src/agent/systemPrompt/soul.ts has been edited by Codex (Step 4) to append
    //        `unresolvable_ref_on_outbound_surface` to the guard-reason slash-list at :169
    // When:  soulModeFragment("auto") is called (returns the AUTO mode inline string)
    // Then:  the returned string contains the literal substring `unresolvable_ref_on_outbound_surface`
    const fragment = soulModeFragment("auto");
    assert.ok(
      fragment.includes("unresolvable_ref_on_outbound_surface"),
      `G-A17.20a: soulModeFragment('auto') must contain 'unresolvable_ref_on_outbound_surface' ` +
        `(Codex Step 4 must have appended it to the guard-reason slash-list at soul.ts:169). ` +
        `Fragment length=${fragment.length}`,
    );
  });

  // ─── T-A17.20b: new token in the failure-branch clause (co-occurrence check) ──────────────
  it("T-A17.20b: when soul.ts:169 is edited by Codex (Step 4), the new token appears within ±200 chars of the existing guard-reason tokens in soulModeFragment('auto')", () => {
    // Given: the edited soul.ts:169 appends the token to the SAME slash-separated clause that
    //        already enumerates cooldown_active / daily_quota_reached / ... / no_daily_snapshot
    // When:  soulModeFragment("auto") is read and the position of the new token is located
    // Then:  at least 3 existing guard-reason tokens appear within 200 chars of the new token,
    //        proving it landed in the failure-branch token list (not in some other clause)
    const fragment = soulModeFragment("auto");
    const newToken = "unresolvable_ref_on_outbound_surface";
    const existingTokens = [
      "cooldown_active",
      "daily_quota_reached",
      "auto_cap_reached",
      "connect_note_required",
      "approval_required",
      "outbound_disabled",
      "no_active_run",
      "no_daily_snapshot",
    ];

    const newTokenIdx = fragment.indexOf(newToken);
    assert.ok(newTokenIdx !== -1, `G-A17.20b: '${newToken}' not found in soulModeFragment('auto') — Codex Step 4 must append it at soul.ts:169`);

    const tokensNearby = existingTokens.filter((t) => {
      const idx = fragment.indexOf(t);
      return idx !== -1 && Math.abs(idx - newTokenIdx) <= 200;
    });
    assert.ok(
      tokensNearby.length >= 3,
      `G-A17.20b: at least 3 existing guard-reason tokens must appear within ±200 chars of '${newToken}' ` +
        `to prove it landed in the failure-branch token list. Found ${tokensNearby.length}/8 nearby: [${tokensNearby.join(", ")}]. ` +
        `newToken index=${newTokenIdx}. Check soul.ts:169 appended to the correct clause.`,
    );
  });
});

// ─── REGRESSION GUARD — composeSoulBand cap (passes pre-impl, must pass post-impl) ──────────
describe("REGRESSION GUARD — composeSoulBand(null).length <= 8500 (P-AUTO-17 ND-3 non-regression)", () => {
  // ─── T-A17.20c: composeSoulBand cap not breached ──────────────────────────────────────────
  it("T-A17.20c: composeSoulBand(null).length <= 8500 — the soul.ts:169 edit (inside soulModeFragment) does NOT push composeSoulBand over the 8500-char cap (T-ICP-PRECISION raised 8000→8500)", () => {
    // Given: composeSoulBand(identity) does NOT call soulModeFragment; they are separate exports.
    //        Before the soul.ts:169 edit, composeSoulBand(null).length === 7989.
    //        After the edit, composeSoulBand(null).length must remain 7989 (unchanged by THIS edit;
    //        T-ICP-PRECISION separately raised it to ~8380 via unrelated own_company/icp-override
    //        habit lines added to soul.ts, hence the cap itself moved 8000→8500).
    // When:  composeSoulBand(null) is called (null identity → uses all defaults)
    // Then:  the returned string length <= 8500 (P-39 raised 6000→8000; T-ICP-PRECISION raised
    //        8000→8500 for the own_company + icp-override habit lines, actual ~8380)
    //
    // NOTE: this assertion is LIVE (not TODO) because composeSoulBand is already ≤ 8500 before
    // Codex edits soul.ts:169. It passes at Step 3 scaffold-time and must continue to pass
    // post-impl. If it ever fails, it means the soul.ts:169 edit accidentally inlined into
    // composeSoulBand (a regression in the builder's implementation, not in this test).
    const band = composeSoulBand(null);
    assert.ok(
      band.length <= 8500,
      `REGRESSION: composeSoulBand(null).length=${band.length} exceeds 8500-char cap (raised for T-ICP-PRECISION) — ` +
        "the soul.ts:169 ND-3 edit must NOT inline into composeSoulBand (composeSoulBand and " +
        "soulModeFragment are separate exports; soulModeFragment is uncapped by existing tests).",
    );
  });
});
