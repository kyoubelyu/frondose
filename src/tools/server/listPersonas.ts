/** P-27: list_personas server tool. */
import { tool } from "ai";
import { z } from "zod";
import { listPersonaTemplates, readPersonaTemplate } from "../../persistence/personaLibrary.js";

export function makeListPersonasTool(personasDir: string) {
  return tool({
    description:
      "List available persona templates in the server's persona library. " +
      "Use BEFORE provision_worker to verify the persona_id exists.",
    parameters: z.object({}),
    execute: async () => {
      const ids = listPersonaTemplates(personasDir);
      if (ids.length === 0) {
        return {
          ok: true,
          personas: [],
          hint: "No personas configured. Run `mai server persona add` on the server CLI to create one.",
        };
      }
      const personas = ids.map((id) => {
        const t = readPersonaTemplate(personasDir, id);
        return {
          id,
          fullName: t?.fullName ?? "?",
          role: t?.role ?? null,
          company: t?.company ?? null,
        };
      });
      return { ok: true, personas };
    },
  });
}
