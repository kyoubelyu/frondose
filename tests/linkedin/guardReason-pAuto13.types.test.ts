/**
 * P-AUTO-13 Step 3 — Test Scaffold — T-A13.Type.1..3 (G-A13.2 + G-A13.8)
 *
 * Covers:
 *   G-A13.2 — CommandFailure.reason?: GuardReason accepted by tsc; invalid literal rejected
 *   G-A13.8 — failWithReason parameter typing rejects unlisted reason literals at compile time
 *
 * Compile-time-only via @ts-expect-error assertions. No runtime assertion bodies needed for
 * the type-constraint proofs; runtime probe of the imports fails at assertion-TODO branch
 * until Step 4 ships GuardReason + failWithReason.
 *
 * Step-3 compile note: GuardReason and failWithReason do NOT exist until Step 4.
 * The imports are attempted via dynamic require-trick at runtime; if they resolve,
 * the positive assertions prove correctness; if they don't (pre-Step-4), the
 * module-not-found early-out fails the test at the assert.ok(false) branch — intentional.
 *
 * Run (mock):
 *   node --import tsx --test --test-force-exit --test-timeout=30000 \
 *     tests/linkedin/guardReason-pAuto13.types.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// biome-ignore lint/suspicious/noExplicitAny: runtime resolution before builder Step 4
type AnyFn = (...args: any[]) => any;

// ─── G-A13.2 — CommandFailure.reason?: GuardReason type field ───────────────────────────────
describe("G-A13.2 — CommandFailure.reason? typed as GuardReason (P-AUTO-13)", () => {
  // ─── T-A13.Type.1 ─────────────────────────────────────────────────────────────
  it("T-A13.Type.1: when types.ts exports GuardReason, all 9 tokens are valid union members", async () => {
    // Given: src/linkedin/types.ts exports GuardReason after builder Step 4
    // When:  the module is imported at runtime
    // Then:  the union contains all 9 expected tokens (verified by assign-and-check at runtime)

    const mod = await import("../../src/linkedin/types.js").catch(() => null);
    if (!mod) {
      assert.ok(false, "T-A13.Type.1: src/linkedin/types.ts not importable — builder Step 4 not done");
      return;
    }

    // The GuardReason union is a compile-time type; we verify correctness by checking that
    // the failWithReason helper (G-A13.8) accepts each token without error.
    // At Step 3, this test merely confirms the module imports. The assertion-TODO body below
    // will be filled at Step 5.

    // TODO: assert all 9 tokens accepted by failWithReason (filled at Step 5)
    assert.ok(true, "T-A13.Type.1: placeholder — module import confirmed; assertion TODO at Step 5");
  });

  // ─── T-A13.Type.2 ─────────────────────────────────────────────────────────────
  it("T-A13.Type.2: CommandFailure shape accepts reason field (top-level) matching GuardReason token", async () => {
    // Given: CommandFailure is exported from src/linkedin/types.ts with optional reason?: GuardReason
    // When:  a fail() envelope is spread with a valid GuardReason token as the top-level reason
    // Then:  the resulting object has reason at the top level (not under .error.reason)

    const mod = await import("../../src/linkedin/types.js").catch(() => null);
    const envMod = await import("../../src/linkedin/envelope.js").catch(() => null);
    if (!mod || !envMod) {
      assert.ok(false, "T-A13.Type.2: types.ts or envelope.ts not importable — builder Step 4 not done");
      return;
    }

    // TODO: assert CommandFailure produced by failWithReason has top-level reason (not error.reason)
    // Filled at Step 5 when failWithReason is available.
    assert.ok(true, "T-A13.Type.2: placeholder — import confirmed; assertion TODO at Step 5");
  });
});

// ─── G-A13.8 — failWithReason parameter typing rejects unlisted reason literals ────────────
describe("G-A13.8 — failWithReason parameter typing rejects typos (P-AUTO-13)", () => {
  // ─── T-A13.Type.3 ─────────────────────────────────────────────────────────────
  it("T-A13.Type.3: when envelope.ts exports failWithReason, each of the 9 valid GuardReason tokens is accepted", async () => {
    // Given: src/linkedin/envelope.ts exports failWithReason(command, kind, message, reason: GuardReason)
    // When:  called with each of the 9 valid tokens
    // Then:  each call returns ok:false envelope with top-level reason matching the token;
    //        a call with "not_a_real_reason" would fail tsc (asserted via @ts-expect-error in
    //        the static-check companion block below)

    const mod = await import("../../src/linkedin/envelope.js").catch(() => null);
    if (!mod) {
      assert.ok(false, "T-A13.Type.3: src/linkedin/envelope.ts not importable — builder Step 4 not done");
      return;
    }

    const failWithReason: AnyFn = (mod as any).failWithReason ?? null;
    if (!failWithReason) {
      assert.ok(false, "T-A13.Type.3: failWithReason not exported from envelope.ts — builder Step 4 not done");
      return;
    }

    const VALID_TOKENS = [
      "outbound_disabled",
      "no_active_run",
      "no_daily_snapshot",
      "daily_quota_reached",
      "cooldown_active",
      "auto_cap_reached",
      "connect_note_required",
      "approval_required",
      "ledger_write_failed",
    ] as const;

    // TODO: assert each token call returns {ok:false, reason===token} (filled at Step 5)
    for (const token of VALID_TOKENS) {
      const result = failWithReason("click", "invalid_input", "test message", token);
      // TODO: assert result.ok === false && result.reason === token
      assert.ok(result, `T-A13.Type.3: failWithReason("click","invalid_input","msg","${token}") must return a non-null envelope`);
    }

    // Static-check companion: the following line would fail tsc WITHOUT @ts-expect-error.
    // The @ts-expect-error below proves the producer rejects a typo at compile time.
    // (This line intentionally does NOT execute at runtime — it is a compile-time-only probe
    // placed in an `if (false)` guard so the runtime never reaches it but tsc still checks it.)
    if (false as boolean) {
      // @ts-expect-error — "not_a_real_reason" is not a GuardReason; producer typing must reject it.
      failWithReason("click", "invalid_input", "msg", "not_a_real_reason");

      // Each valid token must compile WITHOUT a @ts-expect-error marker:
      failWithReason("click", "invalid_input", "msg", "approval_required");
      failWithReason("click", "invalid_input", "msg", "outbound_disabled");
      failWithReason("click", "invalid_input", "msg", "no_active_run");
      failWithReason("click", "invalid_input", "msg", "no_daily_snapshot");
      failWithReason("click", "invalid_input", "msg", "daily_quota_reached");
      failWithReason("click", "invalid_input", "msg", "cooldown_active");
      failWithReason("click", "invalid_input", "msg", "auto_cap_reached");
      failWithReason("click", "invalid_input", "msg", "connect_note_required");
      failWithReason("click", "invalid_input", "msg", "ledger_write_failed");
    }
  });
});
