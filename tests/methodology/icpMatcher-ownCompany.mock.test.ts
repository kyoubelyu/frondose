/**
 * T-ICP-PRECISION Step 5 RE-VALIDATION (validator, Sonnet) — SIMPLIFIED
 * (name-only) design, per plan §13. The company-URL machinery
 * (`normalizeCompanyLinkedInUrl`, `companyLinkedInUrl`, `companyProfileUrl`)
 * was operator-directed scope creep and has been stripped entirely from
 * `src/**` (verified: `grep -rn "companyProfileUrl|companyLinkedInUrl|
 * normalizeCompanyLinkedInUrl" src/` returns nothing).
 *
 * Source-under-test: `isOwnCompanyMatch` in `src/methodology/icpMatcher.ts` —
 * NAME-ONLY, 2-arg signature: `(identity: {company?}, evidence: {companyName})
 * => boolean`.
 *
 * Gates covered: plan §5 T-OwnCompany.2, .3, .4, .NoIdCompany — F-3
 * (icpMatcher.ts helper, name-only design).
 *
 * DELETED this pass (§13 simplification — subjects no longer exist):
 *   - T-OwnCompany.1 (URL-exact match)
 *   - T-OwnCompany.5 (URL differs → false, no name fallback)
 *   - T-OwnCompany.6 (non-canonical URL suppresses name-fallback)
 *   - T-OwnCompany.7 (transition case: name-only identity + URL evidence)
 *   - T-Normalize.1 (normalizeCompanyLinkedInUrl canonicalization matrix)
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isOwnCompanyMatch } from "../../src/methodology/icpMatcher.js";

interface OwnCompanyIdentity {
  company?: string;
}
interface OwnCompanyEvidence {
  companyName: string | null;
}

// ---------------------------------------------------------------------------
// T-OwnCompany.2 — Name substring (case-insensitive) → match
// ---------------------------------------------------------------------------

describe("isOwnCompanyMatch — name-substring match (plan §5 T-OwnCompany.2)", () => {
  it("T-OwnCompany.2: given identity.company='Mastars' and evidence.companyName='mastars prototype manufacturing' (lowercase), when isOwnCompanyMatch is called, then it returns true (case-insensitive substring match)", () => {
    // Given: identity has a company name; evidence's companyName contains it
    //        (different case, extra words).
    const identity: OwnCompanyIdentity = { company: "Mastars" };
    const evidence: OwnCompanyEvidence = { companyName: "mastars prototype manufacturing" };

    // When: isOwnCompanyMatch(identity, evidence) is called.
    const result = isOwnCompanyMatch(identity, evidence);

    // Then: result === true.
    assert.equal(result, true, "name substring (case-insensitive) must match");
  });
});

// ---------------------------------------------------------------------------
// T-OwnCompany.3 — Name substring over-match on ex-employees (documented, accepted)
// ---------------------------------------------------------------------------

describe("isOwnCompanyMatch — accepted name-substring over-match on ex-employee mentions (plan §5 T-OwnCompany.3)", () => {
  it("T-OwnCompany.3: given identity.company='Mastars' and evidence.companyName='Ex-Mastars alumni network', when isOwnCompanyMatch is called, then it returns true — this is INTENTIONAL (name-match on the current-company field is a safe baseline; the over-match on ex-employees is documented + accepted per plan §7 R-3, NOT a bug to fix here)", () => {
    // Given: an ex-employee's current profile still lists "Mastars" in a
    //        company-name-like field ("Ex-Mastars alumni network").
    const identity: OwnCompanyIdentity = { company: "Mastars" };
    const evidence: OwnCompanyEvidence = { companyName: "Ex-Mastars alumni network" };

    // When: isOwnCompanyMatch(identity, evidence) is called.
    const result = isOwnCompanyMatch(identity, evidence);

    // Then: result === true (accepted over-match; DO NOT gate more tightly here).
    assert.equal(result, true, "accepted over-match per plan §7 R-3 — pins CURRENT behavior, do not tighten");
  });
});

// ---------------------------------------------------------------------------
// T-OwnCompany.4 — No evidence signal → false
// ---------------------------------------------------------------------------

describe("isOwnCompanyMatch — no evidence signal → false, no false disqualification (plan §5 T-OwnCompany.4)", () => {
  it("T-OwnCompany.4: given identity.company='Mastars' and evidence={companyName:null}, when isOwnCompanyMatch is called, then it returns false (no evidence to check → the ICP-matcher path still runs, not a false own-company hit)", () => {
    // Given: identity has a company; evidence has NO company signal at all.
    const identity: OwnCompanyIdentity = { company: "Mastars" };
    const evidence: OwnCompanyEvidence = { companyName: null };

    // When: isOwnCompanyMatch(identity, evidence) is called.
    const result = isOwnCompanyMatch(identity, evidence);

    // Then: result === false.
    assert.equal(result, false, "no evidence signal → no disqualification");
  });
});

// ---------------------------------------------------------------------------
// T-OwnCompany.NoIdCompany — identity has no company → false
// ---------------------------------------------------------------------------

describe("isOwnCompanyMatch — identity-side no-op when identity has no company field (plan §5 T-OwnCompany.NoIdCompany)", () => {
  it("T-OwnCompany.NoIdCompany: given identity={} (no company set) and evidence.companyName='Mastars Prototype', when isOwnCompanyMatch is called, then it returns false — the check is a no-op when identity has no company field to compare against", () => {
    // Given: identity has NO `company` field at all; evidence DOES carry a
    //        company-name signal that would otherwise substring-match.
    const identity: OwnCompanyIdentity = {};
    const evidence: OwnCompanyEvidence = { companyName: "Mastars Prototype" };

    // When: isOwnCompanyMatch(identity, evidence) is called.
    const result = isOwnCompanyMatch(identity, evidence);

    // Then: result === false (identity-side signal absent → no-op).
    assert.equal(result, false, "identity has no company field → own-company check is a no-op → false");
  });
});
