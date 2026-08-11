/** P-4 identity record persistence.
 *
 *  P-28: `identityRecordSchema` + related schemas are extracted to
 *  `identitySchema.ts` (breaks the config.ts ↔ identity.ts circular import).
 *  This file re-exports them and projects identity through current config. */
import { DEFAULT_CONFIG_PATH, readConfig, writeConfig } from "./config.js";
import {
  type IcpCriteria,
  type IdentityFieldName,
  type IdentityPatch,
  type IdentityRecord,
  icpSchema,
  identityFieldNames,
  identityPatchSchema,
  identityRecordSchema,
} from "./identitySchema.js";

// P-28 re-export: keep `from "./identity.js"` imports of the schema names working.
export {
  icpSchema,
  type IcpCriteria,
  identityFieldNames,
  type IdentityFieldName,
  identityRecordSchema,
  type IdentityRecord,
  identityPatchSchema,
  type IdentityPatch,
};

/** Lists which of the 7 required-field-names are missing/empty in a record. */
export function missingIdentityFields(identity: Partial<IdentityRecord>): IdentityFieldName[] {
  return identityFieldNames.filter((field) => {
    const v = identity[field];
    return !v || (typeof v === "string" && v.trim() === "");
  });
}

/** Apply a patch over an existing identity, dropping undefined and empty-string fields. */
export function applyIdentityPatch(identity: Partial<IdentityRecord>, patch: IdentityPatch): Partial<IdentityRecord> {
  const merged = { ...identity, ...patch } as Record<string, unknown>;
  for (const k of Object.keys(merged)) {
    const v = merged[k];
    if (v === undefined || v === "") delete merged[k];
  }
  return merged as Partial<IdentityRecord>;
}

/** Read identity only from the current config authority. */
export function readIdentity(configPath: string = DEFAULT_CONFIG_PATH()): IdentityRecord | null {
  return readConfig(configPath).identity ?? null;
}

/** Write identity only through the current config authority. */
export function writeIdentity(record: IdentityRecord, configPath: string = DEFAULT_CONFIG_PATH()): void {
  const cfg = readConfig(configPath);
  writeConfig({ ...cfg, identity: record }, configPath);
}
