/** P-27: provision_worker server tool. Mints an invite token and returns the
 *  curl one-liner for the bootstrap script.
 *  P-29: mintInvite() extracted as a shared function (used by both the Vercel tool
 *  and the web /api/web/provision endpoint — single code path, no drift). */
import { createHash, randomBytes } from "node:crypto";
import { tool } from "ai";
import type { Database as DB } from "better-sqlite3";
import { z } from "zod";
import { insertInvite } from "../../persistence/invitesRegistry.js";
import { readPersonaTemplate } from "../../persistence/personaLibrary.js";

/** P-29: return shape of mintInvite (shared by the Vercel tool + web endpoint). */
export type MintInviteResult =
  | { ok: true; curlCommand: string; expiresAt: string; personaId: string }
  | { ok: false; error: string };

/** P-29: shared invite-mint core. Called by the provision_worker tool AND the
 *  web /api/web/provision endpoint — single code path, no drift.
 *  The tool's parameters + return envelope are byte-identical to P-27 (G-P29.20). */
export function mintInvite(
  invitesDb: DB | null,
  personasDir: string,
  serverUrl: string,
  input: { personaId: string; hostname?: string; ttlMin?: number },
): MintInviteResult {
  if (!invitesDb) return { ok: false, error: "invites.sqlite not initialized" };
  if (!serverUrl) {
    return { ok: false, error: "server URL not configured; check config.json.server.url" };
  }
  const persona = readPersonaTemplate(personasDir, input.personaId);
  if (!persona) {
    // N-2: verbatim P-27 error text — extraction is fully behavior-preserving.
    return {
      ok: false,
      error: `Persona not found: ${input.personaId}. Run list_personas to see available personas.`,
    };
  }
  const inviteToken = randomBytes(32).toString("hex");
  const tokenSha256 = createHash("sha256").update(inviteToken).digest("hex");
  const expiresAt = Date.now() + (input.ttlMin ?? 30) * 60_000;
  insertInvite(invitesDb, tokenSha256, input.personaId, input.hostname ?? null, expiresAt);
  return {
    ok: true,
    curlCommand: `curl -sf ${serverUrl}/bootstrap/${inviteToken}.sh | bash`,
    expiresAt: new Date(expiresAt).toISOString(),
    personaId: input.personaId,
  };
}

export function makeProvisionWorkerTool(invitesDb: DB | null, personasDir: string, serverUrl: string) {
  return tool({
    description:
      "Provision a new worker: mints an invite token and returns the curl command " +
      "for the bootstrap script. Call when the operator wants to deploy a new VM. " +
      "Use list_personas first to verify the persona_id exists.",
    parameters: z.object({
      personaId: z.string().min(1),
      hostname: z.string().optional(),
      ttlMin: z.number().int().min(5).max(1440).default(30).optional(),
    }),
    // P-29: delegate to the shared mintInvite core (single code path with the
    // web /api/web/provision endpoint). Envelope byte-identical to P-27.
    execute: async (input) => mintInvite(invitesDb, personasDir, serverUrl, input),
  });
}
