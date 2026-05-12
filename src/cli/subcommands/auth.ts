import { existsSync } from "node:fs";
import { parseModelSpec } from "../../agent/modelResolver.js";
import { type AuthJson, DEFAULT_AUTH_PATH, maskKey, readAuth, writeAuth } from "../../persistence/auth.js";
import { isInteractive, type Prompter, printNoninteractiveGuidance, realPrompter } from "./_prompts.js";

export interface AuthSubcommandOpts {
  spec?: string; // for "set", "default"
  provider?: string; // for "remove"
  key?: string; // for "set"
  baseUrl?: string; // for "set"
  authPath?: string; // override DEFAULT_AUTH_PATH (for tests)
}

export async function runAuthSubcommand(
  action: "set" | "list" | "remove" | "default",
  opts: AuthSubcommandOpts,
  // P-13 D-3: optional Prompter for interactive paths; defaults to realPrompter.
  // Existing callers omit this arg — backward-compat preserved.
  prompter: Prompter = realPrompter,
): Promise<void> {
  const path = opts.authPath ?? DEFAULT_AUTH_PATH();
  const existing = readAuth(path) ?? {};

  switch (action) {
    case "set": {
      // P-13 D-3 + D-5 + C-1 Option A: interactive fallback when args absent.
      let spec = opts.spec;
      let key = opts.key;
      if ((!spec || !key) && isInteractive()) {
        if (!spec) {
          const configured = Object.keys(existing.providers ?? {});
          spec = await prompter.providerSelect(configured);
          // C-1 fix Step 3b: "(add new provider spec…)" sentinel → free-form input for spec.
          if (spec === "__NEW__") {
            spec = await prompter.input("Provider spec (e.g. openai:gpt-4o):");
          }
        }
        if (!key) {
          const { provider } = parseModelSpec(spec);
          key = await prompter.apiKeyInput(provider);
        }
      }
      if (!spec) {
        printNoninteractiveGuidance("auth set", "<provider:modelId>", "<provider:modelId> --key $ANTHROPIC_API_KEY");
        process.exit(1);
      }
      if (!key) {
        printNoninteractiveGuidance("auth set", "--key <value>", `${spec} --key $ANTHROPIC_API_KEY`);
        process.exit(1);
      }
      const { provider } = parseModelSpec(spec); // validates spec format
      const next: AuthJson = {
        ...existing,
        providers: {
          ...(existing.providers ?? {}),
          [provider]: { key, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) },
        },
      };
      writeAuth(next, path);
      process.stdout.write(`[mai] auth.json updated for provider: ${provider}\n`);
      return;
    }
    case "list": {
      if (!existsSync(path)) {
        process.stdout.write("No auth.json found. Run `mai auth set <provider:modelId> --key <value>` to configure.\n");
        return;
      }
      process.stdout.write(`auth.json (${path})\n`);
      if (existing.default) process.stdout.write(`  default: ${existing.default}\n`);
      const providers = existing.providers ?? {};
      const names = Object.keys(providers).sort();
      if (names.length === 0) {
        process.stdout.write("  providers: (none configured)\n");
      } else {
        process.stdout.write("  providers:\n");
        for (const name of names) {
          // biome-ignore lint/style/noNonNullAssertion: name iterated from Object.keys(providers).
          const entry = providers[name]!;
          const masked = maskKey(entry.key);
          const baseUrlNote = entry.baseUrl ? ` (baseUrl: ${entry.baseUrl})` : "";
          process.stdout.write(`    ${name}: ${masked}${baseUrlNote}\n`);
        }
      }
      return;
    }
    case "remove": {
      // P-13 D-3 + D-5 + C-1: interactive fallback; sentinel = cancel no-op.
      let provider = opts.provider;
      if (!provider && isInteractive()) {
        const configured = Object.keys(existing.providers ?? {});
        if (configured.length === 0) {
          process.stdout.write("No providers configured; nothing to remove.\n");
          return;
        }
        provider = await prompter.providerSelect(configured);
        if (provider === "__NEW__") {
          process.stdout.write("Cancelled (cannot remove an unconfigured provider).\n");
          return;
        }
      }
      if (!provider) {
        printNoninteractiveGuidance("auth remove", "<provider>", "anthropic");
        process.exit(1);
      }
      if (!existing.providers || !(provider in existing.providers)) {
        process.stdout.write(`[mai] No provider '${provider}' configured; nothing to remove.\n`);
        return;
      }
      const { [provider]: _removed, ...rest } = existing.providers;
      const next: AuthJson = { ...existing, providers: rest };
      writeAuth(next, path);
      process.stdout.write(`[mai] removed provider: ${provider}\n`);
      return;
    }
    case "default": {
      // P-13 D-3 + D-5 + C-1: interactive fallback; sentinel = cancel no-op.
      // C-3 note: providerSelect returns whatever the operator chose (family-key
      // like "anthropic" OR full spec from "__NEW__" branch — but here we don't
      // surface the __NEW__ branch for default; if selected we cancel). Stored as-is.
      let spec = opts.spec;
      if (!spec && isInteractive()) {
        const configured = Object.keys(existing.providers ?? {});
        if (configured.length === 0) {
          process.stdout.write("No providers configured; configure one first via `mai auth set`.\n");
          return;
        }
        spec = await prompter.providerSelect(configured);
        if (spec === "__NEW__") {
          process.stdout.write("Cancelled (set a provider via `mai auth set` first, then run `mai auth default`).\n");
          return;
        }
      }
      if (!spec) {
        printNoninteractiveGuidance("auth default", "<provider:modelId>", "anthropic:claude-sonnet-4-5");
        process.exit(1);
      }
      // Validate format only when spec looks like a full provider:model spec.
      // Operator picking a configured family key (e.g. "anthropic") is stored as-is per C-3.
      if (spec.includes(":")) {
        parseModelSpec(spec); // throws on bad format
      }
      const next: AuthJson = { ...existing, default: spec };
      writeAuth(next, path);
      process.stdout.write(`[mai] default model spec set to: ${spec}\n`);
      return;
    }
  }
}
