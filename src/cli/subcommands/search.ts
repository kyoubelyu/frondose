import { existsSync, unlinkSync } from "node:fs";
import {
  DEFAULT_SEARCH_CONFIG_PATH,
  readSearchConfig,
  type SearchConfig,
  writeSearchConfig,
} from "../../persistence/search.js";
import { isInteractive, type Prompter, printNoninteractiveGuidance, realPrompter } from "./_prompts.js";

export interface SearchSubcommandOpts {
  braveApiKey?: string;
  tavilyApiKey?: string;
  cfgPath?: string; // for test DI
}

function maskKey(key: string): string {
  if (key.length <= 4) return "****";
  return `***${key.slice(-4)}`;
}

export async function runSearchSubcommand(
  action: "set" | "status" | "remove",
  opts: SearchSubcommandOpts,
  prompter: Prompter = realPrompter,
): Promise<void> {
  const path = opts.cfgPath ?? DEFAULT_SEARCH_CONFIG_PATH();
  const existing = readSearchConfig(path);

  switch (action) {
    case "set": {
      let brave = opts.braveApiKey;
      let tavily = opts.tavilyApiKey;
      const hasAnyFlag = brave !== undefined || tavily !== undefined;
      const allSet = brave !== undefined && tavily !== undefined;

      if (!allSet && isInteractive()) {
        // Prompt for missing keys
        if (brave === undefined) {
          brave = (await prompter.apiKeyInput("Brave Search API key (optional, press Enter to skip)")) || undefined;
        }
        if (tavily === undefined) {
          tavily = (await prompter.apiKeyInput("Tavily Search API key (optional, press Enter to skip)")) || undefined;
        }
        // TTY + both skipped → write existing config unchanged (no error — operator chose to skip)
      } else if (!hasAnyFlag) {
        // Non-TTY + no flags provided → guidance + exit
        printNoninteractiveGuidance("search set", "", "--brave <key> --tavily <key>");
        process.exit(1);
      }
      // Non-TTY + partial flags: merge what was provided, skip prompting for unset (non-interactive)

      const next: SearchConfig = { ...existing };
      if (brave !== undefined) next.braveApiKey = brave || undefined;
      if (tavily !== undefined) next.tavilyApiKey = tavily || undefined;
      writeSearchConfig(next, path);

      const configured: string[] = [];
      if (next.braveApiKey) configured.push("brave");
      if (next.tavilyApiKey) configured.push("tavily");
      process.stdout.write(
        `[search] search.json updated (configured: ${configured.length > 0 ? configured.join(", ") : "none"})\n`,
      );
      return;
    }
    case "status": {
      if (!existing.braveApiKey && !existing.tavilyApiKey) {
        process.stdout.write("search: (not configured)\n");
        return;
      }
      process.stdout.write(
        `search: brave=${existing.braveApiKey ? maskKey(existing.braveApiKey) : "(unset)"}` +
          `, tavily=${existing.tavilyApiKey ? maskKey(existing.tavilyApiKey) : "(unset)"}\n`,
      );
      return;
    }
    case "remove": {
      if (!existsSync(path)) {
        process.stdout.write("search.json does not exist; nothing to remove.\n");
        return;
      }
      unlinkSync(path);
      process.stdout.write("[search] search.json removed\n");
      return;
    }
  }
}
