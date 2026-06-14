/**
 * P-AUTO-10 Step 3 scaffold — T-Norm.1
 *
 * Regression pin: the `normalizePersonName` export (NEW in P-AUTO-10)
 * is the inner strip chain extracted from `personNameFromInviteLabel`.
 * This scaffold exercises normalizePersonName directly on BARE names
 * (without the "Invite … to connect" wrapper) and asserts the same
 * outputs the inline chain produces, proving the extraction is
 * behavior-preserving.
 *
 * IMPORTANT — REGRESSION CONTRACT (G-AUTO10.T-Norm):
 *   The EXISTING P-AUTO-6 invite-path corpus in
 *   tests/tools/browser/connectSurfaceIntegrity-pAuto6.mock.test.ts
 *   MUST continue to pass byte-identically after the builder's extraction
 *   refactor (Step 4). That file exercises personNameFromInviteLabel
 *   end-to-end (with the wrapper) — its assertions are the load-bearing
 *   outbound-cap regression pin (P-AUTO-6 depends on them). DO NOT modify
 *   that file. If ANY assertion in connectSurfaceIntegrity-pAuto6.mock.test.ts
 *   fails after the refactor, the extraction is wrong.
 *
 * All assertion bodies are TODO — tests intentionally fail at Step 3
 * because normalizePersonName does not exist until builder Step 4.
 *
 * Run (mock):
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/tools/browser/outboundGuard-pAuto10.mock.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// NOTE: normalizePersonName is NOT exported from outboundGuard.ts until
// builder Step 4. The dynamic import inside each test body allows this
// file to compile cleanly at Step 3. At runtime the import will resolve
// if the export exists, or throw if it doesn't (intended red state).

describe("T-Norm.1 — normalizePersonName extraction regression pin (P-AUTO-10)", () => {

  // ─── T-Norm.1a — baseline: plain two-word name unchanged ─────────────────
  it("T-Norm.1a: 'Onder Temel' (bare) → 'Onder Temel' (no-op on clean bare name)", async () => {
    // Given: a plain bare name with no tails, credentials, or glyphs.
    // When:  normalizePersonName("Onder Temel") called directly (not via invite wrapper)
    // Then:  returns "Onder Temel" unchanged — the strip chain is a no-op on clean input.
    const { normalizePersonName } = (await import(
      "../../../src/tools/browser/outboundGuard.js"
    )) as { normalizePersonName?: (name: string) => string };

    assert.ok(typeof normalizePersonName === "function", "TODO: normalizePersonName must be exported from outboundGuard.ts");
    // TODO (Step 5): fill assertion
    assert.strictEqual(normalizePersonName!("Onder Temel"), "Onder Temel", "TODO: plain bare name must be unchanged");
  });

  // ─── T-Norm.1b — trailing parenthetical stripped ─────────────────────────
  it("T-Norm.1b: 'Jane Doe (She/Her)' (bare) → 'Jane Doe'", async () => {
    // Given: a bare name with trailing parenthetical pronouns.
    // When:  normalizePersonName called on bare name (no "Invite … to connect" wrapper)
    // Then:  trailing parenthetical dropped, same output as invite-wrapped version
    //        tested in T-AUTO6.7d.
    const { normalizePersonName } = (await import(
      "../../../src/tools/browser/outboundGuard.js"
    )) as { normalizePersonName?: (name: string) => string };

    assert.ok(typeof normalizePersonName === "function", "TODO: normalizePersonName must be exported");
    // TODO (Step 5): fill assertion
    assert.strictEqual(normalizePersonName!("Jane Doe (She/Her)"), "Jane Doe", "TODO: trailing parenthetical must be stripped");
  });

  // ─── T-Norm.1c — credentials clause stripped ─────────────────────────────
  it("T-Norm.1c: 'Jane Doe, PhD' (bare) → 'Jane Doe' (creds clause after comma stripped)", async () => {
    // Given: a bare name with trailing credentials clause after comma.
    // When:  normalizePersonName called.
    // Then:  everything from first comma onward dropped.
    const { normalizePersonName } = (await import(
      "../../../src/tools/browser/outboundGuard.js"
    )) as { normalizePersonName?: (name: string) => string };

    assert.ok(typeof normalizePersonName === "function", "TODO: normalizePersonName must be exported");
    // TODO (Step 5): fill assertion
    assert.strictEqual(normalizePersonName!("Jane Doe, PhD"), "Jane Doe", "TODO: creds clause must be stripped");
  });

  // ─── T-Norm.1d — end-anchored degree token '1st' stripped ────────────────
  it("T-Norm.1d: 'Jane Doe 1st' (bare) → 'Jane Doe' (end-anchored degree token stripped)", async () => {
    // Given: a bare name with trailing '1st' LinkedIn connection-degree badge (no comma).
    // When:  normalizePersonName called.
    // Then:  '1st' stripped, mirrors T-AUTO6.7e result on the invite-wrapped version.
    const { normalizePersonName } = (await import(
      "../../../src/tools/browser/outboundGuard.js"
    )) as { normalizePersonName?: (name: string) => string };

    assert.ok(typeof normalizePersonName === "function", "TODO: normalizePersonName must be exported");
    // TODO (Step 5): fill assertion
    assert.strictEqual(normalizePersonName!("Jane Doe 1st"), "Jane Doe", "TODO: 1st degree token must be stripped");
  });

  // ─── T-Norm.1e — end-anchored degree token '2nd' stripped ────────────────
  it("T-Norm.1e: 'Jane Doe 2nd' (bare) → 'Jane Doe' (2nd alternation in degree regex)", async () => {
    // Given: bare name with '2nd' connection-degree badge.
    // When:  normalizePersonName called.
    // Then:  '2nd' stripped, mirrors T-AUTO6.7f.
    const { normalizePersonName } = (await import(
      "../../../src/tools/browser/outboundGuard.js"
    )) as { normalizePersonName?: (name: string) => string };

    assert.ok(typeof normalizePersonName === "function", "TODO: normalizePersonName must be exported");
    // TODO (Step 5): fill assertion
    assert.strictEqual(normalizePersonName!("Jane Doe 2nd"), "Jane Doe", "TODO: 2nd degree token must be stripped");
  });

  // ─── T-Norm.1f — emoji/badge glyph stripped ──────────────────────────────
  it("T-Norm.1f: 'Dmitry Balanovsky 🎯' (bare) → 'Dmitry Balanovsky' (non-letter glyph stripped)", async () => {
    // Given: bare name with trailing emoji badge.
    // When:  normalizePersonName called.
    // Then:  emoji stripped, leaving only letter/mark/space/.''- chars.
    const { normalizePersonName } = (await import(
      "../../../src/tools/browser/outboundGuard.js"
    )) as { normalizePersonName?: (name: string) => string };

    assert.ok(typeof normalizePersonName === "function", "TODO: normalizePersonName must be exported");
    // TODO (Step 5): fill assertion
    assert.strictEqual(normalizePersonName!("Dmitry Balanovsky 🎯"), "Dmitry Balanovsky", "TODO: emoji must be stripped");
  });

  // ─── T-Norm.1g — verification check badge stripped ───────────────────────
  it("T-Norm.1g: 'Jane Doe ✓' (bare) → 'Jane Doe' (verification checkmark stripped)", async () => {
    // Given: bare name with verification checkmark symbol.
    // When:  normalizePersonName called.
    // Then:  checkmark stripped, mirrors T-AUTO6.7g on invite-wrapped version.
    const { normalizePersonName } = (await import(
      "../../../src/tools/browser/outboundGuard.js"
    )) as { normalizePersonName?: (name: string) => string };

    assert.ok(typeof normalizePersonName === "function", "TODO: normalizePersonName must be exported");
    // TODO (Step 5): fill assertion
    assert.strictEqual(normalizePersonName!("Jane Doe ✓"), "Jane Doe", "TODO: verification glyph must be stripped");
  });

  // ─── T-Norm.1h — NFC normalization ───────────────────────────────────────
  it("T-Norm.1h: NFD-decomposed 'José Díaz' → NFC-normalized 'José Díaz'", async () => {
    // Given: NFD-decomposed accented characters in a bare name.
    // When:  normalizePersonName called.
    // Then:  result is NFC-normalized, mirrors T-AUTO6.7h.
    const { normalizePersonName } = (await import(
      "../../../src/tools/browser/outboundGuard.js"
    )) as { normalizePersonName?: (name: string) => string };

    assert.ok(typeof normalizePersonName === "function", "TODO: normalizePersonName must be exported");
    const nfd = "José Díaz".normalize("NFD");
    const expected = "José Díaz".normalize("NFC");
    // TODO (Step 5): fill assertion
    const result = normalizePersonName!(nfd);
    assert.strictEqual(result, result.normalize("NFC"), "TODO: result must already be NFC-normalized");
    assert.strictEqual(result, expected, "TODO: NFD input must produce NFC-normalized output");
  });

  // ─── T-Norm.1i — double-space collapsed ──────────────────────────────────
  it("T-Norm.1i: 'Jane  Doe' (double space) → 'Jane Doe' (internal whitespace collapsed)", async () => {
    // Given: bare name with double spaces between tokens.
    // When:  normalizePersonName called.
    // Then:  internal whitespace collapsed to single space, mirrors T-AUTO6.7i.
    const { normalizePersonName } = (await import(
      "../../../src/tools/browser/outboundGuard.js"
    )) as { normalizePersonName?: (name: string) => string };

    assert.ok(typeof normalizePersonName === "function", "TODO: normalizePersonName must be exported");
    // TODO (Step 5): fill assertion
    assert.strictEqual(normalizePersonName!("Jane  Doe"), "Jane Doe", "TODO: double space must be collapsed");
  });

  // ─── T-Norm.1j — all-emoji input → empty string ──────────────────────────
  it("T-Norm.1j: '🎯🎯🎯' (bare, all emoji) → '' (empty string after glyph strip + trim)", async () => {
    // Given: a bare name consisting entirely of emoji (no letter/mark chars).
    // When:  normalizePersonName called.
    // Then:  result is empty string '' (all glyphs stripped, nothing remains).
    //        This is the empty-set skip case for tokenSetEqual in T-Dup.7.
    const { normalizePersonName } = (await import(
      "../../../src/tools/browser/outboundGuard.js"
    )) as { normalizePersonName?: (name: string) => string };

    assert.ok(typeof normalizePersonName === "function", "TODO: normalizePersonName must be exported");
    // TODO (Step 5): fill assertion
    assert.strictEqual(normalizePersonName!("🎯🎯🎯"), "", "TODO: all-emoji input must normalize to empty string");
  });

  // ─── T-Norm.1k — leading/trailing whitespace trimmed ─────────────────────
  it("T-Norm.1k: '  Jane Doe  ' (bare with surrounding whitespace) → 'Jane Doe'", async () => {
    // Given: bare name with surrounding whitespace.
    // When:  normalizePersonName called.
    // Then:  trimmed to 'Jane Doe'.
    const { normalizePersonName } = (await import(
      "../../../src/tools/browser/outboundGuard.js"
    )) as { normalizePersonName?: (name: string) => string };

    assert.ok(typeof normalizePersonName === "function", "TODO: normalizePersonName must be exported");
    // TODO (Step 5): fill assertion
    assert.strictEqual(normalizePersonName!("  Jane Doe  "), "Jane Doe", "TODO: surrounding whitespace must be trimmed");
  });

  // ─── T-Norm.1l — Dmitry 'PhD' case matching the T-Dup.3a dedup case ──────
  it("T-Norm.1l: 'Dmitry Balanovsky, PhD' (bare) → 'Dmitry Balanovsky' (matches T-Dup.3a normalization target)", async () => {
    // Given: bare name with trailing credential clause (the exact T-Dup.3a input).
    // When:  normalizePersonName called.
    // Then:  'Dmitry Balanovsky' — confirms the strip chain produces the right dedup target.
    const { normalizePersonName } = (await import(
      "../../../src/tools/browser/outboundGuard.js"
    )) as { normalizePersonName?: (name: string) => string };

    assert.ok(typeof normalizePersonName === "function", "TODO: normalizePersonName must be exported");
    // TODO (Step 5): fill assertion
    assert.strictEqual(normalizePersonName!("Dmitry Balanovsky, PhD"), "Dmitry Balanovsky", "TODO: T-Dup.3a target");
  });

  // ─── T-Norm.1m — 'Onder Temel 1st' the P-AUTO-6 label input on bare name ─
  it("T-Norm.1m: 'Onder Temel 1st' (bare) → 'Onder Temel' (confirms dedup normalizes invite-label names correctly)", async () => {
    // Given: bare name that includes the '1st' degree badge (as would appear in
    //        a LinkedIn invite label body after the "Invite … to connect" wrapper is stripped).
    // When:  normalizePersonName called.
    // Then:  'Onder Temel' — same output that personNameFromInviteLabel produces on
    //        "Invite Onder Temel 1st to connect" (the degree strip fires in both paths).
    const { normalizePersonName } = (await import(
      "../../../src/tools/browser/outboundGuard.js"
    )) as { normalizePersonName?: (name: string) => string };

    assert.ok(typeof normalizePersonName === "function", "TODO: normalizePersonName must be exported");
    // TODO (Step 5): fill assertion
    assert.strictEqual(normalizePersonName!("Onder Temel 1st"), "Onder Temel", "TODO: degree-stripped bare name");
  });

});
