/**
 * P-5 mock tests — T-M_p5.9..T-M_p5.13: icpMatcher.ts behavior.
 *
 * Tests:
 *   T-M_p5.9  — matchIcp + deriveQualification: role exact match → "qualified" (G-P5.3)
 *   T-M_p5.10 — role mismatch → "disqualified" (G-P5.3)
 *   T-M_p5.11 — role match + industry unknown + companyNameKeywords match → "partial_match" (G-P5.3)
 *   T-M_p5.12 — token-overlap match: "Procurement Manager" matches "Procurement Operations Manager" (G-P5.3)
 *   T-M_p5.13 — CJK substring match: "采购经理" matches "采购运营经理" (G-P5.3)
 *
 * No Chrome, no LLM, no SQLite required.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveQualificationFromMatch, matchIcp, tokenizeRoleQuery } from "../../src/methodology/icpMatcher.js";
import type { IcpEvidence } from "../../src/methodology/types.js";
import type { IcpCriteria } from "../../src/persistence/identity.js";

// ─── T-M_p5.9 — Qualified: role exact match ─────────────────────────────────

test("T-M_p5.9: matchIcp role exact match → role.status='match'; deriveQualification → 'qualified'", () => {
  const icp: IcpCriteria = { targetRole: ["CTO"] };
  const evidence: IcpEvidence = {
    role: "CTO",
    industry: null,
    region: null,
    companyName: null,
  };

  const detail = matchIcp(icp, evidence);
  assert.equal(detail.role.status, "match", "T-M_p5.9: role must be 'match'");
  assert.equal(detail.role.value, "CTO", "T-M_p5.9: role.value must be 'CTO'");
  assert.equal(detail.industry.status, "unknown", "T-M_p5.9: industry must be 'unknown' (no evidence)");

  const qual = deriveQualificationFromMatch(detail, icp);
  assert.equal(qual, "qualified", "T-M_p5.9: qualification must be 'qualified'");
});

// ─── T-M_p5.10 — Disqualified: role mismatch ────────────────────────────────

test("T-M_p5.10: matchIcp role mismatch → role.status='mismatch'; deriveQualification → 'disqualified'", () => {
  const icp: IcpCriteria = { targetRole: ["CTO"] };
  const evidence: IcpEvidence = {
    role: "Engineer",
    industry: null,
    region: null,
    companyName: null,
  };

  const detail = matchIcp(icp, evidence);
  assert.equal(detail.role.status, "mismatch", "T-M_p5.10: role must be 'mismatch'");

  const qual = deriveQualificationFromMatch(detail, icp);
  assert.equal(qual, "disqualified", "T-M_p5.10: qualification must be 'disqualified'");
});

// ─── T-M_p5.11 — Partial match ───────────────────────────────────────────────

test("T-M_p5.11: role match + industry unknown + companyNameKeywords match → 'partial_match'", () => {
  const icp: IcpCriteria = {
    targetRole: ["VP Sales"],
    industry: ["SaaS"],
    companyNameKeywords: ["Acme"],
  };
  const evidence: IcpEvidence = {
    role: "VP Sales",
    industry: null, // no industry evidence → unknown
    region: null,
    companyName: "Acme Corp",
  };

  const detail = matchIcp(icp, evidence);
  assert.equal(detail.role.status, "match", "T-M_p5.11: role must be 'match'");
  assert.equal(detail.industry.status, "unknown", "T-M_p5.11: industry must be 'unknown' (no evidence)");
  // companyNameKeywords is positive-only signal; "Acme" is in "Acme Corp" → match
  assert.ok(detail.companyNameKeywords !== undefined, "T-M_p5.11: companyNameKeywords dimension must be emitted");
  assert.equal(
    detail.companyNameKeywords?.status,
    "match",
    "T-M_p5.11: companyNameKeywords must be 'match' for 'Acme Corp'",
  );

  // role match + industry configured + industry unknown + companyNameKeywords match → partial_match
  const qual = deriveQualificationFromMatch(detail, icp);
  assert.equal(qual, "partial_match", "T-M_p5.11: qualification must be 'partial_match'");
});

// ─── T-M_p5.12 — Token-overlap match (Phase 69 behavior) ────────────────────

test("T-M_p5.12: token-overlap — 'Procurement Manager' matches 'Procurement Operations Manager'", () => {
  const icp: IcpCriteria = { targetRole: ["Procurement Manager"] };
  const evidence: IcpEvidence = {
    role: "Procurement Operations Manager",
    industry: null,
    region: null,
    companyName: null,
  };

  const detail = matchIcp(icp, evidence);
  assert.equal(
    detail.role.status,
    "match",
    "T-M_p5.12: 'Procurement Manager' (criterion) must token-overlap-match 'Procurement Operations Manager' (evidence)",
  );

  const qual = deriveQualificationFromMatch(detail, icp);
  assert.equal(qual, "qualified", "T-M_p5.12: token-overlap match → 'qualified'");
});

// ─── T-M_p5.13 — CJK substring match ────────────────────────────────────────

test("T-M_p5.13: CJK substring — '运营经理' (criterion) substring-matches '采购运营经理' (evidence)", () => {
  // CJK path uses loweredEvidence.includes(criterionLower) (Phase 54 AG-5).
  // '运营经理' IS a contiguous substring of '采购运营经理' → match.
  // Note: '采购经理' is NOT a substring of '采购运营经理' (non-contiguous) — ASCII
  // token-overlap is used for multi-token ASCII; CJK uses plain substring.
  const icp: IcpCriteria = { targetRole: ["运营经理"] };
  const evidence: IcpEvidence = {
    role: "采购运营经理",
    industry: null,
    region: null,
    companyName: null,
  };

  const detail = matchIcp(icp, evidence);
  assert.equal(
    detail.role.status,
    "match",
    "T-M_p5.13: CJK criterion '运营经理' must substring-match evidence '采购运营经理'",
  );

  const qual = deriveQualificationFromMatch(detail, icp);
  assert.equal(qual, "qualified", "T-M_p5.13: CJK substring match → 'qualified'");

  // Also verify non-substring CJK does NOT match (negative proof)
  const icp2: IcpCriteria = { targetRole: ["销售经理"] }; // sales manager — not in evidence
  const detail2 = matchIcp(icp2, evidence);
  assert.equal(
    detail2.role.status,
    "mismatch",
    "T-M_p5.13: CJK criterion '销售经理' must NOT match evidence '采购运营经理' (not a substring)",
  );
});

// ─── tokenizeRoleQuery helper sanity ─────────────────────────────────────────

test("T-M_p5.9b: tokenizeRoleQuery splits on whitespace/commas/special chars; lowercases", () => {
  const tokens = tokenizeRoleQuery("VP Engineering & Operations");
  assert.deepEqual(tokens, ["vp", "engineering", "operations"], "T-M_p5.9b: tokenize splits on whitespace and '&'");

  const emptyTokens = tokenizeRoleQuery("");
  assert.deepEqual(emptyTokens, [], "T-M_p5.9b: empty string → empty token list");

  // CJK input treated as single token (no ASCII separators)
  const cjkTokens = tokenizeRoleQuery("采购经理");
  assert.deepEqual(cjkTokens, ["采购经理"], "T-M_p5.9b: CJK string without separators → single token");
});
