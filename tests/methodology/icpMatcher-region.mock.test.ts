/**
 * T-ICP-PRECISION Step 2 (validator, Sonnet) — scaffolds, all-failing.
 *
 * Source-under-test: `matchIcp` in `src/methodology/icpMatcher.ts` — ALREADY
 * EXISTS + already exported (no new export needed for this file). This file
 * pins the `"Global"` token-overlap leak (§0 verified) and proves the fix is
 * a DATA change (dropping `"Global"` from the standing ICP), not a code change.
 *
 * COMPILE APPROACH: plain static import of the existing `matchIcp` +
 * `IcpEvidence`/`IcpCriteria` types — no not-yet-existing symbols are touched
 * here, so this file compiles cleanly today. Evidence literals use the
 * CURRENT 4-field `IcpEvidence` shape (role/industry/region/companyName) —
 * this file does NOT exercise `companyProfileUrl` (that is T-Qualify's
 * concern, not the region dimension's). Per CLAUDE.md § Test Discipline /
 * outside-in TDD, every assertion body is still an unconditional
 * `assert.fail("TODO Step 5: …")` even though `matchIcp`'s CURRENT behavior
 * would already satisfy some of these assertions if run for real — the whole
 * Step-2 suite must be RED regardless of what happens to already work.
 *
 * Gates covered: plan §5 T-Region.1, T-Region.2 — F-10 (drop "Global" from
 * the operator's current config identity ICP.region; NOT a src/ change).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchIcp } from "../../src/methodology/icpMatcher.js";
import type { IcpEvidence } from "../../src/methodology/types.js";
import type { IcpCriteria } from "../../src/persistence/identity.js";

// ---------------------------------------------------------------------------
// T-Region.1 — "Global" token-overlap leak (pins the bug + proves the fix)
// ---------------------------------------------------------------------------

describe('matchIcp region dimension — "Global" wildcard leak + its data-fix (plan §5 T-Region.1)', () => {
  it('T-Region.1a: given icp.region=["United States","Europe","Global"] and evidence.region="Global head of Sales · APAC" (no real geographic overlap with the operator\'s targets), when matchIcp is called, then region.status is "match" — THIS PINS THE CURRENT BUG (token-overlap on the literal word "global"); it is the leak this phase\'s DATA fix (dropping "Global" from current config identity) removes', () => {
    // Given: standing ICP region list includes the accidental wildcard "Global".
    const icp: IcpCriteria = { targetRole: ["VP Sales"], region: ["United States", "Europe", "Global"] };
    const evidence: IcpEvidence = {
      role: "VP Sales",
      industry: null,
      region: "Global head of Sales · APAC",
      companyName: null,
    };

    // When: matchIcp(icp, evidence).region.status is read.
    const status = matchIcp(icp, evidence).region.status;

    // Then: status === "match" (pinning the CURRENT leaky behavior with "Global" present).
    assert.equal(
      status,
      "match",
      `matchIcp(icp, evidence).region.status pins the "Global" token-overlap leak; got ${status}`,
    );
  });

  it('T-Region.1b: given icp.region=["United States","Europe"] (NO "Global") and the SAME evidence.region="Global head of Sales · APAC", when matchIcp is called, then region.status is "mismatch" — proves dropping "Global" from the standing ICP removes the leak (F-10 data fix, verified against code)', () => {
    // Given: standing ICP region list WITHOUT "Global" (post-fix state).
    const icp: IcpCriteria = { targetRole: ["VP Sales"], region: ["United States", "Europe"] };
    const evidence: IcpEvidence = {
      role: "VP Sales",
      industry: null,
      region: "Global head of Sales · APAC",
      companyName: null,
    };

    // When: matchIcp(icp, evidence).region.status is read.
    const status = matchIcp(icp, evidence).region.status;

    // Then: status === "mismatch" (the leak is gone once "Global" is dropped).
    assert.equal(status, "mismatch", `expected the F-10 data fix to close the leak; got ${status}`);
  });
});

// ---------------------------------------------------------------------------
// T-Region.2 — legitimate US evidence still qualifies without "Global"
// ---------------------------------------------------------------------------

describe('matchIcp region dimension — legitimate in-region evidence unaffected by dropping "Global" (plan §5 T-Region.2)', () => {
  it('T-Region.2: given icp.region=["United States","Europe"] (post-fix, no "Global") and evidence.region="San Francisco Bay Area, United States", when matchIcp is called, then region.status is "match" — proves the fix does not regress legitimate in-region candidates', () => {
    // Given: standing post-fix ICP region list; a genuinely-in-region candidate.
    const icp: IcpCriteria = { targetRole: ["VP Sales"], region: ["United States", "Europe"] };
    const evidence: IcpEvidence = {
      role: "VP Sales",
      industry: null,
      region: "San Francisco Bay Area, United States",
      companyName: null,
    };

    // When: matchIcp(icp, evidence).region.status is read.
    const status = matchIcp(icp, evidence).region.status;

    // Then: status === "match".
    assert.equal(
      status,
      "match",
      `legitimate in-region candidate must be unaffected by the "Global" drop; got ${status}`,
    );
  });
});
