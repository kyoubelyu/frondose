/** P-28: `identityRecordSchema` and related schemas extracted from identity.ts.
 *
 *  Both `config.ts` (needs `identityRecordSchema` for `configJsonSchemaV2`) and
 *  `identity.ts` (shim needs `readConfig` from `config.ts`) import from here.
 *  This file has NO imports from config.ts or identity.ts — dependency edge is
 *  one-way, breaking the potential circular import (D-4 / §9 R-3).
 *
 *  `identity.ts` re-exports all names below so existing `from "./identity.js"`
 *  import sites keep compiling unchanged (D-6 pattern).
 *
 *  Builder Step 4b: move schema DEFINITIONS from identity.ts to this file and
 *  add re-export block to identity.ts. The implementations of `missingIdentityFields`
 *  and `applyIdentityPatch` STAY in identity.ts (logic, not schema).
 */
import { z } from "zod";
import { freeAxesSchema } from "../methodology/freeAxes.js";

export const icpSchema = z.object({
  targetRole: z.string().trim().min(1).array().min(1),
  industry: z.string().trim().min(1).array().min(1).optional(),
  region: z.string().trim().min(1).array().min(1).optional(),
  companyNameKeywords: z.string().trim().min(1).array().min(1).optional(),
});
export type IcpCriteria = z.infer<typeof icpSchema>;

export const identityFieldNames = ["fullName", "profileUrl", "persona", "company", "role", "contact", "style"] as const;
export type IdentityFieldName = (typeof identityFieldNames)[number];

export const identityRecordSchema = z.object({
  fullName: z.string().trim().min(1).optional(),
  profileUrl: z.string().trim().url().optional(),
  headline: z.string().trim().min(1).optional(),
  persona: z.string().trim().min(1).optional(),
  company: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1).optional(),
  contact: z.string().trim().min(1).optional(),
  style: z.string().trim().min(1).optional(),
  icp: icpSchema.optional(),
  freeAxes: freeAxesSchema.optional(),
  updatedAt: z.string().min(1),
});
export type IdentityRecord = z.infer<typeof identityRecordSchema>;

export const identityPatchSchema = identityRecordSchema.omit({ updatedAt: true }).partial();
export type IdentityPatch = z.infer<typeof identityPatchSchema>;
