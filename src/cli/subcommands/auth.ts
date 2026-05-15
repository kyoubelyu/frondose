import { existsSync } from "node:fs";
import { parseModelSpec } from "../../agent/modelResolver.js";
import {
  type AuthJson,
  authPathToSecretsPath,
  DEFAULT_AUTH_PATH,
  maskKey,
  readAuth,
  writeAuth,
} from "../../persistence/auth.js";
import { isInteractive, type Prompter, printNoninteractiveGuidance, realPrompter } from "./_prompts.js";

export interface AuthSubcommandOpts {
  // P-21: URL-based set flow
  url?: string; // for "set" — API base URL (positional)
  model?: string; // for "set" — model ID
  name?: string; // for "set" — provider name (default: derived from URL hostname)
  asDefault?: boolean; // for "set" — also write `default: <name>:<model>`
  // Legacy / shared
  spec?: string; // for "default"
  provider?: string; // for "remove"
  key?: string; // for "set"
  baseUrl?: string; // legacy override (kept for back-compat callers)
  authPath?: string; // override DEFAULT_AUTH_PATH (for tests)
  /** DI: fetch implementation for tests (injected to fetchModelListSafe).
   *  Defaults to globalThis.fetch. Matches the P-20 pattern in src/cli/subcommands/update.ts. */
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * P-21: derive a default provider name from a base URL.
 * Strips `api.`/`www.` prefix and takes the first hostname segment.
 *   https://api.deepseek.com/v1 → "deepseek"
 *   https://api.together.xyz/v1 → "together"
 *   https://api.openai.com/v1   → "openai"
 */
export function deriveNameFromUrl(url: string): string {
  const hostname = new URL(url).hostname;
  const stripped = hostname.replace(/^api\./, "").replace(/^www\./, "");
  return stripped.split(".")[0] ?? stripped;
}

/**
 * P-21: inner fetch — throws on any error. Caller wraps it.
 * Exposed for testing only; production callers use fetchModelListSafe.
 */
async function fetchModelList(
  url: string,
  key: string,
  fetchImpl: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<string[]> {
  const resp = await fetchImpl(`${url.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const body = (await resp.json()) as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((m) => m.id).filter(Boolean);
}

/**
 * P-21: safe wrapper around model-list fetch.
 *
 *   - Returns string[] of model IDs on success.
 *   - On any error (network, non-2xx, non-JSON, timeout) returns [].
 *   - On error writes to stderr: `Could not fetch model list: <message>\n`.
 *   - Anthropic URLs (hostname ends with .anthropic.com or equals api.anthropic.com)
 *     SKIP the fetch entirely (different auth header + schema). Returns [] with NO stderr.
 *
 * `fetchImpl` is dependency-injected so tests pass a mock fetch.
 */
export async function fetchModelListSafe(
  url: string,
  key: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<string[]> {
  try {
    const host = new URL(url).hostname;
    if (host === "api.anthropic.com" || host.endsWith(".anthropic.com")) {
      return [];
    }
  } catch {
    // Malformed URL — let the fetch path produce a normal error.
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5_000);
  try {
    return await fetchModelList(url, key, fetchImpl, ac.signal);
  } catch (err) {
    process.stderr.write(`Could not fetch model list: ${err instanceof Error ? err.message : String(err)}\n`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** P-21: return the inferred provider `type` from a URL hostname. */
function inferTypeFromUrl(url: string): "openai" | "anthropic" {
  try {
    const hostname = new URL(url).hostname;
    if (hostname === "api.anthropic.com" || hostname.endsWith(".anthropic.com")) {
      return "anthropic";
    }
  } catch {
    // URL already validated upstream; default to openai-compat.
  }
  return "openai";
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
      // P-21: URL-based flow.
      const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
      let url = opts.url;
      let key = opts.key;
      let model = opts.model;
      let name = opts.name;
      // asDefault: non-interactive defaults from --default flag; interactive overrides via confirm prompt.
      let asDefault: boolean = opts.asDefault ?? false;

      if (isInteractive() && (!url || !key || !model)) {
        if (!url) {
          url = await prompter.input("API base URL:");
          try {
            new URL(url);
          } catch {
            process.stderr.write(`Invalid URL: ${url}\n`);
            process.exit(1);
          }
        }
        if (!key) {
          key = await prompter.apiKeyInput(deriveNameFromUrl(url));
        }
        if (!model) {
          const modelList = await fetchModelListSafe(url, key, fetchImpl);
          if (modelList.length > 0) {
            model = await prompter.modelSelect(modelList);
          } else {
            model = await prompter.input("Model ID (e.g. gpt-4o, deepseek-chat):");
          }
        }
        if (!name) {
          const defaultName = deriveNameFromUrl(url);
          const entered = await prompter.input(`Provider name (default: ${defaultName}):`);
          name = entered ? entered : defaultName;
        }
        asDefault = await prompter.confirm("Set as default provider?", asDefault);
      }

      if (!url) {
        printNoninteractiveGuidance(
          "auth set",
          "<url>",
          "https://api.openai.com/v1 --key sk-xxx --model gpt-4o --name openai",
        );
        process.exit(1);
      }

      // /v1 path warning: OpenAI-compatible providers require /v1 in baseURL.
      // Anthropic URLs are exempt (createAnthropic appends /v1 internally).
      // Fires for both interactive (post-prompt) and non-interactive (post-url-guard) paths.
      try {
        const u = new URL(url);
        const isAnthropicHost = u.hostname === "api.anthropic.com" || u.hostname.endsWith(".anthropic.com");
        const hasV1 = u.pathname.replace(/\/$/, "").endsWith("/v1");
        if (!hasV1 && !isAnthropicHost) {
          process.stderr.write(
            `[mai] warning: URL "${url}" has no /v1 path segment; ` +
              `OpenAI-compatible providers usually require /v1 ` +
              `(e.g. https://api.openai.com/v1). Continuing as entered.\n`,
          );
        }
      } catch {
        // Malformed URL — caught upstream.
      }

      if (!key) {
        printNoninteractiveGuidance("auth set", "--key <value>", `${url} --key sk-xxx --model gpt-4o`);
        process.exit(1);
      }
      if (!model) {
        printNoninteractiveGuidance("auth set", "--model <id>", `${url} --key sk-xxx --model gpt-4o`);
        process.exit(1);
      }

      if (!name) name = deriveNameFromUrl(url);

      // Collision check: auto-increment to name-1, name-2, ...
      if (existing.providers?.[name]) {
        let suffix = 1;
        while (existing.providers?.[`${name}-${suffix}`]) suffix++;
        name = `${name}-${suffix}`;
      }

      const type = inferTypeFromUrl(url);

      const next: AuthJson = {
        ...existing,
        default: asDefault ? `${name}:${model}` : existing.default,
        providers: {
          ...(existing.providers ?? {}),
          [name]: { key, baseUrl: url, type },
        },
      };
      writeAuth(next, path);
      process.stdout.write(`[mai] auth.json updated for provider: ${name} (${type})\n`);
      return;
    }
    case "list": {
      // P-24: data lives in secrets.json (via shim). Show empty-state message if
      // secrets.json is absent AND legacy auth.json has not been migrated yet.
      if (!existsSync(authPathToSecretsPath(path)) && !existsSync(path)) {
        process.stdout.write("No auth.json found. Run `mai auth set <url> --key <value> --model <id>` to configure.\n");
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
          const typeStr = entry.type ?? "(unknown)";
          const baseUrlStr = entry.baseUrl ?? "(unknown)";
          process.stdout.write(`    ${name}: ${masked}  type=${typeStr}  baseUrl=${baseUrlStr}\n`);
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
