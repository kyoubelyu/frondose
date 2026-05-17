/** P-28.5: `navigate_to_url` worker tool — HTTPS-only general navigation. */
import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/index.js";
import type { LinkedinSession } from "../../linkedin/types.js";

export function makeNavigateToUrlTool(session: LinkedinSession) {
  return tool({
    description:
      "Navigate Chrome to an HTTPS URL (https:// only — http/file/data are rejected) and " +
      "wait for load. For web-based login flows (Google SSO sign-in, 2FA verification " +
      "pages such as 2fa.show) and platform-adjacent pages. For LinkedIn destinations " +
      "prefer the `launch` tool (named destinations, LinkedIn-specific pacing).",
    parameters: z.object({
      url: z
        .string()
        .url()
        .refine((u) => u.startsWith("https://"), { message: "Only https:// URLs are allowed." }),
      waitUntil: z.enum(["load", "networkidle"]).optional(),
    }),
    execute: async ({ url, waitUntil }) => {
      try {
        const r = await session.getOrInitClient();
        if (!r.ok) return r;
        const { client } = r;
        await client.navigate(url, waitUntil);
        const finalUrl = await client.getCurrentUrl();
        return ok("navigate_to_url", { url: finalUrl });
      } catch (e) {
        return failFromError("navigate_to_url", e);
      }
    },
  });
}
