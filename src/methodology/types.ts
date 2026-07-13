import { z } from "zod";
import type { IcpCriteria } from "../persistence/identity.js";
import { icpSchema } from "../persistence/identity.js";

// Re-export icpSchema for downstream consumers in src/methodology/.
export { icpSchema };
export type { IcpCriteria };

/** Per-dimension match status (port of mai-linkedin Phase 52). */
export const icpDimensionStatusSchema = z.enum(["match", "mismatch", "unknown"]);
export type IcpDimensionStatus = z.infer<typeof icpDimensionStatusSchema>;

export const icpDimensionSchema = z.object({
  value: z.string().nullable(),
  status: icpDimensionStatusSchema,
});
export type IcpDimension = z.infer<typeof icpDimensionSchema>;

/** 4-dimension match detail (P-5 simplification: drop tracked-drift). */
export const icpMatchDetailSchema = z.object({
  role: icpDimensionSchema,
  industry: icpDimensionSchema,
  region: icpDimensionSchema,
  // Phase 69 (69.2) — emitted only when ICP.companyNameKeywords is configured.
  companyNameKeywords: icpDimensionSchema.optional(),
  ownCompany: icpDimensionSchema.optional(),
});
export type IcpMatchDetail = z.infer<typeof icpMatchDetailSchema>;

/**
 * 5-state qualification (P-5 simplification: drop "tracked-drift" — that's
 * driftDetector.ts's emission, separate from icpMatcher's deriveQualificationFromMatch).
 */
export const qualificationSchema = z.enum(["qualified", "partial_match", "tracked", "unknown", "disqualified"]);
export type Qualification = z.infer<typeof qualificationSchema>;

/** Live profile evidence — what the LLM extracts from `inspect` snapshot. */
export interface IcpEvidence {
  role: string | null;
  industry: string | null;
  region: string | null;
  companyName: string | null; // Phase 69 — for companyNameKeywords matching
}

/** qualify_profile tool output. */
export interface MatchResult {
  qualification: Qualification;
  score: number; // 0..1 derived from qualification
  matched: string[]; // dimension names with status="match"
  missing: string[]; // configured dimensions with status="unknown"
  rationale: string; // human-readable explanation
  detail: IcpMatchDetail; // raw per-dimension breakdown
}

/** Free axis option pool entry — from F-4-revised. */
export interface FreeAxisOption {
  key: string; // stable identifier persisted in identity.json
  meaning: string; // 1-line description shown in Soul + first-run prompt
}

/** Free axis definition (1 of 4). */
export interface FreeAxisDefinition {
  name: string; // axis key (matches FreeAxisKey union)
  description: string; // 1-line operator-facing description
  options: FreeAxisOption[];
  defaultPick: string; // option.key for default
}

/** 4 axis keys. */
export type FreeAxisKey = "pain_chain_lean" | "lead_role" | "discovery_lean" | "story_shape";

/**
 * Axes record persisted under identity.freeAxes.
 * Each value is the chosen option's `key` string.
 *
 * NOTE: The Zod schema `freeAxesSchema` lives in src/methodology/freeAxes.ts
 * (NOT in this file) to avoid a circular import: identity.ts imports from
 * freeAxes.ts; methodology/types.ts imports icpSchema from identity.ts. Keeping
 * `freeAxesSchema` in freeAxes.ts breaks the cycle.
 */
export interface FreeAxesRecord {
  pain_chain_lean: string;
  lead_role: string;
  discovery_lean: string;
  story_shape: string;
}

// Identity record extension shape — for downstream consumers that want to type-narrow.
// (The actual extended identityRecordSchema lives in src/persistence/identity.ts.)
export interface IdentityRecordExtended {
  fullName?: string;
  profileUrl?: string;
  headline?: string;
  persona?: string;
  company?: string;
  role?: string;
  contact?: string;
  style?: string;
  icp?: IcpCriteria;
  freeAxes?: FreeAxesRecord;
  updatedAt: string;
}
