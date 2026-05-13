import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { freeAxesSchema } from "../methodology/freeAxes.js";

export const DEFAULT_IDENTITY_PATH = (): string => join(homedir(), ".mai", "agent", "identity.json");

// Schemas per §6.3 of the plan + scout F-6.
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
  // P-5: 4 methodology habit axes — operator-locked at first identity init; re-rolled via `mai soul reset`.
  freeAxes: freeAxesSchema.optional(),
  updatedAt: z.string().min(1),
});
export type IdentityRecord = z.infer<typeof identityRecordSchema>;

export const identityPatchSchema = identityRecordSchema.omit({ updatedAt: true }).partial();
export type IdentityPatch = z.infer<typeof identityPatchSchema>;

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

/** Read identity from disk. Missing file → null. Corrupt JSON → log to stderr + null. */
export function readIdentity(path: string = DEFAULT_IDENTITY_PATH()): IdentityRecord | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return identityRecordSchema.parse(parsed);
  } catch (e) {
    process.stderr.write(`[mai] identity.json corrupt or invalid: ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
}

/** Write identity to disk atomically (mkdir -p parents; pretty JSON; UTF-8). */
export function writeIdentity(record: IdentityRecord, path: string = DEFAULT_IDENTITY_PATH()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2), "utf-8");
  renameSync(tmp, path);
}
