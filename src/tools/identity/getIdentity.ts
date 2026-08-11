import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";
import { identityFieldNames, missingIdentityFields, readIdentity } from "../../persistence/identity.js";

export function makeGetIdentityTool(configPath: string) {
  return tool({
    description: "Read the operator's current identity record. Returns null if not yet bootstrapped.",
    parameters: z.object({}),
    execute: async () => {
      try {
        const record = readIdentity(configPath);
        // Per guardian critic NIT-3: spread the imported `identityFieldNames` constant rather than
        // hardcoding the literal array — keeps the fallback in lockstep with the source of truth.
        const missing = record ? missingIdentityFields(record) : [...identityFieldNames];
        return ok("getIdentity", { record, missing });
      } catch (e) {
        return failFromError("getIdentity", e);
      }
    },
  });
}
