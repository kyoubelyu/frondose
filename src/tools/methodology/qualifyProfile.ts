import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import { deriveQualificationFromMatch, matchIcp } from "../../methodology/icpMatcher.js";
import type { IcpEvidence, MatchResult, Qualification } from "../../methodology/types.js";
import type { IcpCriteria, IdentityRecord } from "../../persistence/identity.js";
import { icpSchema, readIdentity } from "../../persistence/identity.js";

const qualifyProfileParams = z.object({
  role: z.string().optional().describe("Profile role/title extracted from inspect snapshot."),
  industry: z.string().optional().describe("Company / industry from inspect snapshot."),
  region: z.string().optional().describe("Location / region from inspect snapshot."),
  companyName: z.string().optional().describe("Company name for companyNameKeywords matching."),
  icp: icpSchema.optional().describe("ICP override. Defaults to operator's identity.json ICP if omitted."),
});

const QUALIFICATION_SCORE_MAP: Record<Qualification, number> = {
  qualified: 1.0,
  partial_match: 0.75,
  tracked: 0.4,
  unknown: 0.2,
  disqualified: 0.0,
};

interface QualifyProfileOpts {
  identityPath: string;
}

/**
 * Build the qualify_profile Vercel tool. Reads operator's identity.json ICP
 * lazily on first invocation per process; caches in closure.
 *
 * The LLM extracts role/industry/region/companyName from inspect output and
 * feeds them into qualify_profile; missing evidence → "unknown" for that dim.
 */
export function makeQualifyProfileTool(opts: QualifyProfileOpts) {
  let cachedIdentity: IdentityRecord | null | undefined;
  const getDefaultIcp = (): IcpCriteria | undefined => {
    if (cachedIdentity === undefined) cachedIdentity = readIdentity(opts.identityPath);
    return cachedIdentity?.icp;
  };

  return tool({
    description:
      "Qualify a LinkedIn profile against the operator's ICP. Pass role/industry/region/companyName " +
      "extracted from the inspect snapshot. Returns qualification (qualified/partial_match/tracked/" +
      "unknown/disqualified), score 0..1, matched dimensions, missing dimensions, and rationale. " +
      "Defaults to identity.json ICP when 'icp' arg is absent.",
    parameters: qualifyProfileParams,
    execute: async (params) => {
      try {
        const icp = params.icp ?? getDefaultIcp();
        if (!icp) {
          return ok("qualify_profile", {
            qualification: "unknown" as Qualification,
            score: 0.2,
            matched: [],
            missing: ["role", "industry", "region", "companyNameKeywords"],
            rationale:
              "No ICP configured (identity.json has no .icp block, no override provided). Run `mai soul edit` to set ICP.",
            detail: undefined,
          });
        }

        const evidence: IcpEvidence = {
          role: params.role ?? null,
          industry: params.industry ?? null,
          region: params.region ?? null,
          companyName: params.companyName ?? null,
        };

        const detail = matchIcp(icp, evidence);
        const qualification = deriveQualificationFromMatch(detail, icp);
        const score = QUALIFICATION_SCORE_MAP[qualification];

        const matched: string[] = [];
        const missing: string[] = [];
        const dimensions = ["role", "industry", "region", "companyNameKeywords"] as const;
        for (const d of dimensions) {
          const dim = detail[d];
          if (!dim) continue;
          if (dim.status === "match") matched.push(d);
          if (dim.status === "unknown" && isDimensionConfigured(icp, d)) missing.push(d);
        }

        const rationale = buildRationale(qualification, detail, evidence);

        const result: MatchResult = { qualification, score, matched, missing, rationale, detail };
        // Spread to widen MatchResult into a Record-compatible payload for ok<T>().
        return ok("qualify_profile", { ...result });
      } catch (e) {
        return failFromError("qualify_profile", e);
      }
    },
  });
}

function isDimensionConfigured(icp: IcpCriteria, dim: "role" | "industry" | "region" | "companyNameKeywords"): boolean {
  if (dim === "role") return icp.targetRole.length > 0;
  if (dim === "industry") return (icp.industry?.length ?? 0) > 0;
  if (dim === "region") return (icp.region?.length ?? 0) > 0;
  if (dim === "companyNameKeywords") return (icp.companyNameKeywords?.length ?? 0) > 0;
  return false;
}

function buildRationale(
  qualification: Qualification,
  detail: ReturnType<typeof matchIcp>,
  evidence: IcpEvidence,
): string {
  const parts: string[] = [`qualification=${qualification}`];
  parts.push(`role: ${detail.role.status} (${evidence.role ?? "no evidence"})`);
  parts.push(`industry: ${detail.industry.status} (${evidence.industry ?? "no evidence"})`);
  parts.push(`region: ${detail.region.status} (${evidence.region ?? "no evidence"})`);
  if (detail.companyNameKeywords) {
    parts.push(`companyNameKeywords: ${detail.companyNameKeywords.status} (${evidence.companyName ?? "no evidence"})`);
  }
  return parts.join("; ");
}
