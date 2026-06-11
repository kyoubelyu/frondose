import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runStatusSubcommand } from "../../src/cli/subcommands/status.js";
import { readSearchConfig, writeSearchConfig } from "../../src/persistence/search.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

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

function makeTmpDir(label: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", `mai-p71-${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const flushReporter = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

// P-APP-11 stage (b1): T-P71.CLIAuth.1-4 and T-P71.CLISearch.1-2 removed — auth/search subcommands deleted.
// T-P71.CLIStatus.1 and T-P71.CLITelegram.1 target KEPT surfaces (status/telegram) → preserved.

describe("P-71 transitional CLI provider/search guards", { concurrency: 1 }, () => {
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
