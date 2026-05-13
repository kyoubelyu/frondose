import { existsSync, unlinkSync } from "node:fs";
import {
  type GithubConfig,
  DEFAULT_GITHUB_CONFIG_PATH,
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
      let token = opts.token;
      const repo = opts.repo;
      if (!token && isInteractive()) {
        token = await prompter.apiKeyInput("GitHub PAT");
      }
      if (!token) {
        printNoninteractiveGuidance("gh set", "<token>", "--token ghp_xxx --repo owner/repo");
        process.exit(1);
      }
      // Merge: preserve repo if new one not provided
      const next: GithubConfig = { ...existing, token };
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
