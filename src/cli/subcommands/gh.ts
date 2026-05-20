import { existsSync, unlinkSync } from "node:fs";
import {
  DEFAULT_GITHUB_CONFIG_PATH,
  type GithubConfig,
  maskToken,
  readGithubConfig,
  writeGithubConfig,
} from "../../persistence/github.js";
import { isInteractive, type Prompter, printNoninteractiveGuidance, realPrompter } from "./_prompts.js";

export interface GhSubcommandOpts {
  token?: string;
  repo?: string;
  cfgPath?: string; // for test DI
}

export async function runGhSubcommand(
  action: "set" | "status" | "remove",
  opts: GhSubcommandOpts,
  prompter: Prompter = realPrompter,
): Promise<void> {
  const path = opts.cfgPath ?? DEFAULT_GITHUB_CONFIG_PATH();
  const existing = readGithubConfig(path);

  switch (action) {
    case "set": {
      const token = opts.token;
      const repo = opts.repo;
      // P-15: only prompt when no NEW token AND no EXISTING token on file.
      // Lets `mai gh set --repo own/r` succeed when a token is already stored
      // (operator-reported 2026-05-20: partial-update was broken).
      let resolvedToken = token;
      if (!resolvedToken && !existing.token && isInteractive()) {
        resolvedToken = await prompter.apiKeyInput("GitHub PAT");
      }
      if (!resolvedToken && !existing.token) {
        printNoninteractiveGuidance("gh set", "<token>", "--token ghp_xxx --repo owner/repo");
        process.exit(1);
      }
      // P-15 (OQ-1): no-op guard — existing token on file + no new flags →
      // preserve and announce. Prevents gratuitous mtime churn on a bare
      // `mai gh set` call when the operator already has config.
      if (!resolvedToken && !repo) {
        process.stdout.write("✓ no changes; existing github config preserved\n");
        return;
      }
      // Safe merge: spread existing first, conditionally apply new values.
      // (The pre-P-15 spread `{ ...existing, token }` was unsafe — it would
      // overwrite an existing token with `undefined` when the new one is empty.)
      const next: GithubConfig = { ...existing };
      if (resolvedToken) next.token = resolvedToken;
      if (repo) next.repo = repo;
      writeGithubConfig(next, path);
      process.stdout.write(`[gh] github.json updated${repo ? ` (repo: ${repo})` : ""}\n`);
      return;
    }
    case "status": {
      if (!existing.token && !existing.repo) {
        process.stdout.write("github: (not configured)\n");
        return;
      }
      process.stdout.write(
        `github: token=${existing.token ? maskToken(existing.token) : "(unset)"}, repo=${existing.repo ?? "(unset)"}\n`,
      );
      return;
    }
    case "remove": {
      if (!existsSync(path)) {
        process.stdout.write("github.json does not exist; nothing to remove.\n");
        return;
      }
      unlinkSync(path);
      process.stdout.write("[gh] github.json removed\n");
      return;
    }
  }
}
