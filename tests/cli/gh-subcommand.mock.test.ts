/**
 * P-15 mock tests — T-ClisubGh.1..T-ClisubGh.4
 *
 * Tests for src/cli/subcommands/gh.ts (CREATED by builder Step 4b).
 *
 * T-ClisubGh.1 — runGhSubcommand("set", { token, repo }) writes github.json with fields; mode 0o600
 * T-ClisubGh.2 — runGhSubcommand("set", {}) missing token + TTY → prompts user for token
 * T-ClisubGh.3 — runGhSubcommand("set", {}) missing token + non-TTY → printNoninteractiveGuidance + exit(1)
 * T-ClisubGh.4 — runGhSubcommand("status") prints masked token and repo; does NOT print plaintext token
 *
 * Gate coverage: G-P15.5 (mai gh CLI subcommand)
 *
 * NOTE: gh.ts does NOT exist until builder Step 4b.
 * These scaffolds will fail to compile until then.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runGhSubcommand } from "../../src/cli/subcommands/gh.js";
import type { Prompter } from "../../src/cli/subcommands/_prompts.js";

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
    input: async () => "mock-input-value",
    checkboxSections: async () => [],
  } as Prompter & { calls: { apiKeyInput: string[] } };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(): { dir: string; cfgPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p15-ghcli-"));
  return {
    dir,
    cfgPath: join(dir, "github.json"),
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

function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  (process.stderr as any).write = (chunk: string | Buffer) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  return fn()
    .finally(() => {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process.stderr as any).write = orig;
    })
    .then(() => chunks.join(""));
}

// ─── T-ClisubGh — mai gh subcommand ───────────────────────────────────────────

describe("runGhSubcommand (G-P15.5)", () => {
  it("T-ClisubGh.1: 'set' with token + repo writes github.json with both fields; mode 0o600", async () => {
    // Given: temp cfgPath; runGhSubcommand("set", { token: "ghp_test", repo: "own/r", cfgPath }, mockPrompter)
    // When:  function executes with cfgPath injection
    // Then:  github.json exists with { "token": "ghp_test", "repo": "own/r" }; file mode === 0o600

    const { cfgPath, cleanup } = makeTmpDir();
    try {
      await captureStdout(() =>
        runGhSubcommand("set", { token: "ghp_test", repo: "own/r", cfgPath }, makeMockPrompter()),
      );
      assert.ok(existsSync(cfgPath), "github.json must exist after 'set'");
      const content = JSON.parse(readFileSync(cfgPath, "utf-8")) as { token?: string; repo?: string };
      assert.equal(content.token, "ghp_test", "token must be written");
      assert.equal(content.repo, "own/r", "repo must be written");
      const mode = statSync(cfgPath).mode & 0o777;
      assert.equal(mode, 0o600, `file mode must be 0o600; got ${mode.toString(8)}`);
    } finally {
      cleanup();
    }
  });

  it("T-ClisubGh.2: 'set' missing token + TTY → prompts via prompter.apiKeyInput then writes token", async () => {
    // Given: TTY (isInteractive returns true), no token provided
    // When:  runGhSubcommand("set", {}, mockPrompter) where prompter.apiKeyInput returns "ghp_prompted"
    // Then:  prompter.apiKeyInput called with "GitHub PAT"; token "ghp_prompted" written to file

    const { cfgPath, cleanup } = makeTmpDir();
    // Stub isInteractive to return true
    const savedIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    const savedFlag = process.env.MAI_NO_INTERACTIVE;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    delete process.env.MAI_NO_INTERACTIVE;
    try {
      const mp = makeMockPrompter();
      await captureStdout(() => runGhSubcommand("set", { cfgPath }, mp));
      // Verify prompt was called
      assert.ok(mp.calls.apiKeyInput.length > 0, "prompter.apiKeyInput must be called");
      assert.equal(mp.calls.apiKeyInput[0], "GitHub PAT", "must prompt for 'GitHub PAT'");
      // Token from prompt should be written
      const content = JSON.parse(readFileSync(cfgPath, "utf-8")) as { token?: string };
      assert.equal(content.token, "mock-key-from-prompt", "token from prompt must be written to file");
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
      if (savedFlag !== undefined) process.env.MAI_NO_INTERACTIVE = savedFlag;
      else delete process.env.MAI_NO_INTERACTIVE;
      cleanup();
    }
  });

  it("T-ClisubGh.3: 'set' missing token + non-TTY → printNoninteractiveGuidance via stderr + exit(1)", async () => {
    // Given: non-TTY; no token provided
    // When:  runGhSubcommand("set", {}, mockPrompter)
    // Then:  process.exit(1) called; stderr contains non-interactive guidance message

    const { cfgPath, cleanup } = makeTmpDir();
    // Stub isInteractive to return false
    const savedIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    const savedFlag = process.env.MAI_NO_INTERACTIVE;
    (process.stdin as { isTTY?: boolean }).isTTY = undefined;
    delete process.env.MAI_NO_INTERACTIVE;

    let exitCode: number | undefined;
    const origExit = process.exit.bind(process);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process as any).exit = (code: number) => {
      exitCode = code;
    };

    try {
      const stderr = await captureStderr(() => runGhSubcommand("set", { cfgPath }, makeMockPrompter()));
      assert.equal(exitCode, 1, "must call process.exit(1) in non-interactive mode");
      assert.ok(
        stderr.includes("gh set") || stderr.includes("non-interactive"),
        `stderr must contain guidance; got: "${stderr}"`,
      );
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = origExit;
      (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
      if (savedFlag !== undefined) process.env.MAI_NO_INTERACTIVE = savedFlag;
      else delete process.env.MAI_NO_INTERACTIVE;
      cleanup();
    }
  });

  it("T-ClisubGh.4: 'status' prints masked token and repo; does NOT print plaintext token", async () => {
    // Given: github.json with token "ghp_abcdefgh1234", repo "own/r"
    // When:  runGhSubcommand("status", ..., mockPrompter)
    // Then:  stdout includes masked token (e.g. "***1234"); stdout includes repo; stdout does NOT include "ghp_abcdefgh1234"

    const { cfgPath, cleanup } = makeTmpDir();
    try {
      writeFileSync(cfgPath, JSON.stringify({ token: "ghp_abcdefgh1234", repo: "own/r" }), "utf-8");
      const stdout = await captureStdout(() =>
        runGhSubcommand("status", { cfgPath }, makeMockPrompter()),
      );
      assert.ok(stdout.includes("***1234"), `stdout must contain masked token (***1234); got: "${stdout}"`);
      assert.ok(stdout.includes("own/r"), `stdout must include repo; got: "${stdout}"`);
      assert.ok(
        !stdout.includes("ghp_abcdefgh1234"),
        `stdout must NOT contain plaintext token; got: "${stdout}"`,
      );
    } finally {
      cleanup();
    }
  });
});
