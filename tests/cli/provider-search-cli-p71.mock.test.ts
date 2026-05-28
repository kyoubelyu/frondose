import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runAuthSubcommand } from "../../src/cli/subcommands/auth.js";
import { runSearchSubcommand } from "../../src/cli/subcommands/search.js";
import { runStatusSubcommand } from "../../src/cli/subcommands/status.js";
import { readAuth, writeAuth } from "../../src/persistence/auth.js";
import { readSearchConfig, writeSearchConfig } from "../../src/persistence/search.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

class ExitSignal extends Error {
  constructor(readonly code: string | number | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

async function captureCli(fn: () => Promise<void>): Promise<{
  stdout: string;
  stderr: string;
  exitCode?: string | number | null;
  thrown?: unknown;
}> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  const originalExit = process.exit;
  // biome-ignore lint/suspicious/noExplicitAny: test capture harness
  (process.stdout as any).write = (chunk: string | Buffer) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  // biome-ignore lint/suspicious/noExplicitAny: test capture harness
  (process.stderr as any).write = (chunk: string | Buffer) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  process.exit = ((code?: string | number | null) => {
    throw new ExitSignal(code);
  }) as typeof process.exit;
  try {
    await fn();
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
  } catch (error) {
    if (error instanceof ExitSignal) {
      return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), exitCode: error.code };
    }
    return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), thrown: error };
  } finally {
    // biome-ignore lint/suspicious/noExplicitAny: restore after capture
    (process.stdout as any).write = originalStdout;
    // biome-ignore lint/suspicious/noExplicitAny: restore after capture
    (process.stderr as any).write = originalStderr;
    process.exit = originalExit;
  }
}

function blocked(result: {
  exitCode?: string | number | null;
  thrown?: unknown;
  stdout: string;
  stderr: string;
}): boolean {
  return (
    result.exitCode !== undefined ||
    result.thrown !== undefined ||
    /unsupported|disabled|scope|reserved/i.test(result.stdout + result.stderr)
  );
}

function makeTmpDir(label: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", `mai-p71-${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function okModelsFetch(): typeof globalThis.fetch {
  return async () =>
    new Response(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }, { id: "gpt-4o" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

const flushReporter = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe("P-71 transitional CLI provider/search guards", { concurrency: 1 }, () => {
  it("T-P71.CLIAuth.1: auth set rejects official Anthropic/OpenAI URLs", async () => {
    await flushReporter();
    for (const [name, url] of [
      ["openai", "https://api.openai.com/v1"],
      ["anthropic", "https://api.anthropic.com/v1"],
    ] as const) {
      const { dir, cleanup } = makeTmpDir("auth-official");
      const authPath = join(dir, "auth.json");
      try {
        // Given: auth set is called with an official direct-vendor URL.
        // When: runAuthSubcommand("set", ...) runs.
        // Then: it fails before writing a provider entry.
        const result = await captureCli(() =>
          runAuthSubcommand("set", {
            url,
            key: "sk-direct",
            model: name === "openai" ? "gpt-4o" : "claude-sonnet-4-5",
            name,
            authPath,
            fetchImpl: okModelsFetch(),
          }),
        );

        assert.ok(blocked(result), `${name} official URL must be rejected`);
        assert.equal(readAuth(authPath)?.providers?.[name], undefined, `${name} provider must not be written`);
      } finally {
        cleanup();
      }
    }
  });

  it("T-P71.CLIAuth.2: auth default rejects direct provider specs", async () => {
    await flushReporter();
    for (const spec of ["anthropic:claude-sonnet-4-5", "openai:gpt-4o"]) {
      const { dir, cleanup } = makeTmpDir("auth-default");
      const authPath = join(dir, "auth.json");
      try {
        // Given: auth has an existing safe default and command input is a direct provider spec.
        // When: runAuthSubcommand("default", {spec}) runs.
        // Then: it fails and leaves the existing default unchanged.
        writeAuth(
          {
            default: "deepseek:deepseek-v4-flash",
            providers: { deepseek: { key: "sk-deepseek", baseUrl: "https://api.deepseek.com/v1", type: "openai" } },
          },
          authPath,
        );

        const result = await captureCli(() => runAuthSubcommand("default", { spec, authPath }));
        assert.ok(blocked(result), `${spec} must be rejected as a direct default`);
        assert.equal(readAuth(authPath)?.default, "deepseek:deepseek-v4-flash");
      } finally {
        cleanup();
      }
    }
  });

  it("T-P71.CLIAuth.3: auth set accepts DeepSeek/custom URL", async () => {
    await flushReporter();
    const { dir, cleanup } = makeTmpDir("auth-deepseek");
    const authPath = join(dir, "auth.json");
    try {
      // Given: auth set uses DeepSeek/custom URL, key, model, name, and --default.
      // When: runAuthSubcommand("set", ...) runs.
      // Then: it writes providers.deepseek as type:"openai" and sets the default.
      const result = await captureCli(() =>
        runAuthSubcommand("set", {
          url: "https://api.deepseek.com/v1",
          key: "sk-deepseek",
          model: "deepseek-v4-flash",
          name: "deepseek",
          asDefault: true,
          authPath,
          fetchImpl: okModelsFetch(),
        }),
      );
      assert.equal(result.thrown, undefined);
      assert.equal(result.exitCode, undefined);

      const auth = readAuth(authPath);
      assert.equal(auth?.default, "deepseek:deepseek-v4-flash");
      assert.equal(auth?.providers?.deepseek?.type, "openai");
      assert.equal(auth?.providers?.deepseek?.baseUrl, "https://api.deepseek.com/v1");
    } finally {
      cleanup();
    }
  });

  it("T-P71.CLIAuth.4: auth set rejects reserved provider names even with custom URLs", async () => {
    await flushReporter();
    for (const name of ["anthropic", "openai"] as const) {
      const { dir, cleanup } = makeTmpDir("auth-reserved-name");
      const authPath = join(dir, "auth.json");
      try {
        // Given: auth set uses a non-official custom URL but a reserved provider name.
        // When: runAuthSubcommand("set", ...) runs.
        // Then: it fails before model-list fetch or provider write.
        const result = await captureCli(() =>
          runAuthSubcommand("set", {
            url: "https://custom.example/v1",
            key: "sk-custom",
            model: "custom-model",
            name,
            authPath,
            fetchImpl: okModelsFetch(),
          }),
        );

        assert.ok(blocked(result), `${name} must remain reserved`);
        assert.equal(readAuth(authPath)?.providers?.[name], undefined);
      } finally {
        cleanup();
      }
    }
  });

  it("T-P71.CLISearch.1: search set no longer stores Brave/Tavily as supported product search", async () => {
    await flushReporter();
    const { dir, cleanup } = makeTmpDir("search-set");
    const cfgPath = join(dir, "search.json");
    try {
      // Given: search set receives Brave/Tavily direct API keys.
      // When: runSearchSubcommand("set", ...) runs.
      // Then: it reports unsupported/disabled or exits, and writes no new direct search keys.
      const result = await captureCli(() =>
        runSearchSubcommand("set", { braveApiKey: "bsa-new", tavilyApiKey: "tvly-new", cfgPath }),
      );

      assert.ok(blocked(result), "direct search key setup must be unsupported");
      assert.deepEqual(readSearchConfig(cfgPath), {}, "search set must not persist new Brave/Tavily keys");
    } finally {
      cleanup();
    }
  });

  it("T-P71.CLISearch.2: search status labels existing Brave/Tavily keys as legacy ignored", async () => {
    await flushReporter();
    const { dir, cleanup } = makeTmpDir("search-status");
    const cfgPath = join(dir, "search.json");
    try {
      // Given: legacy Brave/Tavily search keys already exist.
      // When: runSearchSubcommand("status") runs.
      // Then: output masks keys and labels them ignored/unsupported by web_search.
      writeSearchConfig({ braveApiKey: "bsa-existing1234", tavilyApiKey: "tvly-existing5678" }, cfgPath);
      const result = await captureCli(() => runSearchSubcommand("status", { cfgPath }));
      const output = result.stdout + result.stderr;

      assert.match(output, /\*\*\*1234|\*\*\*5678/, `status must keep masking legacy keys; got ${output}`);
      assert.doesNotMatch(output, /bsa-existing1234|tvly-existing5678/, "status must not reveal plaintext search keys");
      assert.match(
        output,
        /legacy|ignored|unsupported|disabled/i,
        `status must label search keys ignored; got ${output}`,
      );
    } finally {
      cleanup();
    }
  });

  it("T-P71.CLIStatus.1: aggregate status labels legacy direct search keys as ignored", async () => {
    await flushReporter();
    const { dir, cleanup } = makeTmpDir("status-search");
    try {
      // Given: aggregate status receives a legacy search config path containing Brave/Tavily keys.
      // When: runStatusSubcommand() renders the status output.
      // Then: the search line masks keys and says they are legacy ignored/unsupported.
      const authPath = join(dir, "auth.json");
      const identityPath = join(dir, "identity.json");
      const schedulePath = join(dir, "schedule.jsonl");
      const tcPath = join(dir, "telegram.json");
      const memoryDbPath = join(dir, "memory.sqlite");
      const searchPath = join(dir, "search.json");
      writeSearchConfig({ braveApiKey: "bsa-status1234", tavilyApiKey: "tvly-status5678" }, searchPath);
      writeFileSync(schedulePath, "", "utf8");

      const result = await captureCli(() =>
        runStatusSubcommand({
          authPath,
          identityPath,
          schedulePath,
          tcPath,
          memoryDbPath,
          cdpPort: 29999,
          searchPath,
        }),
      );
      const output = result.stdout + result.stderr;

      assert.match(output, /search:/, `aggregate status must include search line; got ${output}`);
      assert.doesNotMatch(output, /bsa-status1234|tvly-status5678/, "aggregate status must not reveal plaintext keys");
      assert.match(
        output,
        /legacy|ignored|unsupported|disabled/i,
        `search status must label legacy keys ignored; got ${output}`,
      );
    } finally {
      cleanup();
    }
  });

  it("T-P71.CLITelegram.1: launchd env snapshot does not include Anthropic/OpenAI provider keys", () => {
    // Given: launchd EnvSnapshot and Telegram env snapshot source.
    // When: the source is scanned for snapshotted provider key names.
    // Then: Anthropic/OpenAI keys are not part of the launchd snapshot surface; DeepSeek remains allowed.
    const telegramSource = readFileSync(join(REPO, "src", "cli", "subcommands", "telegram.ts"), "utf8");
    const launchdSource = readFileSync(join(REPO, "src", "cli", "subcommands", "launchd.ts"), "utf8");

    assert.doesNotMatch(telegramSource, /ANTHROPIC_API_KEY|OPENAI_API_KEY/);
    assert.doesNotMatch(launchdSource, /ANTHROPIC_API_KEY|OPENAI_API_KEY/);
    assert.match(`${telegramSource}\n${launchdSource}`, /DEEPSEEK_API_KEY/);
  });
});
