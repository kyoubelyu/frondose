import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import {
  applyIdentityPatch,
  icpSchema,
  identityPatchSchema,
  identityRecordSchema,
  missingIdentityFields,
  readIdentity,
  writeIdentity,
} from "../../persistence/identity.js";

const identityToolParams = z.object({
  fullName: z.string().trim().min(1).optional().describe("Operator's full name."),
  profileUrl: z.string().trim().url().optional().describe("Operator's LinkedIn profile URL."),
  headline: z.string().trim().min(1).optional().describe("Operator's headline (used by P-5 soul band)."),
  persona: z.string().trim().min(1).optional().describe("Free-form persona description."),
  company: z.string().trim().min(1).optional().describe("Operator's company name."),
  role: z.string().trim().min(1).optional().describe("Operator's role/title."),
  contact: z.string().trim().min(1).optional().describe("Contact info (email, phone, etc.)."),
  style: z.string().trim().min(1).optional().describe("Communication-style description."),
  icp: icpSchema
    .optional()
    .describe("ICP criteria — at least targetRole; industry/region/companyNameKeywords optional."),
});

export function makeIdentityTool(identityPath: string) {
  return tool({
    description:
      "Update the operator's identity record. Pass any subset of fields; existing fields are preserved. " +
      "If the operator hasn't provided a value, ASK them in conversation first — do NOT call this tool with placeholder data.",
    parameters: identityToolParams,
    execute: async (input) => {
      try {
        const patch = identityPatchSchema.parse(input);
        const existing = readIdentity(identityPath) ?? {};
        const merged = applyIdentityPatch(existing, patch);
        const record = identityRecordSchema.parse({
          ...merged,
          updatedAt: new Date().toISOString(),
        });
        writeIdentity(record, identityPath);
        return ok("identity", {
          record,
          missing: missingIdentityFields(record),
        });
      } catch (e) {
        return failFromError("identity", e);
      }
    },
  });
}
