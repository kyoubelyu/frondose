import { tool } from "ai";
import { z } from "zod";
import { failFromError, ok } from "../../linkedin/envelope.js";

const ghIssueParams = z.object({
  title: z.string().min(1).max(256).describe("Issue title. The dedup_key typically appears here."),
  body: z.string().max(60000).describe("Issue body (markdown)."),
  labels: z.array(z.string()).default([]).describe("GitHub labels (e.g. ['feature', 'p6']). Default: empty."),
  dedupKey: z
    .string()
    .min(3)
    .max(128)
    .describe("Stable substring used for dedup. Searched in open-issue titles before creation."),
});

// biome-ignore lint/complexity/noBannedTypes: placeholder for future repo override (plan §6.2).
export type GhIssueOpts = {};

/**
 * Build the gh_issue Vercel tool. Creates a GitHub issue via REST API, with
 * agent-side dedup against existing open issues whose title contains dedup_key.
 *
 * Reads GH_TOKEN + GITHUB_REPO from process.env on first execute. Graceful
 * degradation when env unset.
 */
export function makeGhIssueTool(_opts: GhIssueOpts = {}) {
  return tool({
    description:
      "Create a GitHub issue in the configured repo, OR return the existing open issue if one with the same dedup_key already exists. " +
      "Use for: capability-gap escalation, persistent operational issues that need tracking. " +
      "DO NOT use for transient errors (network blip, single 5xx response).",
    parameters: ghIssueParams,
    execute: async (params) => {
      try {
        const token = process.env.GH_TOKEN;
        const repo = process.env.GITHUB_REPO;
        if (!token) {
          return {
            ok: false,
            command: "gh_issue",
            error: { kind: "runtime_error", message: "GH_TOKEN is not set; issue not created." },
          };
        }
        if (!repo) {
          return {
            ok: false,
            command: "gh_issue",
            error: { kind: "runtime_error", message: "GITHUB_REPO is not set (format owner/repo); issue not created." },
          };
        }

        // Dedup: search open issues whose title contains dedup_key.
        const searchUrl =
          `https://api.github.com/search/issues?` +
          `q=repo:${repo}+state:open+in:title+${encodeURIComponent(params.dedupKey)}&per_page=1`;
        const searchResp = await globalThis.fetch(searchUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
          },
        });
        if (searchResp.ok) {
          const searchResult = (await searchResp.json()) as {
            total_count: number;
            items?: Array<{ html_url: string; number: number }>;
          };
          if (searchResult.total_count > 0 && searchResult.items && searchResult.items.length > 0) {
            // biome-ignore lint/style/noNonNullAssertion: length-checked above.
            const existing = searchResult.items[0]!;
            return ok("gh_issue", {
              skipped: true,
              existingUrl: existing.html_url,
              existingNumber: existing.number,
              dedupKey: params.dedupKey,
            });
          }
        }
        // If search itself failed (non-OK), proceed to create — we'd rather create a duplicate
        // than skip a real escalation.

        // Create issue.
        const createUrl = `https://api.github.com/repos/${repo}/issues`;
        const createResp = await globalThis.fetch(createUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: params.title,
            body: params.body,
            labels: params.labels,
          }),
        });

        if (!createResp.ok) {
          let detail = `HTTP ${createResp.status}`;
          try {
            const errBody = (await createResp.json()) as { message?: string };
            if (errBody.message) detail += `: ${errBody.message}`;
          } catch {
            // ignore
          }
          return {
            ok: false,
            command: "gh_issue",
            error: {
              kind: createResp.status === 401 || createResp.status === 403 ? "invalid_input" : "runtime_error",
              message: `GitHub API error: ${detail}`,
            },
          };
        }

        const created = (await createResp.json()) as { html_url: string; number: number };
        return ok("gh_issue", {
          skipped: false,
          issueUrl: created.html_url,
          issueNumber: created.number,
          dedupKey: params.dedupKey,
        });
      } catch (e) {
        return failFromError("gh_issue", e);
      }
    },
  });
}
