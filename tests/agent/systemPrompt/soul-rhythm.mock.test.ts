/**
 * P-24 Step 4a scaffolds — soul-band day-rhythm expansion
 *
 * Tests the new §7 day-rhythm block in composeSoulBand:
 *   - Heading: "Day rhythm — when a [TIME HH:MM] cron tick arrives:"
 *   - Five time-range entries: [TIME 06:00–11:59], [TIME 12:00–13:59],
 *     [TIME 14:00–17:59], [TIME 18:00–23:59], [TIME 00:00–05:59]
 *   - Old "Daily rhythm: Morning — ..." sentence is GONE from mission paragraph
 *   - Soul band character count stays within ~800-token budget (<6000 chars)
 *
 * All assertion bodies are TODO; tests intentionally fail until Step 5.
 *
 * Gate coverage:
 *   G-P24.13 — T-SOUL.RHYTHM.1, T-SOUL.RHYTHM.2, T-SOUL.RHYTHM.3, T-SOUL.RHYTHM.4
 *
 * No Chrome, no LLM required.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeSoulBand } from "../../../src/agent/systemPrompt/soul.js";
import type { IdentityRecord } from "../../../src/persistence/identity.js";

// ─── minimal identity fixture ─────────────────────────────────────────────────

const MINIMAL_IDENTITY: IdentityRecord = {
  fullName: "Test Operator",
  role: "BD",
  company: "TestCo",
  persona: "You do outbound sales",
  icp: {
    targetRole: ["VP Sales"],
    industry: ["SaaS"],
  },
  style: "Direct",
  freeAxes: {
    pain_chain_lean: "tech",
    lead_role: "champion",
    discovery_lean: "problem",
    story_shape: "spark",
  },
};

// ─── T-SOUL.RHYTHM.1 ─────────────────────────────────────────────────────────

describe("composeSoulBand — day rhythm heading present (G-P24.13)", () => {
  it("T-SOUL.RHYTHM.1: when composeSoulBand called with identity, output contains 'Day rhythm — when a [TIME HH:MM] cron tick arrives:' heading", () => {
    // Given: minimal IdentityRecord with all required axes
    // When:  composeSoulBand(MINIMAL_IDENTITY)
    // Then:  output contains the literal string 'Day rhythm — when a [TIME HH:MM] cron tick arrives'
    const result = composeSoulBand(MINIMAL_IDENTITY);
    assert.ok(
      result.includes("Day rhythm — when a [TIME HH:MM] cron tick arrives"),
      `T-SOUL.RHYTHM.1: output must contain day-rhythm heading; got (first 200 chars): "${result.slice(0, 200)}"`,
    );
  });
});

// ─── T-SOUL.RHYTHM.2 ─────────────────────────────────────────────────────────

describe("composeSoulBand — all five [TIME HH:MM-HH:MM] range entries present (G-P24.13)", () => {
  it("T-SOUL.RHYTHM.2: when composeSoulBand called, output contains all five time-range entries", () => {
    // Given: minimal identity
    // When:  composeSoulBand(MINIMAL_IDENTITY)
    // Then:  output contains all five entries:
    //        '[TIME 06:00–11:59]', '[TIME 12:00–13:59]', '[TIME 14:00–17:59]',
    //        '[TIME 18:00–23:59]', '[TIME 00:00–05:59]'
    const result = composeSoulBand(MINIMAL_IDENTITY);
    const expectedRanges = [
      "[TIME 06:00–11:59]", // en dash U+2013
      "[TIME 12:00–13:59]",
      "[TIME 14:00–17:59]",
      "[TIME 18:00–23:59]",
      "[TIME 00:00–05:59]",
    ];
    for (const range of expectedRanges) {
      assert.ok(result.includes(range), `T-SOUL.RHYTHM.2: output must contain "${range}"`);
    }
  });
});

// ─── T-SOUL.RHYTHM.3 ─────────────────────────────────────────────────────────

describe("composeSoulBand — old 'Daily rhythm: Morning ...' sentence removed (G-P24.13)", () => {
  it("T-SOUL.RHYTHM.3: when composeSoulBand called, output does NOT contain the old 'Daily rhythm: Morning — search + qualify.' string (regression check)", () => {
    // Given: minimal identity
    // When:  composeSoulBand(MINIMAL_IDENTITY)
    // Then:  output does NOT contain 'Daily rhythm: Morning — search + qualify.'
    //        (the old one-liner from soul.ts:90 is removed and replaced by §7 day-rhythm block)
    const result = composeSoulBand(MINIMAL_IDENTITY);
    assert.ok(
      !result.includes("Daily rhythm: Morning"),
      "T-SOUL.RHYTHM.3: old 'Daily rhythm: Morning' sentence must NOT appear in soul band output",
    );
  });
});

// ─── T-SOUL.RHYTHM.4 ─────────────────────────────────────────────────────────

describe("composeSoulBand — total character count within soul budget (G-P24.13)", () => {
  it("T-SOUL.RHYTHM.4: when composeSoulBand called, result.length < 6000 characters (proxy for ~800-token Soul budget)", () => {
    // Given: minimal identity
    // When:  composeSoulBand(MINIMAL_IDENTITY)
    // Then:  result.length < 6000 (GQ-6 validator: +75 token day-rhythm block stays in budget)
    const result = composeSoulBand(MINIMAL_IDENTITY);
    assert.ok(
      result.length < 6000,
      `T-SOUL.RHYTHM.4: soul band must be < 6000 chars (token budget); got ${result.length}`,
    );
  });
});
