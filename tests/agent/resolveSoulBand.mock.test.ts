/**
 * P-28 Step 4a — T-SOUL.OVERRIDE.1..3
 *
 * Tests for resolveSoulBand() in src/agent/systemPrompt/soul.ts.
 * Gate coverage: G-P28.12 (non-null override returned verbatim),
 *                G-P28.13 (null override → composeSoulBand fallback),
 *                G-P28.13 edge (null override + null identity → placeholder soul)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as soulModule from "../../src/agent/systemPrompt/soul.js";
import type { IdentityRecord } from "../../src/persistence/identity.js";

// resolveSoulBand is exported from soul.ts (added at P-28 builder Step 4b).
// Access via namespace for nominal typing; cast ensures compilation before export is confirmed.
const getResolveSoulBand = (): ((override: string | null, identity: IdentityRecord | null) => string) =>
  (soulModule as unknown as Record<string, unknown>).resolveSoulBand as (
    override: string | null,
    identity: IdentityRecord | null,
  ) => string;

const MINIMAL_IDENTITY: IdentityRecord = {
  fullName: "BD Alice",
  updatedAt: new Date().toISOString(),
};

// ─── T-SOUL.OVERRIDE.1 ────────────────────────────────────────────────────────

describe("resolveSoulBand: non-null override returned verbatim (G-P28.12)", () => {
  it("T-SOUL.OVERRIDE.1: given override='CUSTOM SOUL TEXT' and any identity, resolveSoulBand returns 'CUSTOM SOUL TEXT' verbatim", () => {
    // Given: override = "CUSTOM SOUL TEXT"; identity = MINIMAL_IDENTITY
    // When:  resolveSoulBand(override, identity)
    // Then:  returns exactly "CUSTOM SOUL TEXT" (identity not consulted)
    const resolveSoulBand = getResolveSoulBand();
    const result = resolveSoulBand("CUSTOM SOUL TEXT", MINIMAL_IDENTITY);
    assert.equal(
      result,
      "CUSTOM SOUL TEXT",
      "T-SOUL.OVERRIDE.1: non-null override must be returned verbatim (G-P28.12)",
    );
  });
});

// Edge: empty-string override falls through to composeSoulBand (not technically a separate gate
// but validated here as a boundary case of G-P28.12's "override !== null && override.trim() !== ''" check)
describe("resolveSoulBand: empty-string override falls back to composeSoulBand (G-P28.12 edge)", () => {
  it("T-SOUL.OVERRIDE.1b: given override='' (empty string), resolveSoulBand falls back to composeSoulBand (empty string is not a valid override)", () => {
    // Given: override = "" (empty string); identity = MINIMAL_IDENTITY
    // When:  resolveSoulBand("", identity)
    // Then:  falls back to composeSoulBand(identity) — empty string is treated as absent
    const resolveSoulBand = getResolveSoulBand();
    const result = resolveSoulBand("", MINIMAL_IDENTITY);
    const expected = soulModule.composeSoulBand(MINIMAL_IDENTITY);
    assert.equal(result, expected, "T-SOUL.OVERRIDE.1b: empty-string override must fall back to composeSoulBand");
  });
});

// ─── T-SOUL.OVERRIDE.2 ────────────────────────────────────────────────────────

describe("resolveSoulBand: null override → composeSoulBand fallback (G-P28.13)", () => {
  it("T-SOUL.OVERRIDE.2: given override=null and valid identity, resolveSoulBand returns composeSoulBand(identity) (contains identity's fullName)", () => {
    // Given: override = null; identity = {fullName:"BD Alice", updatedAt:"..."}
    // When:  resolveSoulBand(null, identity)
    // Then:  result === composeSoulBand(identity); result contains "BD Alice"
    const resolveSoulBand = getResolveSoulBand();
    const result = resolveSoulBand(null, MINIMAL_IDENTITY);
    const expected = soulModule.composeSoulBand(MINIMAL_IDENTITY);
    assert.equal(result, expected, "T-SOUL.OVERRIDE.2: null override must return composeSoulBand(identity) (G-P28.13)");
    assert.ok(result.includes("BD Alice"), "T-SOUL.OVERRIDE.2: composeSoulBand result must contain identity.fullName");
  });
});

// ─── T-SOUL.OVERRIDE.3 ────────────────────────────────────────────────────────

describe("resolveSoulBand: null override + null identity → placeholder soul (G-P28.13 edge)", () => {
  it("T-SOUL.OVERRIDE.3: given override=null and identity=null, resolveSoulBand returns composeSoulBand(null) without throwing", () => {
    // Given: override = null; identity = null
    // When:  resolveSoulBand(null, null)
    // Then:  returns composeSoulBand(null) (placeholder soul band text); no throw
    const resolveSoulBand = getResolveSoulBand();
    let result: string | undefined;
    assert.doesNotThrow(() => {
      result = resolveSoulBand(null, null);
    }, "T-SOUL.OVERRIDE.3: resolveSoulBand(null, null) must not throw");
    const expected = soulModule.composeSoulBand(null);
    assert.equal(
      result,
      expected,
      "T-SOUL.OVERRIDE.3: null override + null identity must return composeSoulBand(null) (G-P28.13 edge)",
    );
    assert.ok(typeof result === "string" && result.length > 0, "T-SOUL.OVERRIDE.3: result must be a non-empty string");
  });
});
