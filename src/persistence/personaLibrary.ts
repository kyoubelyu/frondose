/** P-27: persona templates at ~/.mai/server/personas/<id>.json. Filesystem CRUD. */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const personaTemplateSchema = z.object({
  fullName: z.string().trim().min(1),
  role: z.string().trim().min(1).optional(),
  company: z.string().trim().min(1).optional(),
  linkedInUrl: z.string().url().optional(),
  email: z.string().email().optional(),
  emailTemplate: z.string().max(2000).optional(),
  soulBandOverride: z.string().max(3000).optional(),
  priorities: z.array(z.string().trim().min(1).max(160)).max(8).default([]),
  traits: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
  updatedAt: z.string().datetime(),
});
export type PersonaTemplate = z.infer<typeof personaTemplateSchema>;

/** List persona IDs (basenames without .json). Empty array if dir absent. */
export function listPersonaTemplates(personasDir: string): string[] {
  if (!existsSync(personasDir)) return [];
  return readdirSync(personasDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

/** Read + validate. Returns null + stderr warning on missing/malformed. */
export function readPersonaTemplate(personasDir: string, personaId: string): PersonaTemplate | null {
  const path = join(personasDir, `${personaId}.json`);
  if (!existsSync(path)) return null;
  try {
    return personaTemplateSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch (e) {
    process.stderr.write(
      `[mai] persona template ${personaId}.json corrupt or invalid: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
}

/** Atomic write: tmp + rename. No chmod — personas hold display fields, not credentials. */
export function writePersonaTemplate(personasDir: string, personaId: string, t: PersonaTemplate): void {
  mkdirSync(personasDir, { recursive: true });
  const path = join(personasDir, `${personaId}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(t, null, 2), "utf-8");
  renameSync(tmp, path);
}

export function deletePersonaTemplate(personasDir: string, personaId: string): boolean {
  const path = join(personasDir, `${personaId}.json`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}
