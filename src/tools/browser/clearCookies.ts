/** P-28.5: `clear_cookies` worker tool — pre-login Chrome profile cleanup. */
import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/index.js";
import type { LinkedinSession } from "../../linkedin/types.js";

export function makeClearCookiesTool(session: LinkedinSession) {
  return tool({
    description:
      "Clear browser cookies before a fresh login. Omit `origins` to clear ALL cookies; " +
      "pass specific origins (e.g. https://accounts.google.com, https://www.linkedin.com) " +
      "to surgically clear cookies + storage for just those sites. Use before a Google " +
      "SSO login so no stale session interferes.",
    parameters: z.object({
      origins: z.array(z.string().url()).optional(),
    }),
    execute: async ({ origins }) => {
      try {
        const r = await session.getOrInitClient();
        if (!r.ok) return r;
        const { client } = r;
        if (!origins || origins.length === 0) {
          await client.clearBrowserCookies();
          return ok("clear_cookies", { cleared: "all" });
        }
        for (const origin of origins) {
          await client.clearOriginData(origin);
        }
        return ok("clear_cookies", { cleared: origins });
      } catch (e) {
        return failFromError("clear_cookies", e);
      }
    },
  });
}
