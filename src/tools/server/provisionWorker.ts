/** P-27: provision_worker server tool. Mints an invite token and returns the
 *  curl one-liner for the bootstrap script. */
import { createHash, randomBytes } from "node:crypto";
import { tool } from "ai";
import type { Database as DB } from "better-sqlite3";
import { z } from "zod";
import { insertInvite } from "../../persistence/invitesRegistry.js";
import { readPersonaTemplate } from "../../persistence/personaLibrary.js";

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
    execute: async (input) => {
      if (!invitesDb) return { ok: false, error: "invites.sqlite not initialized" };
      if (!serverUrl) {
        return { ok: false, error: "server URL not configured; check config.json.server.url" };
      }
      const persona = readPersonaTemplate(personasDir, input.personaId);
      if (!persona) {
        return {
          ok: false,
          error: `Persona not found: ${input.personaId}. Run list_personas to see available personas.`,
        };
      }
      const inviteToken = randomBytes(32).toString("hex");
      const tokenSha256 = createHash("sha256").update(inviteToken).digest("hex");
      const expiresAt = Date.now() + (input.ttlMin ?? 30) * 60_000;
      insertInvite(invitesDb, tokenSha256, input.personaId, input.hostname ?? null, expiresAt);
      const curlCommand = `curl -sf ${serverUrl}/bootstrap/${inviteToken}.sh | bash`;
      return {
        ok: true,
        curlCommand,
        expiresAt: new Date(expiresAt).toISOString(),
        personaId: input.personaId,
      };
    },
  });
}
