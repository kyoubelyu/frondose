import { existsSync, unlinkSync } from "node:fs";
import { DEFAULT_SEARCH_CONFIG_PATH, readSearchConfig } from "../../persistence/search.js";
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
      if (!opts.braveApiKey && !opts.tavilyApiKey && !isInteractive()) {
        printNoninteractiveGuidance("search set", "", "unsupported in P-71; web_search remains scope-disabled");
      }
      void prompter;
      process.stdout.write(
        "[search] direct Brave/Tavily key setup is unsupported in P-71; web_search ignores legacy keys until a future MCP search client phase.\n",
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
          `, tavily=${existing.tavilyApiKey ? maskKey(existing.tavilyApiKey) : "(unset)"} ` +
          "(legacy ignored/unsupported by web_search)\n",
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
