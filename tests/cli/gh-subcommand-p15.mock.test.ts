/**
 * P-15 Step 4a scaffolds — T-GhSet.1..T-GhSet.6 (G-P15.1..G-P15.6)
 *
 * Tests for the `case "set":` body rewrite in src/cli/subcommands/gh.ts.
 * Validates the P-15 bug fix: `mai gh set` partial-update preserves existing
 * token/repo when only one flag is supplied, and emits a no-op message when
 * called with no flags and an existing config.
 *
 * Gate coverage map:
 *   G-P15.1 — set --repo with existing token preserves token + updates repo → T-GhSet.3
 *   G-P15.2 — set --token with existing repo preserves repo + replaces token → T-GhSet.4
 *   G-P15.3 — no-op guard fires: existing config + no flags, non-TTY (T-GhSet.1) + TTY (T-GhSet.2)
 *   G-P15.4 — missing-token guidance regression (fresh config, no flags, non-TTY) → T-GhSet.6
 *   G-P15.5 — fresh-config both-flags success regression → T-GhSet.5
 *   G-P15.6 — zero reads of operator's real home config (cfgPath DI into mkdtempSync across all tests)
 *
 * All assertion bodies are assert.fail("TODO Step 5: ...") — validator fills at Step 5.
 *
 * Seeding discipline (RISK-4 / OQ-4):
 *   Pre-existing state MUST be written to secrets.json co-located with cfgPath
 *   (NOT to cfgPath itself), because writeGithubConfig routes through the P-24
 *   shim at src/persistence/github.ts:28-31 which maps any test path to a
 *   co-located secrets.json. Pattern: seedSecrets(dir, {...}) writes
 *   join(dir, "secrets.json"); cfgPath = join(dir, "github.json").
 *
 * CONCERN-LR-1 note (from docs/phase-15-critics.md):
 *   T-GhSet.1 must prove writeGithubConfig was NOT called (a same-content write
 *   would still pass a naive read-back check). Step 5 validator should add a
 *   statSync mtime check on secrets.json (record mtime before call, assert
 *   unchanged after) OR a mock.method spy on the writeGithubConfig export.
 *   The intent is captured in the T-GhSet.1 TODO assert.fail message below.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Prompter } from "../../src/cli/subcommands/_prompts.js";
import { runGhSubcommand } from "../../src/cli/subcommands/gh.js";
import { readGithubConfig } from "../../src/persistence/github.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Mock prompter — apiKeyInput records calls and returns sentinel "FROM-PROMPT".
 * Uses `as` cast so the shape satisfies the Prompter interface without needing
 * to stub every method (gh.ts case "set" only calls apiKeyInput).
 */
function makeMockPrompter(): Prompter & { calls: { apiKeyInput: string[] } } {
  const calls = { apiKeyInput: [] as string[] };
  return {
    calls,
    providerSelect: async () => "",
    apiKeyInput: async (msg: string) => {
      calls.apiKeyInput.push(msg);
      return "FROM-PROMPT";
    },
    confirmDefault: async () => false,
    sessionsSelect: async () => "",
    schedulesSelect: async () => null,
    telegramUserSelect: async () => null,
    confirm: async () => false,
    axisSelect: async () => "",
    input: async () => "mock-input-value",
    checkboxSections: async () => [],
    modelSelect: async () => "",
  } as Prompter & { calls: { apiKeyInput: string[] } };
}

/** Create a temp dir + derive cfgPath (github.json inside it) for DI. */
function makeTmpDir(): { dir: string; cfgPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mai-p15-ghcli-"));
  return {
    dir,
    cfgPath: join(dir, "github.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Seed co-located secrets.json with a pre-existing github sub-block.
 * writeGithubConfig routes to secrets.json (P-24 shim), NOT to cfgPath
 * (github.json), so seeding must target secrets.json to be visible to
 * readGithubConfig and the case "set" body's `existing` read.
 */
function seedSecrets(dir: string, github: { token: string; repo: string }): void {
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({ schema_version: 1, github }), "utf-8");
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

// ─── T-GhSet — mai gh set partial-update + no-op + guidance ──────────────────

describe("runGhSubcommand 'set' — partial-update + no-op + guidance (P-15 bug fix)", () => {
  it("T-GhSet.1: 'set' no args + existing config + non-TTY → no-op message; writeGithubConfig NOT called; config unchanged; no exit", async () => {
    // Given: temp dir with seeded secrets.json {schema_version:1, github:{token:"ghp_old",repo:"own/r"}};
    //        process.stdin.isTTY = undefined (non-interactive); mockPrompter recording calls;
    //        process.exit mocked to record exitCode (pre-P15 code calls exit on no-token path)
    // When:  runGhSubcommand("set", { cfgPath }, mockPrompter) — no token or repo opts
    // Then:  stdout === "✓ no changes; existing github config preserved\n" (exact no-op message);
    //        writeGithubConfig NOT called — CONCERN-LR-1: verify via statSync mtime check
    //        (record join(dir,"secrets.json") mtime before call, assert unchanged after);
    //        readGithubConfig(cfgPath).token === "ghp_old" AND .repo === "own/r";
    //        mockPrompter.calls.apiKeyInput.length === 0; exitCode === undefined
    const { dir, cfgPath, cleanup } = makeTmpDir();
    const savedIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    const savedFlag = process.env.MAI_NO_INTERACTIVE;
    (process.stdin as { isTTY?: boolean }).isTTY = undefined;
    delete process.env.MAI_NO_INTERACTIVE;
    let _exitCode: number | undefined;
    const origExit = process.exit.bind(process);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process as any).exit = (code: number) => {
      _exitCode = code;
    };
    try {
      seedSecrets(dir, { token: "ghp_old", repo: "own/r" });
      const mp = makeMockPrompter();
      const mtimeBefore = statSync(join(dir, "secrets.json")).mtimeMs;
      const stdout1 = await captureStdout(() => runGhSubcommand("set", { cfgPath }, mp));
      assert.equal(
        stdout1,
        "✓ no changes; existing github config preserved\n",
        "T-GhSet.1: exact no-op message on stdout",
      );
      assert.equal(
        statSync(join(dir, "secrets.json")).mtimeMs,
        mtimeBefore,
        "T-GhSet.1 CONCERN-LR-1: secrets.json must NOT be written on no-op path",
      );
      const cfg1 = readGithubConfig(cfgPath);
      assert.equal(cfg1.token, "ghp_old", "T-GhSet.1: token unchanged");
      assert.equal(cfg1.repo, "own/r", "T-GhSet.1: repo unchanged");
      assert.equal(mp.calls.apiKeyInput.length, 0, "T-GhSet.1: prompter not called");
      assert.equal(_exitCode, undefined, "T-GhSet.1: process.exit not called");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = origExit;
      (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
      if (savedFlag !== undefined) process.env.MAI_NO_INTERACTIVE = savedFlag;
      else delete process.env.MAI_NO_INTERACTIVE;
      cleanup();
    }
  });

  it("T-GhSet.2: 'set' no args + existing token + TTY → prompter NOT called; no-op message; config unchanged", async () => {
    // Given: temp dir with seeded secrets.json {schema_version:1, github:{token:"ghp_old",repo:"own/r"}};
    //        process.stdin.isTTY = true (interactive); mockPrompter returning "FROM-PROMPT"
    // When:  runGhSubcommand("set", { cfgPath }, mockPrompter)
    // Then:  mockPrompter.calls.apiKeyInput.length === 0 (prompt SKIPPED — key UX fix:
    //        existing.token truthy → new predicate !resolvedToken && !existing.token is false);
    //        stdout contains "✓ no changes; existing github config preserved";
    //        readGithubConfig(cfgPath).token === "ghp_old" (NOT replaced by "FROM-PROMPT")
    const { dir, cfgPath, cleanup } = makeTmpDir();
    const savedIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    const savedFlag = process.env.MAI_NO_INTERACTIVE;
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    delete process.env.MAI_NO_INTERACTIVE;
    try {
      seedSecrets(dir, { token: "ghp_old", repo: "own/r" });
      const mp = makeMockPrompter();
      const stdout2 = await captureStdout(() => runGhSubcommand("set", { cfgPath }, mp));
      assert.equal(
        mp.calls.apiKeyInput.length,
        0,
        "T-GhSet.2: interactive prompt NOT called (existing.token truthy → prompt predicate false)",
      );
      assert.ok(stdout2.includes("✓ no changes; existing github config preserved"), "T-GhSet.2: no-op message present");
      const cfg2 = readGithubConfig(cfgPath);
      assert.equal(cfg2.token, "ghp_old", "T-GhSet.2: token NOT replaced by FROM-PROMPT");
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
      if (savedFlag !== undefined) process.env.MAI_NO_INTERACTIVE = savedFlag;
      else delete process.env.MAI_NO_INTERACTIVE;
      cleanup();
    }
  });

  it("T-GhSet.3: 'set' --repo only + existing token + non-TTY → token preserved; repo updated; success message; no exit", async () => {
    // Given: temp dir with seeded secrets.json {schema_version:1, github:{token:"ghp_old",repo:"own/old"}};
    //        process.stdin.isTTY = undefined (non-interactive)
    // When:  runGhSubcommand("set", { repo: "own/new", cfgPath }, mockPrompter)
    // Then:  readGithubConfig(cfgPath).token === "ghp_old" (token PRESERVED — G-P15.1 bug fix);
    //        readGithubConfig(cfgPath).repo === "own/new" (repo updated);
    //        stdout contains "[gh] github.json updated (repo: own/new)";
    //        mockPrompter.calls.apiKeyInput.length === 0; exitCode === undefined
    const { dir, cfgPath, cleanup } = makeTmpDir();
    const savedIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    const savedFlag = process.env.MAI_NO_INTERACTIVE;
    (process.stdin as { isTTY?: boolean }).isTTY = undefined;
    delete process.env.MAI_NO_INTERACTIVE;
    let _exitCode: number | undefined;
    const origExit = process.exit.bind(process);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process as any).exit = (code: number) => {
      _exitCode = code;
    };
    try {
      seedSecrets(dir, { token: "ghp_old", repo: "own/old" });
      const mp = makeMockPrompter();
      const stdout3 = await captureStdout(() => runGhSubcommand("set", { repo: "own/new", cfgPath }, mp));
      const cfg3 = readGithubConfig(cfgPath);
      assert.equal(
        cfg3.token,
        "ghp_old",
        "T-GhSet.3: existing token PRESERVED (G-P15.1 bug fix — --repo only must not lose token)",
      );
      assert.equal(cfg3.repo, "own/new", "T-GhSet.3: repo UPDATED to own/new");
      assert.ok(stdout3.includes("[gh] github.json updated (repo: own/new)"), "T-GhSet.3: success message with repo");
      assert.equal(mp.calls.apiKeyInput.length, 0, "T-GhSet.3: prompter not called");
      assert.equal(_exitCode, undefined, "T-GhSet.3: process.exit not called");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = origExit;
      (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
      if (savedFlag !== undefined) process.env.MAI_NO_INTERACTIVE = savedFlag;
      else delete process.env.MAI_NO_INTERACTIVE;
      cleanup();
    }
  });

  it("T-GhSet.4: 'set' --token only + existing repo + non-TTY → token replaced; repo preserved; success message does NOT leak token", async () => {
    // Given: temp dir with seeded secrets.json {schema_version:1, github:{token:"ghp_old",repo:"own/r"}};
    //        process.stdin.isTTY = undefined
    // When:  runGhSubcommand("set", { token: "ghp_new", cfgPath }, mockPrompter)
    // Then:  readGithubConfig(cfgPath).token === "ghp_new" (replaced — G-P15.2);
    //        readGithubConfig(cfgPath).repo === "own/r" (preserved);
    //        stdout includes "[gh] github.json updated" AND does NOT include "ghp_new"
    //        (token value masked from message — existing convention preserved per plan §5.2)
    const { dir, cfgPath, cleanup } = makeTmpDir();
    const savedIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    const savedFlag = process.env.MAI_NO_INTERACTIVE;
    (process.stdin as { isTTY?: boolean }).isTTY = undefined;
    delete process.env.MAI_NO_INTERACTIVE;
    try {
      seedSecrets(dir, { token: "ghp_old", repo: "own/r" });
      const mp = makeMockPrompter();
      const stdout4 = await captureStdout(() => runGhSubcommand("set", { token: "ghp_new", cfgPath }, mp));
      const cfg4 = readGithubConfig(cfgPath);
      assert.equal(cfg4.token, "ghp_new", "T-GhSet.4: token REPLACED (G-P15.2)");
      assert.equal(cfg4.repo, "own/r", "T-GhSet.4: repo PRESERVED");
      assert.ok(stdout4.includes("[gh] github.json updated"), "T-GhSet.4: success message present");
      assert.ok(!stdout4.includes("ghp_new"), "T-GhSet.4: token value NOT leaked in stdout");
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
      if (savedFlag !== undefined) process.env.MAI_NO_INTERACTIVE = savedFlag;
      else delete process.env.MAI_NO_INTERACTIVE;
      cleanup();
    }
  });

  it("T-GhSet.5: 'set' --token + --repo + no existing config + non-TTY → both fields written; success message; no exit", async () => {
    // Given: temp dir with NO pre-seeded secrets.json (fresh config);
    //        process.stdin.isTTY = undefined (non-interactive)
    // When:  runGhSubcommand("set", { token: "ghp_new", repo: "own/r", cfgPath }, mockPrompter)
    // Then:  readGithubConfig(cfgPath).token === "ghp_new";
    //        readGithubConfig(cfgPath).repo === "own/r";
    //        stdout includes "[gh] github.json updated (repo: own/r)";
    //        exitCode === undefined
    //        (Regression guard: G-P15.5 — fresh-config path still works after P-15 fix)
    const { cfgPath, cleanup } = makeTmpDir();
    const savedIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    const savedFlag = process.env.MAI_NO_INTERACTIVE;
    (process.stdin as { isTTY?: boolean }).isTTY = undefined;
    delete process.env.MAI_NO_INTERACTIVE;
    try {
      const mp = makeMockPrompter();
      const stdout5 = await captureStdout(() =>
        runGhSubcommand("set", { token: "ghp_new", repo: "own/r", cfgPath }, mp),
      );
      const cfg5 = readGithubConfig(cfgPath);
      assert.equal(cfg5.token, "ghp_new", "T-GhSet.5: token written to fresh config (G-P15.5 regression)");
      assert.equal(cfg5.repo, "own/r", "T-GhSet.5: repo written to fresh config");
      assert.ok(stdout5.includes("[gh] github.json updated (repo: own/r)"), "T-GhSet.5: success message");
    } finally {
      (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
      if (savedFlag !== undefined) process.env.MAI_NO_INTERACTIVE = savedFlag;
      else delete process.env.MAI_NO_INTERACTIVE;
      cleanup();
    }
  });

  it("T-GhSet.6: 'set' no args + no existing config + non-TTY → guidance + exit(1); prompter NOT called", async () => {
    // Given: temp dir with NO pre-seeded secrets.json; process.stdin.isTTY = undefined;
    //        process.exit mocked to record exitCode
    // When:  runGhSubcommand("set", { cfgPath }, mockPrompter)
    // Then:  exitCode === 1 (process.exit(1) called — G-P15.4);
    //        stderr contains "gh set" AND "<token>" (printNoninteractiveGuidance fires);
    //        mockPrompter.calls.apiKeyInput.length === 0 (non-TTY → no prompt)
    //        (Regression guard: missing-token-required path still works post-fix)
    const { cfgPath, cleanup } = makeTmpDir();
    const savedIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    const savedFlag = process.env.MAI_NO_INTERACTIVE;
    (process.stdin as { isTTY?: boolean }).isTTY = undefined;
    delete process.env.MAI_NO_INTERACTIVE;
    let _exitCode: number | undefined;
    const origExit = process.exit.bind(process);
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    (process as any).exit = (code: number) => {
      _exitCode = code;
    };
    try {
      const mp = makeMockPrompter();
      const stderr6 = await captureStderr(() => runGhSubcommand("set", { cfgPath }, mp));
      assert.equal(_exitCode, 1, "T-GhSet.6: process.exit(1) called (G-P15.4 guidance path)");
      assert.ok(stderr6.includes("gh set"), "T-GhSet.6: guidance contains 'gh set'");
      assert.ok(stderr6.includes("<token>"), "T-GhSet.6: guidance contains '<token>'");
      assert.equal(mp.calls.apiKeyInput.length, 0, "T-GhSet.6: prompter not called (non-interactive)");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore
      (process as any).exit = origExit;
      (process.stdin as { isTTY?: boolean }).isTTY = savedIsTTY;
      if (savedFlag !== undefined) process.env.MAI_NO_INTERACTIVE = savedFlag;
      else delete process.env.MAI_NO_INTERACTIVE;
      cleanup();
    }
  });
});
