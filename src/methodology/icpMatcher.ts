import type { IcpCriteria } from "../persistence/identity.js";
import type { IcpDimensionStatus, IcpEvidence, IcpMatchDetail, Qualification } from "./types.js";

// Phase 69 (69.1) — token-overlap match on the ASCII path. Replaces the
// Phase 52 `\b` regex matcher to handle multi-word criteria fragments.
//
// Behaviour table (ASCII):
//   - "Procurement Manager" vs "Procurement Operations Manager" => match
//   - "CTO" vs "Director" => mismatch
//   - "VP Engineering" vs "VP Marketing" => mismatch
//   - "Manager" vs "Project Manager" => match (single-token criteria match by design)
//
// CJK / non-ASCII path is unchanged (substring fallback per Phase 54 AG-5).

// Token separator: whitespace + ',' + '*' + '-' + '/' + '&'.
// Apostrophe / underscore / dot / digits stay within tokens.
const ROLE_TOKEN_SPLIT = /[\s,*\-/&]+/;

/** Split a role/industry/region query string into lowercase tokens for overlap matching. */
export function tokenizeRoleQuery(value: string): string[] {
  return value
    .toLowerCase()
    .trim()
    .split(ROLE_TOKEN_SPLIT)
    .filter((token) => token.length > 0);
}

function tokenOverlapMatch(criterion: string, evidence: string): boolean {
  const ct = tokenizeRoleQuery(criterion);
  if (ct.length === 0) return false;
  const ev = new Set(tokenizeRoleQuery(evidence));
  return ct.every((token) => ev.has(token));
}

function hasNonASCII(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 127) return true;
  }
  return false;
}

function matchesAny(evidence: string, criteria: readonly string[] | undefined): boolean {
  if (!criteria || criteria.length === 0) return false;
  const loweredEvidence = evidence.toLowerCase();
  return criteria.some((criterion) => {
    const criterionLower = criterion.toLowerCase().trim();
    if (criterionLower.length === 0) return false;
    if (hasNonASCII(criterionLower) || hasNonASCII(loweredEvidence)) {
      return loweredEvidence.includes(criterionLower);
    }
    return tokenOverlapMatch(criterionLower, loweredEvidence);
  });
}

function matchCompanyKeywords(
  evidenceValue: string | null,
  keywords: readonly string[] | undefined,
): IcpDimensionStatus {
  if (evidenceValue === null || evidenceValue.trim().length === 0) return "unknown";
  if (!keywords || keywords.length === 0) return "unknown";
  const lowered = evidenceValue.toLowerCase();
  const hit = keywords.some((kw) => lowered.includes(kw.toLowerCase().trim()));
  return hit ? "match" : "unknown"; // positive-only — never "mismatch"
}

/** Match ICP against profile evidence; returns per-dimension detail. */
export function matchIcp(icp: IcpCriteria, evidence: IcpEvidence): IcpMatchDetail {
  // Role
  let roleStatus: IcpDimensionStatus = "unknown";
  if (evidence.role !== null && evidence.role.trim().length > 0) {
    roleStatus = matchesAny(evidence.role, icp.targetRole) ? "match" : "mismatch";
  }
  // Industry
  let industryStatus: IcpDimensionStatus = "unknown";
  if (evidence.industry !== null && evidence.industry.trim().length > 0 && icp.industry) {
    industryStatus = matchesAny(evidence.industry, icp.industry) ? "match" : "mismatch";
  }
  // Region
  let regionStatus: IcpDimensionStatus = "unknown";
  if (evidence.region !== null && evidence.region.trim().length > 0 && icp.region) {
    regionStatus = matchesAny(evidence.region, icp.region) ? "match" : "mismatch";
  }
  // Company name keywords (Phase 69; positive-only signal)
  const detail: IcpMatchDetail = {
    role: { value: evidence.role, status: roleStatus },
    industry: { value: evidence.industry, status: industryStatus },
    region: { value: evidence.region, status: regionStatus },
  };
  if (icp.companyNameKeywords && icp.companyNameKeywords.length > 0) {
    detail.companyNameKeywords = {
      value: evidence.companyName,
      status: matchCompanyKeywords(evidence.companyName, icp.companyNameKeywords),
    };
  }
  return detail;
}

/**
 * Derive qualification from per-dimension match detail.
 * 5-state output (P-5 simplification: drop "tracked-drift" — that lives in driftDetector).
 *
 * Precedence (highest first per references/methodology.md:159):
 *   disqualified > qualified > partial_match > tracked > unknown
 */
export function deriveQualificationFromMatch(match: IcpMatchDetail, icp: IcpCriteria): Qualification {
  // Disqualified: any configured dimension is "mismatch".
  // (Note: companyNameKeywords is positive-only, so it can't disqualify.)
  if (match.role.status === "mismatch") return "disqualified";
  if (match.industry.status === "mismatch") return "disqualified";
  if (match.region.status === "mismatch") return "disqualified";

  // Configured-dimension counts.
  const hasIndustry = (icp.industry?.length ?? 0) > 0;
  const hasRegion = (icp.region?.length ?? 0) > 0;
  const hasCompanyKeywords = (icp.companyNameKeywords?.length ?? 0) > 0;

  // Qualified: role match + every configured secondary dimension is "match".
  if (match.role.status === "match") {
    const allSecondariesMatch =
      (!hasIndustry || match.industry.status === "match") &&
      (!hasRegion || match.region.status === "match") &&
      (!hasCompanyKeywords || match.companyNameKeywords?.status === "match");
    if (allSecondariesMatch) return "qualified";

    // Partial: role match + ≥1 secondary match + ≥1 secondary unknown.
    const secondaryStatuses: IcpDimensionStatus[] = [];
    if (hasIndustry) secondaryStatuses.push(match.industry.status);
    if (hasRegion) secondaryStatuses.push(match.region.status);
    if (hasCompanyKeywords && match.companyNameKeywords) {
      secondaryStatuses.push(match.companyNameKeywords.status);
    }
    const hasMatch = secondaryStatuses.includes("match");
    const hasUnknown = secondaryStatuses.includes("unknown");
    if (hasMatch && hasUnknown) return "partial_match";

    // role match but secondary signal is all unknown → "tracked".
    return "tracked";
  }

  // Role status is "unknown" → "unknown".
  return "unknown";
}
