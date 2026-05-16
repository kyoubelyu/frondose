/** P-4 identity record persistence.
 *
 *  P-28: `identityRecordSchema` + related schemas are extracted to
 *  `identitySchema.ts` (breaks the config.ts ↔ identity.ts circular import).
 *  This file re-exports them so existing `from "./identity.js"` import sites
 *  keep compiling. `readIdentity`/`writeIdentity` are now shims over
 *  `config.json.identity` (authoritative) with a legacy `identity.json` fallback. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

export const DEFAULT_IDENTITY_PATH = (): string => join(homedir(), ".mai", "agent", "identity.json");

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

/** P-28 shim: config.json.identity is authoritative; legacy identity.json is
 *  the fallback for standalone / pre-migration workers.
 *
 *  B-1: `configPath` is an optional DI parameter (defaults to DEFAULT_CONFIG_PATH()).
 *  Production callers pass nothing; mock tests pass a tmp path to isolate from the
 *  operator's live config. */
export function readIdentity(path: string = DEFAULT_IDENTITY_PATH(), configPath?: string): IdentityRecord | null {
  try {
    const cfg = readConfig(configPath ?? DEFAULT_CONFIG_PATH());
    if (cfg.identity) return cfg.identity;
  } catch {
    // fall through to legacy
  }
  return legacyReadIdentityFromFile(path);
}

/** P-28 shim: write to config.json.identity (authoritative) AND legacy
 *  identity.json (retained one phase for non-shim readers — P-29 GC).
 *
 *  B-1: `configPath` DI as above. */
export function writeIdentity(
  record: IdentityRecord,
  path: string = DEFAULT_IDENTITY_PATH(),
  configPath?: string,
): void {
  const cfgPath = configPath ?? DEFAULT_CONFIG_PATH();
  try {
    const cfg = readConfig(cfgPath);
    writeConfig({ ...cfg, identity: record }, cfgPath);
  } catch (e) {
    process.stderr.write(
      `[mai] writeIdentity: could not update config.json: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  legacyWriteIdentityToFile(record, path);
}

/** Original identity.json reader — no config.ts call (no cycle). */
function legacyReadIdentityFromFile(path: string): IdentityRecord | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  try {
    return identityRecordSchema.parse(JSON.parse(raw));
  } catch (e) {
    process.stderr.write(`[mai] identity.json corrupt or invalid: ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
}

/** Original atomic identity.json writer. */
function legacyWriteIdentityToFile(record: IdentityRecord, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8");
  renameSync(tmp, path);
}
