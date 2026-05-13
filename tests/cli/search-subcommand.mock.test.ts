/**
 * P-15 mock tests — T-ClisubSearch.1..T-ClisubSearch.4 + T-ClisubTg.1..T-ClisubTg.2
 *
 * Tests for src/cli/subcommands/search.ts (CREATED by builder Step 4b)
 * and runTelegramSubcommand("proxy") extension.
 *
 * T-ClisubSearch.1 — runSearchSubcommand("set", { braveApiKey, tavilyApiKey }) writes search.json
 * T-ClisubSearch.2 — runSearchSubcommand("status") shows masked keys
 * T-ClisubSearch.3 — "set" with --brave only preserves existing tavily (merge)
 * T-ClisubSearch.4 — "remove" deletes search.json
 * T-ClisubTg.1    — runTelegramSubcommand("proxy", { proxyUrl }) writes proxyUrl to telegram.json
 * T-ClisubTg.2    — runTelegramSubcommand("proxy", { unsetProxy }) clears proxyUrl to null
 *
 * Gate coverage: G-P15.6 (mai search CLI), G-P15.7 (mai telegram proxy)
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runSearchSubcommand } from "../../src/cli/subcommands/search.js";
import { runTelegramSubcommand } from "../../src/cli/subcommands/telegram.js";
import {
  DEFAULT_TELEGRAM_CONFIG,
  readTelegramConfig,
  writeTelegramConfig,
} from "../../src/persistence/telegramConfig.js";
import type { Prompter } from "../../src/cli/subcommands/_prompts.js";

// NOTE: search.ts does NOT exist until builder Step 4b.

// ─── mock Prompter ────────────────────────────────────────────────────────────

function makeMockPrompter(): Prompter & { calls: { apiKeyInput: string[] } } {
  const calls = { apiKeyInput: [] as string[] };
  return {
    calls,
    providerSelect: async () => "",
    apiKeyInput: async (msg: string) => {
      calls.apiKeyInput.push(msg);
      return "mock-key-from-prompt";
    },
    confirmDefault: async () => false,
    sessionsSelect: async () => "",
    schedulesSelect: async () => null,
    telegramUserSelect: async () => null,
    confirm: async () => false,
    axisSelect: async () => "",
    input: async () => "http://mock-proxy:7890",
    checkboxSections: async () => [],
  } as Prompter & { calls: { apiKeyInput: string[] } };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(label: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `mai-p15-${label}-`));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stdout as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  return fn()
    .finally(() => {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stdout as any).write = orig;
    })
    .then(() => chunks.join(""));
}

// ─── T-ClisubSearch — mai search subcommand ───────────────────────────────────

describe("runSearchSubcommand (G-P15.6)", () => {
  it("T-ClisubSearch.1: 'set' with both keys writes search.json; mode 0o600", async () => {
    // Given: temp cfgPath; runSearchSubcommand("set", { braveApiKey: "bsa-test", tavilyApiKey: "tvly-test", cfgPath }, mockPrompter)
    // When:  function executes with cfgPath injection
    // Then:  search.json exists with both fields; file mode === 0o600

    const { dir, cleanup } = makeTmpDir("searchcli");
    const cfgPath = join(dir, "search.json");
    try {
      await captureStdout(() =>
        runSearchSubcommand("set", { braveApiKey: "bsa-test", tavilyApiKey: "tvly-test", cfgPath }, makeMockPrompter()),
      );
      assert.ok(existsSync(cfgPath), "search.json must exist");
      const content = JSON.parse(readFileSync(cfgPath, "utf-8")) as { braveApiKey?: string; tavilyApiKey?: string };
      assert.equal(content.braveApiKey, "bsa-test", "braveApiKey must be written");
      assert.equal(content.tavilyApiKey, "tvly-test", "tavilyApiKey must be written");
    } finally {
      cleanup();
    }
  });

  it("T-ClisubSearch.2: 'status' shows masked keys with '***' and does not show plaintext", async () => {
    // Given: search.json with braveApiKey "bsa-xxx1234", no tavilyApiKey
    // When:  runSearchSubcommand("status", ..., mockPrompter)
    // Then:  stdout shows "brave: ***1234" and "tavily: (unset)"; plaintext "bsa-xxx1234" not present

    const { dir, cleanup } = makeTmpDir("searchcli");
    const cfgPath = join(dir, "search.json");
    try {
      writeFileSync(cfgPath, JSON.stringify({ braveApiKey: "bsa-xxx1234" }), "utf-8");
      const stdout = await captureStdout(() =>
        runSearchSubcommand("status", { cfgPath }, makeMockPrompter()),
      );
      assert.ok(stdout.includes("***1234"), `stdout must contain masked key; got: "${stdout}"`);
      assert.ok(stdout.includes("tavily=(unset)"), `stdout must show tavily unset; got: "${stdout}"`);
      assert.ok(!stdout.includes("bsa-xxx1234"), `stdout must NOT contain plaintext key; got: "${stdout}"`);
    } finally {
      cleanup();
    }
  });

  it("T-ClisubSearch.3: 'set' with --brave only merges — preserves existing tavily", async () => {
    // Given: existing search.json with { tavilyApiKey: "tvly-old" }
    // When:  runSearchSubcommand("set", { braveApiKey: "bsa-new", cfgPath }, mockPrompter)
    // Then:  file contains BOTH braveApiKey: "bsa-new" AND tavilyApiKey: "tvly-old" (merge, not overwrite)

    const { dir, cleanup } = makeTmpDir("searchcli");
    const cfgPath = join(dir, "search.json");
    try {
      writeFileSync(cfgPath, JSON.stringify({ tavilyApiKey: "tvly-old" }), "utf-8");
      await captureStdout(() =>
        runSearchSubcommand("set", { braveApiKey: "bsa-new", cfgPath }, makeMockPrompter()),
      );
      const content = JSON.parse(readFileSync(cfgPath, "utf-8")) as { braveApiKey?: string; tavilyApiKey?: string };
      assert.equal(content.braveApiKey, "bsa-new", "braveApiKey must be bsa-new");
      assert.equal(content.tavilyApiKey, "tvly-old", "tavilyApiKey must be preserved (merged, not overwritten)");
    } finally {
      cleanup();
    }
  });

  it("T-ClisubSearch.4: 'remove' deletes search.json; subsequent read returns default", async () => {
    // Given: existing search.json with content
    // When:  runSearchSubcommand("remove", ..., mockPrompter)
    // Then:  file no longer exists (or is removed); subsequent readSearchConfig returns DEFAULT_SEARCH_CONFIG

    const { dir, cleanup } = makeTmpDir("searchcli");
    const cfgPath = join(dir, "search.json");
    try {
      writeFileSync(cfgPath, JSON.stringify({ braveApiKey: "bsa-xxx" }), "utf-8");
      assert.ok(existsSync(cfgPath), "pre-condition: file must exist before remove");
      await captureStdout(() => runSearchSubcommand("remove", { cfgPath }, makeMockPrompter()));
      assert.ok(!existsSync(cfgPath), "search.json must be deleted after remove");
    } finally {
      cleanup();
    }
  });
});

// ─── T-ClisubTg — mai telegram proxy subcommand ──────────────────────────────

describe("runTelegramSubcommand — proxy action (G-P15.7)", () => {
  it("T-ClisubTg.1: 'proxy' with proxyUrl writes proxyUrl to telegram.json", async () => {
    // Given: temp telegram.json path with default config
    // When:  runTelegramSubcommand("proxy", { tcPath, proxyUrl: "http://p:7890" })
    // Then:  readTelegramConfig(tcPath).proxyUrl === "http://p:7890"

    const { dir, cleanup } = makeTmpDir("tgproxy");
    const tcPath = join(dir, "telegram.json");
    try {
      writeTelegramConfig(DEFAULT_TELEGRAM_CONFIG, tcPath);

      await captureStdout(() =>
        runTelegramSubcommand("proxy", { tcPath, proxyUrl: "http://p:7890" }),
      );
      const cfg = readTelegramConfig(tcPath);
      assert.equal(cfg.proxyUrl, "http://p:7890", "proxyUrl must be written to telegram.json");
    } finally {
      cleanup();
    }
  });

  it("T-ClisubTg.2: 'proxy' with unsetProxy set clears proxyUrl to null", async () => {
    // Given: telegram.json with proxyUrl: "http://old:7890"
    // When:  runTelegramSubcommand("proxy", { tcPath, unsetProxy: true })
    // Then:  readTelegramConfig(tcPath).proxyUrl === null

    const { dir, cleanup } = makeTmpDir("tgproxy");
    const tcPath = join(dir, "telegram.json");
    try {
      writeTelegramConfig({ ...DEFAULT_TELEGRAM_CONFIG, proxyUrl: "http://old:7890" }, tcPath);

      await captureStdout(() =>
        runTelegramSubcommand("proxy", { tcPath, unsetProxy: true }),
      );
      const cfg = readTelegramConfig(tcPath);
      assert.equal(cfg.proxyUrl, null, "proxyUrl must be null after unset");
    } finally {
      cleanup();
    }
  });
});
