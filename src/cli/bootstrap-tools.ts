import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tool } from "ai";
import { z } from "zod";
import { freeAxesSchema } from "../methodology/freeAxes.js";
import { type IdentityRecord, icpSchema, identityRecordSchema, writeIdentity } from "../persistence/identity.js";

export const BOOTSTRAP_FIELD_NAMES = [
  "fullName",
  "company",
  "profileUrl",
  "role",
  "contact",
  "persona",
  "style",
  "icp",
  "pain_chain_lean",
  "lead_role",
  "discovery_lean",
  "story_shape",
] as const satisfies readonly string[];
export type BootstrapFieldName = (typeof BOOTSTRAP_FIELD_NAMES)[number];

/** Read the WIP JSON file. Returns {} if absent or unreadable. */
export function readWipFile(wipPath: string): Record<string, unknown> {
  if (!existsSync(wipPath)) return {};
  try {
    return JSON.parse(readFileSync(wipPath, "utf-8")) as Record<string, unknown>;
  } catch {
    process.stderr.write(`[frondose] WIP file ${wipPath} corrupt or unreadable; treating as empty.\n`);
    return {};
  }
}

/** Write WIP JSON file (atomic-ish; mkdir parent if needed). */
export function writeWipFile(wipPath: string, wip: Record<string, unknown>): void {
  writeFileSync(wipPath, JSON.stringify(wip, null, 2), "utf-8");
}

/**
 * Build a validated IdentityRecord from a flat WIP object.
 * - Top-level fields → identity record fields (fullName, company, etc.).
 * - 4 axis keys (pain_chain_lean, lead_role, discovery_lean, story_shape) → nested under .freeAxes.
 * - icp top-level key → nested under .icp (validated via icpSchema).
 *
 * Throws if any field fails identityRecordSchema.parse — execute caller catches + returns error envelope.
 */
export function buildIdentityFromWip(wip: Record<string, unknown>): IdentityRecord {
  const { pain_chain_lean, lead_role, discovery_lean, story_shape, icp, ...base } = wip;
  const hasAxes = !!(pain_chain_lean || lead_role || discovery_lean || story_shape);
  let freeAxes: z.infer<typeof freeAxesSchema> | undefined;
  if (hasAxes) {
    // Notify operator at finalize time when partial axes get filled with
    // methodology defaults (CONCERN-MR-2 transparency). The complete-freeAxes
    // invariant is preserved so composeSoulBand always reads a 4-axis block.
    const filledDefaults: string[] = [];
    if (!pain_chain_lean) filledDefaults.push("pain_chain_lean=cause-confirmed-then-up");
    if (!lead_role) filledDefaults.push("lead_role=pain-owner first");
    if (!discovery_lean) filledDefaults.push("discovery_lean=ratio-disciplined");
    if (!story_shape) filledDefaults.push("story_shape=reference-story led");
    if (filledDefaults.length > 0) {
      process.stderr.write(
        `[frondose] ${filledDefaults.length} of 4 axes used methodology defaults: ${filledDefaults.join("; ")}. ` +
          "Run `mai soul reset` to pick yours.\n",
      );
    }
    freeAxes = freeAxesSchema.parse({
      pain_chain_lean: pain_chain_lean ?? "cause-confirmed-then-up",
      lead_role: lead_role ?? "pain-owner first",
      discovery_lean: discovery_lean ?? "ratio-disciplined",
      story_shape: story_shape ?? "reference-story led",
    });
  }
  const icpResult = icp ? icpSchema.parse(coerceIcp(icp)) : undefined;
  return identityRecordSchema.parse({
    ...base,
    ...(icpResult ? { icp: icpResult } : {}),
    ...(freeAxes ? { freeAxes } : {}),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Forgive model on icp value shape: if model committed a string instead of structured object,
 * coerce by splitting on commas and treating each token as a target role.
 */
function coerceIcp(value: unknown): unknown {
  if (typeof value === "string") {
    const targetRole = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { targetRole };
  }
  return value;
}

const commitIdentityFieldSchema = z.object({
  field: z.enum(BOOTSTRAP_FIELD_NAMES),
  value: z.union([
    z.string().min(1),
    z.object({
      targetRole: z.string().trim().min(1).array().min(1),
      industry: z.string().trim().min(1).array().min(1).optional(),
    }),
  ]),
});

const finalizeIdentitySchema = z.object({});

export interface BootstrapToolsOpts {
  identityPath: string;
  wipPath: string;
  committedSet: Set<string>;
  finalizeSignal: () => void;
}

/** Build the 2 bootstrap-only meta-tools, capturing closure references to caller's state. */
export function makeBootstrapTools(opts: BootstrapToolsOpts) {
  const { identityPath, wipPath, committedSet, finalizeSignal } = opts;

  const commit_identity_field = tool({
    description:
      "Stage a single identity field value into the work-in-progress file. " +
      "Call once per field as soon as you are confident about the value. " +
      "Do not batch multiple fields into one call.",
    parameters: commitIdentityFieldSchema,
    execute: async ({ field, value }) => {
      const wip = readWipFile(wipPath);
      wip[field] = value;
      writeWipFile(wipPath, wip);
      committedSet.add(field);
      return { ok: true, committed: field };
    },
  });

  const finalize_identity = tool({
    description:
      "Write the final identity.json from the work-in-progress file and end the bootstrap session. " +
      "Call this when all 12 fields are committed OR when the operator says they are done.",
    parameters: finalizeIdentitySchema,
    execute: async () => {
      try {
        const wip = readWipFile(wipPath);
        const record = buildIdentityFromWip(wip);
        writeIdentity(record, identityPath);
        if (existsSync(wipPath)) unlinkSync(wipPath);
        finalizeSignal();
        return { ok: true, identityPath };
      } catch (e) {
        // Zod failure or fs error — return to model so it can re-attempt.
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  });

  return { commit_identity_field, finalize_identity };
}
