/**
 * P-5 methodology layer — internal-facing module.
 * Consumed by src/agent/systemPrompt/soul.ts (Soul band composer) and
 * src/tools/methodology/qualifyProfile.ts (qualify_profile tool).
 * NOT re-exported from src/index.ts — methodology stays internal per scope discipline.
 */
export { METHODOLOGY_DISTILLATION } from "./distill.js";
export {
  FREE_AXES,
  FREE_AXIS_DEFAULTS,
  formatAxisOptionsForPrompt,
  freeAxesSchema,
  getAxisOptionMeaning,
} from "./freeAxes.js";
export { deriveQualificationFromMatch, matchIcp, tokenizeRoleQuery } from "./icpMatcher.js";
export type {
  FreeAxesRecord,
  FreeAxisDefinition,
  FreeAxisKey,
  FreeAxisOption,
  IcpDimension,
  IcpDimensionStatus,
  IcpEvidence,
  IcpMatchDetail,
  IdentityRecordExtended,
  MatchResult,
  Qualification,
} from "./types.js";
export { icpDimensionSchema, icpMatchDetailSchema, qualificationSchema } from "./types.js";
