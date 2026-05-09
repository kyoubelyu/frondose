import { existsSync } from "node:fs";
import { parseModelSpec } from "../../agent/modelResolver.js";
import { type AuthJson, DEFAULT_AUTH_PATH, maskKey, readAuth, writeAuth } from "../../persistence/auth.js";

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
): Promise<void> {
  const path = opts.authPath ?? DEFAULT_AUTH_PATH();
  const existing = readAuth(path) ?? {};

  switch (action) {
    case "set": {
      if (!opts.spec) {
        process.stderr.write("[mai auth set] requires <provider:modelId> argument.\n");
        process.exit(1);
      }
      if (!opts.key) {
        process.stderr.write("[mai auth set] requires --key <value> option.\n");
        process.exit(1);
      }
      const { provider } = parseModelSpec(opts.spec); // validates spec format
      const next: AuthJson = {
        ...existing,
        providers: {
          ...(existing.providers ?? {}),
          [provider]: { key: opts.key, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) },
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
      if (!opts.provider) {
        process.stderr.write("[mai auth remove] requires <provider> argument.\n");
        process.exit(1);
      }
      if (!existing.providers || !(opts.provider in existing.providers)) {
        process.stdout.write(`[mai] No provider '${opts.provider}' configured; nothing to remove.\n`);
        return;
      }
      const { [opts.provider]: _removed, ...rest } = existing.providers;
      const next: AuthJson = { ...existing, providers: rest };
      writeAuth(next, path);
      process.stdout.write(`[mai] removed provider: ${opts.provider}\n`);
      return;
    }
    case "default": {
      if (!opts.spec) {
        process.stderr.write("[mai auth default] requires <provider:modelId> argument.\n");
        process.exit(1);
      }
      // Validate format; throw on bad spec.
      parseModelSpec(opts.spec);
      const next: AuthJson = { ...existing, default: opts.spec };
      writeAuth(next, path);
      process.stdout.write(`[mai] default model spec set to: ${opts.spec}\n`);
      return;
    }
  }
}
