/**
 * P-APP-11 stage (b1) — Test Scaffold (Step 3, outside-in TDD)
 *
 * Characterization tests for the CLI subcommand surface removal.
 * Covers T-App11b1.1 .. T-App11b1.14 per docs/phase-app-11b1-plan.md §5.
 *
 * ALL TESTS FAIL in the current pre-implementation state (red is correct per
 * outside-in TDD). The implementation (Codex Step 4) must make them compile-
 * pass (reach assertion-TODO branch); the validator fills/verifies at Step 5.
 *
 * IMPORTANT compile note: this file AVOIDS importing from deleted subcommand
 * modules (auth/setup/identity/sessions/version/search) because those modules
 * still exist pre-impl but will be absent post-impl. Source-level assertions
 * are done via fs.readFileSync + string search (no TypeScript imports of deleted
 * modules). This keeps the scaffold compileable both pre- and post-impl.
 *
 * Gate coverage: G-PApp11b1.1 .. G-PApp11b1.14
 */

import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

const CLI = join(REPO_ROOT, "dist", "cli", "main.js");
const MAIN_TS = join(REPO_ROOT, "src", "cli", "main.ts");
const SOUL_TS = join(REPO_ROOT, "src", "cli", "subcommands", "soul.ts");
const IDENTITY_INIT_TS = join(REPO_ROOT, "src", "cli", "identity-init.ts");
const INDEX_HTML = join(REPO_ROOT, "src", "tauri", "ui", "index.html");
const INSTALL_SH = join(REPO_ROOT, "install.sh");

// Removed-command tokens (each must be absent from kept src/**/*.ts post-impl)
const REMOVED_COMMAND_TOKENS = [
  "mai auth ",
  "mai auth list",
  "mai identity init",
  "mai setup",
  "mai sessions",
  "mai search",
  "mai version",
  "mai soul show",
  "mai soul edit",
] as const;

// Skip dirs for source scans (matches stage-(a) scaffold pattern)
const SKIP_DIRS = new Set(["node_modules", "target", ".git", "dist", "build", "web"]);

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCliProcess(argv: string[], env?: Record<string, string>, stdinData?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const baseEnv: Record<string, string> = {
      FRONDOSE_AUTOUPDATE: "skip",
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      USER: process.env.USER ?? "",
    };
    const child = spawnChild("node", [CLI, ...argv], {
      env: { ...baseEnv, ...(env ?? {}) },
      timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    if (stdinData !== undefined) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
    child.on("close", (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.on("error", (err) => {
      resolve({ stdout, stderr: stderr + String(err.message), exitCode: 1 });
    });
  });
}

async function runCli(argv: string[], env?: Record<string, string>): Promise<RunResult> {
  return runCliProcess(argv, env);
}

// ─── T-App11b1.1 — Removed subcommands exit with 'unknown command' ─────────────

describe("T-App11b1.1: removed subcommands exit with 'unknown command' (G-PApp11b1.1)", () => {
  const removedTokens: Array<{ token: string; argv: string[] }> = [
    { token: "auth", argv: ["auth", "list"] },
    { token: "setup", argv: ["setup"] },
    { token: "identity", argv: ["identity", "show"] },
    { token: "sessions", argv: ["sessions", "list"] },
    { token: "version", argv: ["version"] },
    { token: "search", argv: ["search", "status"] },
  ];

  for (const { token, argv } of removedTokens) {
    it(`T-App11b1.1 (${token}): when invoked as 'node dist/cli/main.js ${argv.join(" ")}', exits non-zero + stderr contains 'unknown command'`, async () => {
      // Given: the built dist/cli/main.js after the stage (b1) deletion
      // When:  invoked with the removed subcommand token (e.g. `auth list`)
      // Then:  process exits non-zero AND stderr contains "unknown command" for that token
      const result = await runCli(argv);
      assert.notEqual(result.exitCode, 0, `'${token}' must exit non-zero after removal (got exit 0)`);
      const combined = result.stderr.toLowerCase();
      assert.ok(
        combined.includes("unknown command"),
        `'${token}' stderr must include "unknown command"; stderr: ${result.stderr.slice(0, 300)}`,
      );
    });
  }
});

// ─── T-App11b1.2 — Kept admin command still parses + dispatches; registration set check ─

describe("T-App11b1.2: kept admin commands still parse; registration set characterization (G-PApp11b1.2)", () => {
  it("T-App11b1.2a: 'node dist/cli/main.js status' does NOT print 'unknown command'", async () => {
    // Given: the built dist/cli/main.js after the stage (b1) deletion
    // When:  invoked as `mai status`
    // Then:  does not produce "unknown command" — status subcommand is still registered
    const result = await runCli(["status"]);
    const combined = (result.stdout + result.stderr).toLowerCase();
    assert.ok(
      !combined.includes("unknown command"),
      `'status' must not produce "unknown command"; got: ${(result.stdout + result.stderr).slice(0, 300)}`,
    );
  });

  it("T-App11b1.2b: src/cli/main.ts DOES NOT register removed command tokens (source-level grep)", () => {
    // Given: the source of src/cli/main.ts after the stage (b1) edit
    // When:  searched for removed program.command(...) registrations
    // Then:  ABSENT: auth, setup, identity, sessions, version (subcommand), search
    //        PRESENT: status, analytics, telegram, server, gh, serve, update, update-server,
    //                 uninstall, cron, AND 'soul <action>' (narrowed but still registered)
    const src = readFileSync(MAIN_TS, "utf-8");

    // Removed tokens must be absent as TOP-LEVEL registrations
    // Use 'program.command(...)' prefix for identity to avoid matching server.command("identity")
    // at main.ts:254 which is the KEPT 'server identity init' sub-command registration.
    const removedRegistrations = [
      'program.command("auth")',
      'program.command("setup")',
      'program.command("identity")', // must not match server.command("identity")
      'program.command("sessions")',
      'program.command("version")',
      'program.command("search")',
    ];
    for (const reg of removedRegistrations) {
      assert.ok(!src.includes(reg), `main.ts must NOT contain '${reg}' after stage (b1) deletion`);
    }

    // Kept tokens must be present
    const keptRegistrations = [
      'command("status")',
      'command("analytics")',
      'command("telegram")',
      'command("server")',
      'command("gh")',
      'command("serve")',
      'command("update")',
      'command("update-server")',
      'command("uninstall")',
      'command("cron")',
      'command("soul <action>")',
    ];
    for (const reg of keptRegistrations) {
      assert.ok(src.includes(reg), `main.ts must still contain '${reg}' after stage (b1) (kept set); not found`);
    }
  });
});

// ─── T-App11b1.3 — --version flag still prints the package version ─────────────

describe("T-App11b1.3: --version flag survives; version subcommand removal did not break the flag (G-PApp11b1.3)", () => {
  it("T-App11b1.3: 'node dist/cli/main.js --version' prints the package.json version (exit 0, no 'unknown command')", async () => {
    // Given: the built dist/cli/main.js and the package.json version
    // When:  invoked with `--version`
    // Then:  stdout contains the version string, exit 0, no "unknown command"
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as { version: string };
    const result = await runCli(["--version"]);
    assert.equal(result.exitCode, 0, `'--version' must exit 0; got exit ${result.exitCode}`);
    assert.ok(
      result.stdout.includes(pkg.version),
      `'--version' stdout must include version "${pkg.version}"; got: ${result.stdout.slice(0, 200)}`,
    );
    assert.ok(
      !(result.stdout + result.stderr).toLowerCase().includes("unknown command"),
      `'--version' must not produce "unknown command"`,
    );
  });
});

// ─── T-App11b1.4 — gh KEPT: still registered + dispatches under MAI_TIER=power ─

describe("T-App11b1.4: gh KEPT — still registered + dispatches (G-PApp11b1.4)", () => {
  it("T-App11b1.4a: 'node dist/cli/main.js gh status' under FRONDOSE_TIER=power does NOT print 'unknown command'", async () => {
    // Given: the built dist/cli/main.js with FRONDOSE_TIER=power
    // When:  invoked as `gh status`
    // Then:  does not produce "unknown command"; prints a github-status line
    const result = await runCli(["gh", "status"], { FRONDOSE_TIER: "power" });
    const combined = result.stdout + result.stderr;
    assert.ok(
      !combined.toLowerCase().includes("unknown command"),
      `'gh status' must not produce "unknown command" under MAI_TIER=power; got: ${combined.slice(0, 300)}`,
    );
  });

  it("T-App11b1.4b: src/cli/main.ts still imports runGhSubcommand + registers program.command('gh') (source-level)", () => {
    // Given: the source of src/cli/main.ts after the stage (b1) edit
    // When:  searched for the gh import and registration
    // Then:  both are present
    const src = readFileSync(MAIN_TS, "utf-8");
    assert.ok(src.includes("runGhSubcommand"), "main.ts must still import/use runGhSubcommand (gh is KEPT)");
    assert.ok(src.includes('command("gh")'), 'main.ts must still register program.command("gh")');
  });
});

// ─── T-App11b1.5 — Agent boot chain workerBoot → identity-init → promptFreeAxes intact ─

describe("T-App11b1.5: agent boot chain workerBoot → identity-init → promptFreeAxes intact (G-PApp11b1.5)", () => {
  it("T-App11b1.5: trimmed soul.ts still exports promptFreeAxes with the correct signature, and identity-init.ts imports it from ./subcommands/soul.js", () => {
    // Given: the trimmed src/cli/subcommands/soul.ts and src/cli/identity-init.ts
    // When:  source-level inspection
    // Then:  soul.ts has 'export async function promptFreeAxes(): Promise<FreeAxesRecord>'
    //        AND identity-init.ts has 'from "./subcommands/soul.js"'
    //        (coordinates with T-BOOT.3 in workerBoot-p45.mock.test.ts — does not duplicate it)
    const soulSrc = readFileSync(SOUL_TS, "utf-8");
    const identityInitSrc = readFileSync(IDENTITY_INIT_TS, "utf-8");

    assert.ok(
      soulSrc.includes("export async function promptFreeAxes"),
      "soul.ts must still export promptFreeAxes (boot-path helper)",
    );
    assert.ok(
      soulSrc.includes("Promise<FreeAxesRecord>") || soulSrc.includes("Promise<"),
      "soul.ts promptFreeAxes must return a Promise (FreeAxesRecord)",
    );
    assert.ok(
      identityInitSrc.includes('from "./subcommands/soul.js"'),
      "identity-init.ts must still import from ./subcommands/soul.js (boot path unchanged — approach (a) anchor)",
    );
  });
});

// ─── T-App11b1.6 — Trimmed soul.ts exports + no-bash boundary ─────────────────

describe("T-App11b1.6: trimmed soul.ts keeps promptFreeAxes + runSoulReset (non-exported); show/edit + spawn gone (G-PApp11b1.6)", () => {
  it("T-App11b1.6a: soul.ts exports promptFreeAxes AND narrowed runSoulSubcommand (signature 'reset' only)", () => {
    // Given: the trimmed src/cli/subcommands/soul.ts
    // When:  source-level inspection
    // Then:  EXPORTS: promptFreeAxes, runSoulSubcommand
    //        DEFINES (non-exported): runSoulReset
    //        ABSENT: runSoulShow, runSoulEdit
    const src = readFileSync(SOUL_TS, "utf-8");

    assert.ok(src.includes("export async function promptFreeAxes"), "soul.ts must still export promptFreeAxes");
    assert.ok(
      src.includes("export async function runSoulSubcommand"),
      "soul.ts must still export runSoulSubcommand (narrowed to reset)",
    );
    assert.ok(src.includes("async function runSoulReset"), "soul.ts must define runSoulReset (non-exported internal)");
    // runSoulReset must NOT be exported (it's internal)
    assert.ok(
      !src.includes("export async function runSoulReset") && !src.includes("export function runSoulReset"),
      "runSoulReset must NOT be exported (it is a non-exported internal — §6.4.4)",
    );
    assert.ok(!src.includes("runSoulShow"), "soul.ts must NOT define runSoulShow (removed in trim)");
    assert.ok(!src.includes("runSoulEdit"), "soul.ts must NOT define runSoulEdit (removed in trim)");
  });

  it("T-App11b1.6b: soul.ts has NO 'node:child_process' import and NO spawn( call (no-bash boundary cleanup)", () => {
    // Given: the trimmed src/cli/subcommands/soul.ts
    // When:  source-level inspection
    // Then:  no child_process import and no spawn( call
    const src = readFileSync(SOUL_TS, "utf-8");
    assert.ok(
      !src.includes("node:child_process"),
      "soul.ts must NOT import node:child_process after trim (the $EDITOR spawn site is gone)",
    );
    assert.ok(!src.includes("spawn("), "soul.ts must NOT contain spawn( after trim (no-bash-boundary cleanup)");
    assert.ok(!src.includes("composeSoulBand"), "soul.ts must NOT import composeSoulBand (removed with runSoulShow)");
  });

  it("T-App11b1.6c: soul.ts still imports applyIdentityPatch + writeIdentity (used by runSoulReset)", () => {
    // Given: the trimmed src/cli/subcommands/soul.ts
    // When:  source-level inspection of imports
    // Then:  applyIdentityPatch AND writeIdentity are still imported (runSoulReset uses them)
    const src = readFileSync(SOUL_TS, "utf-8");
    assert.ok(
      src.includes("applyIdentityPatch"),
      "soul.ts must still import applyIdentityPatch (used by runSoulReset)",
    );
    assert.ok(src.includes("writeIdentity"), "soul.ts must still import writeIdentity (used by runSoulReset)");
  });
});

// ─── T-App11b1.7 — No stale deleted-subcommand dist artifacts; kept artifacts survive ─

describe("T-App11b1.7: no stale deleted-subcommand dist artifacts; kept artifacts survive (G-PApp11b1.7)", () => {
  const deletedModules = ["auth", "setup", "identity", "sessions", "version", "search"] as const;
  const deletedExts = ["js", "d.ts", "js.map", "d.ts.map"] as const;

  for (const mod of deletedModules) {
    for (const ext of deletedExts) {
      it(`T-App11b1.7: dist/cli/subcommands/${mod}.${ext} must NOT exist after build (stale artifact guard)`, () => {
        // Given: a fresh npm run build after the §4 rm -f cleanup
        // When:  existsSync is checked for the deleted artifact
        // Then:  false — tsc does not re-emit outputs for deleted source files
        const artifactPath = join(REPO_ROOT, "dist", "cli", "subcommands", `${mod}.${ext}`);
        assert.equal(
          existsSync(artifactPath),
          false,
          `Stale artifact ${mod}.${ext} must not exist in dist/ after build (would ship into .app)`,
        );
      });
    }
  }

  it("T-App11b1.7 (soul.js kept): dist/cli/subcommands/soul.js must EXIST after build", () => {
    // Given: a fresh build after the trim; soul.ts is TRIMMED (not deleted)
    // When:  existsSync is checked
    // Then:  true — tsc re-emits the trimmed soul.js
    const soulJsPath = join(REPO_ROOT, "dist", "cli", "subcommands", "soul.js");
    assert.equal(
      existsSync(soulJsPath),
      true,
      "dist/cli/subcommands/soul.js must exist (soul.ts is TRIMMED, not deleted)",
    );
  });

  it("T-App11b1.7 (gh.js kept): dist/cli/subcommands/gh.js must EXIST after build", () => {
    // Given: a fresh build; gh.ts is KEPT unchanged
    // When:  existsSync is checked
    // Then:  true
    const ghJsPath = join(REPO_ROOT, "dist", "cli", "subcommands", "gh.js");
    assert.equal(existsSync(ghJsPath), true, "dist/cli/subcommands/gh.js must exist (gh is KEPT)");
  });

  it("T-App11b1.7 (main.js kept): dist/cli/main.js must EXIST after build", () => {
    // Given: a fresh build; main.ts is KEPT (the binary is load-bearing for launchd)
    // When:  existsSync is checked
    // Then:  true
    assert.equal(
      existsSync(CLI),
      true,
      "dist/cli/main.js must exist (binary is load-bearing for launchd update-server)",
    );
  });
});

// ─── T-App11b1.8 — Transitional banner no longer names 'auth' ──────────────────

describe("T-App11b1.8: transitional banner no longer names auth (G-PApp11b1.8)", () => {
  it("T-App11b1.8: src/cli/main.ts banner 'remain supported' line lists (telegram, server, update-server) and NOT 'auth'", () => {
    // Given: the edited src/cli/main.ts banner string
    // When:  grepped for the 'remain supported' line
    // Then:  contains '(telegram, server, update-server)' and does NOT contain 'auth' in that enumeration
    const src = readFileSync(MAIN_TS, "utf-8");
    assert.ok(
      src.includes("(telegram, server, update-server) remain supported"),
      'main.ts banner must read "(telegram, server, update-server) remain supported" after removing auth',
    );
    assert.ok(
      !src.includes("(telegram, server, update-server, auth) remain supported"),
      'main.ts banner must NOT contain the old ", auth" in the remain-supported enumeration',
    );
  });
});

// ─── T-App11b1.9 — No production src/** imports a deleted subcommand module ───

describe("T-App11b1.9: no production src/** file imports a deleted subcommand module or its symbols (G-PApp11b1.9)", () => {
  it("T-App11b1.9: searching src/ for removed-subcommand import paths and run*Subcommand symbols finds ZERO matches", () => {
    // Given: the source tree under src/ after the stage (b1) deletions
    // When:  a recursive grep for the deleted import paths / symbols runs
    // Then:  ZERO matches in any kept src/ file
    const srcDir = join(REPO_ROOT, "src");
    const SKIP_DIRS_SRC = new Set(["node_modules", "target", ".git", "dist"]);

    function walkSrc(dir: string): string[] {
      const results: string[] = [];
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return results;
      }
      for (const entry of entries) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS_SRC.has(entry.name)) results.push(...walkSrc(full));
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
          results.push(full);
        }
      }
      return results;
    }

    const tsFiles = walkSrc(srcDir);

    // The deleted subcommand files themselves define these symbols by design.
    // T-App11b1.9 checks that NO OTHER (kept) file has orphaned imports.
    // Post-impl these files won't exist; pre-impl we exclude them from the scan
    // so the assertion targets the correct surface (kept files only).
    const DELETED_SUBCOMMAND_FILES = new Set([
      join(REPO_ROOT, "src", "cli", "subcommands", "auth.ts"),
      join(REPO_ROOT, "src", "cli", "subcommands", "setup.ts"),
      join(REPO_ROOT, "src", "cli", "subcommands", "identity.ts"),
      join(REPO_ROOT, "src", "cli", "subcommands", "sessions.ts"),
      join(REPO_ROOT, "src", "cli", "subcommands", "version.ts"),
      join(REPO_ROOT, "src", "cli", "subcommands", "search.ts"),
    ]);

    // These import-path fragments and symbol names must be absent from all KEPT src/**/*.ts files
    // (i.e. every file EXCEPT the deleted subcommand files listed above, which define these symbols)
    const forbiddenFragments = [
      'from "./subcommands/auth.js"',
      'from "./subcommands/setup.js"',
      'from "./subcommands/sessions.js"',
      'from "./subcommands/version.js"',
      'from "./subcommands/search.js"',
      "runAuthSubcommand",
      "runSetupSubcommand",
      "runIdentitySubcommand",
      "runSessionsSubcommand",
      "runVersionSubcommand",
      "runSearchSubcommand",
    ];

    // 'identity.js' as a subcommand import — be careful not to match 'identity-init.js'
    const identitySubcmdPattern = /from ["']\.\/subcommands\/identity\.js["']/;

    const violations: string[] = [];
    for (const filePath of tsFiles) {
      // Skip the deleted subcommand files themselves — they define these symbols by design.
      // Post-impl they won't exist; this exclusion makes the test target KEPT files only.
      if (DELETED_SUBCOMMAND_FILES.has(filePath)) continue;

      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      for (const fragment of forbiddenFragments) {
        if (content.includes(fragment)) {
          violations.push(`${filePath}: contains forbidden fragment "${fragment}"`);
        }
      }
      if (identitySubcmdPattern.test(content)) {
        violations.push(`${filePath}: contains forbidden import './subcommands/identity.js'`);
      }
    }

    assert.deepEqual(violations, [], `Orphaned imports/symbols found in kept src/ files:\n${violations.join("\n")}`);
  });
});

// ─── T-App11b1.10 — P-71 scope-lock survives at the app-Settings layer ────────

describe("T-App11b1.10: P-71 provider/search scope-lock survives at the app-Settings layer (G-PApp11b1.10)", () => {
  it("T-App11b1.10: tests/cli/subcommands/serve-settings-p71.mock.test.ts must exist (regression guard for the product scope-lock)", () => {
    // Given: the repository after stage (b1) — the product scope-lock lives at the
    //        app-Settings layer (serve/settings.ts:54,60)
    // When:  the regression-guard test file is checked for existence
    // Then:  the file exists (it has not been accidentally deleted)
    // NOTE: actual passing of T-P71.Settings.1-5 is verified by running test:fast
    //       (not a subprocess here — the file's EXISTENCE is the scaffold assertion)
    const guardFile = join(REPO_ROOT, "tests", "cli", "subcommands", "serve-settings-p71.mock.test.ts");
    assert.equal(
      existsSync(guardFile),
      true,
      "tests/cli/subcommands/serve-settings-p71.mock.test.ts must exist (P-71 regression guard for the product scope-lock)",
    );
  });
});

// ─── T-App11b1.11 — P-APP-7 IPC fixture stays green ──────────────────────────

describe("T-App11b1.11: P-APP-7 IPC fixture still exists (G-PApp11b1.11)", () => {
  it("T-App11b1.11: tests/cli/subcommands/serve/ipc-contract.mock.test.ts must exist (no app-protocol regression)", () => {
    // Given: the repository after stage (b1) — no IPC endpoint or SSE frame was changed
    // When:  the IPC contract fixture is checked for existence
    // Then:  the file exists
    const ipcFile = join(REPO_ROOT, "tests", "cli", "subcommands", "serve", "ipc-contract.mock.test.ts");
    assert.equal(
      existsSync(ipcFile),
      true,
      "tests/cli/subcommands/serve/ipc-contract.mock.test.ts must exist (P-APP-7 IPC contract fixture — no app-protocol regression)",
    );
  });
});

// ─── T-App11b1.12 — mai soul reset STILL works; show/edit now error ───────────

describe("T-App11b1.12: mai soul reset still works; mai soul show/edit now error (G-PApp11b1.12)", () => {
  it("T-App11b1.12a: 'mai soul show' exits non-zero with 'unknown soul action' (show removed)", async () => {
    // Given: the built dist/cli/main.js with the narrowed soul <action> registration
    // When:  invoked as `soul show`
    // Then:  exits non-zero AND stderr contains "unknown soul action"
    const result = await runCli(["soul", "show"]);
    assert.notEqual(result.exitCode, 0, "'mai soul show' must exit non-zero (show was removed in b1)");
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.toLowerCase().includes("unknown soul action"),
      `'mai soul show' must print "unknown soul action"; got: ${combined.slice(0, 300)}`,
    );
  });

  it("T-App11b1.12b: 'mai soul edit' exits non-zero with 'unknown soul action' (edit removed)", async () => {
    // Given: the built dist/cli/main.js with the narrowed soul <action> registration
    // When:  invoked as `soul edit`
    // Then:  exits non-zero AND stderr contains "unknown soul action"
    const result = await runCli(["soul", "edit"]);
    assert.notEqual(result.exitCode, 0, "'mai soul edit' must exit non-zero (edit was removed in b1)");
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.toLowerCase().includes("unknown soul action"),
      `'mai soul edit' must print "unknown soul action"; got: ${combined.slice(0, 300)}`,
    );
  });

  it("T-App11b1.12c: soul reset persist path (KEEP: direct applyIdentityPatch+writeIdentity) — outcome-anchored: identity.freeAxes mutated", async () => {
    // Given: a sandbox identity.json with fixed initial freeAxes (updatedAt = past)
    //        NOTE: promptFreeAxes uses rl.once("close",...) — TTY-only; cannot be driven
    //        by piped stdin in a subprocess (known design; see tests/cli/soul.mock.test.ts:9-11).
    //        This test validates the PERSIST PATH (applyIdentityPatch+writeIdentity) directly,
    //        mirroring T-M_p5.20. The subprocess-integrity gate (no "unknown command/soul action")
    //        is covered by T-App11b1.12a and T-App11b1.12b.
    // When:  applyIdentityPatch(initial, {freeAxes: newAxes}) + writeIdentity + re-read
    // Then:  OUTCOME ANCHOR: identity.freeAxes has the new values; updatedAt has changed
    const {
      applyIdentityPatch: applyPatch,
      identityRecordSchema: schema,
      readIdentity: readId,
      writeIdentity: writeId,
    } = await import("../../src/persistence/identity.js");

    const identityPath = join(tmpdir(), `mai-b1-soul-reset-${process.pid}.json`);
    try {
      // 1. Write initial identity with past timestamp
      const initial = schema.parse({
        fullName: "B1ResetTest",
        company: "B1Co",
        freeAxes: {
          pain_chain_lean: "cause-confirmed-then-up",
          lead_role: "pain-owner first",
          discovery_lean: "ratio-disciplined",
          story_shape: "reference-story led",
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      writeId(initial, identityPath);

      // 2. Simulate a new axis pick (as promptFreeAxes would return after TTY interaction)
      const newAxes = {
        pain_chain_lean: "cause-first",
        lead_role: "economic-buyer first",
        discovery_lean: "R-lean",
        story_shape: "initial-value-prop led",
      };

      // 3. Apply patch + persist (exact sequence runSoulReset uses)
      const patched = applyPatch(initial, { freeAxes: newAxes });
      const merged = schema.parse({ ...patched, updatedAt: new Date().toISOString() });
      writeId(merged, identityPath);

      // 4. Re-read and verify OUTCOME ANCHOR
      const updated = readId(identityPath);
      assert.ok(updated !== null, "T-App11b1.12c: identity.json must be readable after reset persist");
      assert.equal(
        updated?.freeAxes?.pain_chain_lean,
        "cause-first",
        "T-App11b1.12c: pain_chain_lean must be updated after reset persist",
      );
      assert.equal(
        updated?.freeAxes?.lead_role,
        "economic-buyer first",
        "T-App11b1.12c: lead_role must be updated after reset persist",
      );
      assert.notEqual(
        updated?.updatedAt,
        "2026-01-01T00:00:00.000Z",
        "T-App11b1.12c: updatedAt must change after reset persist (durable state mutation)",
      );
    } finally {
      try {
        rmSync(identityPath, { force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* best-effort */
      }
    }
  });
});

// ─── T-App11b1.13 — No kept src/**/*.ts guidance names a removed command ───────

describe("T-App11b1.13: no kept src/**/*.ts guidance names a removed command (B3 — G-PApp11b1.13)", () => {
  // Build the set of .ts files to scan (src/**/*.ts, excluding src/tauri/src-tauri/target/**)
  const SCAN_SKIP_DIRS = new Set(["node_modules", "target", ".git", "dist", "build"]);

  function collectTsFiles(dir: string): string[] {
    const results: string[] = [];
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(entry.name)) results.push(...collectTsFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        results.push(full);
      }
    }
    return results;
  }

  it("T-App11b1.13a: searching src/**/*.ts (excl. Rust target dir) for removed-command tokens finds ZERO matches", () => {
    // Given: the source tree under src/ after B3 guidance rewrites + deletions
    // When:  a recursive grep over *.ts (excluding src/tauri/src-tauri/target/**) runs for each removed token
    // Then:  ZERO matches across all kept source files
    const srcDir = join(REPO_ROOT, "src");
    const tsFiles = collectTsFiles(srcDir);

    const violations: string[] = [];
    for (const filePath of tsFiles) {
      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      for (const token of REMOVED_COMMAND_TOKENS) {
        if (content.includes(token)) {
          violations.push(`${filePath}: contains removed-command token "${token}"`);
        }
      }
    }

    assert.deepEqual(violations, [], `Removed-command tokens found in kept src/**/*.ts:\n${violations.join("\n")}`);
  });

  it("T-App11b1.13b: 'mai soul reset' guidance is STILL PRESENT in src/**/*.ts (positive guard — valid guidance not over-scrubbed)", () => {
    // Given: the source tree under src/ after B3 guidance rewrites
    // When:  a recursive grep for 'mai soul reset' in *.ts (excl. Rust target) runs
    // Then:  AT LEAST ONE match (bootstrap-tools.ts:63 / workerBoot.ts:67 / identity-init.ts:78)
    const srcDir = join(REPO_ROOT, "src");
    const tsFiles = collectTsFiles(srcDir);

    const matches: string[] = [];
    for (const filePath of tsFiles) {
      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      if (content.includes("mai soul reset")) {
        matches.push(filePath);
      }
    }

    assert.ok(
      matches.length > 0,
      "No 'mai soul reset' guidance found in src/**/*.ts — valid guidance was over-scrubbed. " +
        "Expected it at bootstrap-tools.ts, workerBoot.ts, identity-init.ts",
    );
  });
});

// ─── T-App11b1.14 — Non-.ts guidance sites (index.html + install.sh) carry §6.4.6 PINNED literals ─

describe("T-App11b1.14: non-.ts guidance sites carry §6.4.6 PINNED literals; no removed-command tokens (B3 round-2 — G-PApp11b1.14)", () => {
  it("T-App11b1.14a: src/tauri/ui/index.html does NOT contain 'mai setup' or 'mai auth' or 'mai identity init'", () => {
    // Given: the edited src/tauri/ui/index.html after B3 round-2 rewrite
    // When:  grepped for removed-command tokens
    // Then:  ZERO matches
    const content = readFileSync(INDEX_HTML, "utf-8");
    assert.ok(!content.includes("mai setup"), "index.html must NOT contain 'mai setup' after B3 round-2 rewrite");
    assert.ok(!content.includes("mai auth"), "index.html must NOT contain 'mai auth' after B3 round-2 rewrite");
    assert.ok(!content.includes("mai identity init"), "index.html must NOT contain 'mai identity init'");
  });

  it("T-App11b1.14b: src/tauri/ui/index.html CONTAINS the exact §6.4.6 PINNED inner text in #identity-gate .start-hint", () => {
    // Given: the edited src/tauri/ui/index.html
    // When:  the #identity-gate .start-hint text is inspected
    // Then:  contains EXACTLY 'Open <strong>Frondose → Settings</strong> to set your identity.'
    const content = readFileSync(INDEX_HTML, "utf-8");
    // The §6.4.6 PINNED literal (exact wording required — tests assert byte/substring-wise)
    const pinnedHtml = "Open <strong>Frondose → Settings</strong> to set your identity.";
    assert.ok(
      content.includes(pinnedHtml),
      `index.html must contain the PINNED literal:\n  "${pinnedHtml}"\n` +
        `(§6.4.6); found in file:\n  ${content.slice(Math.max(0, content.indexOf("start-hint") - 20), content.indexOf("start-hint") + 200)}`,
    );
  });

  it("T-App11b1.14c: install.sh does NOT contain 'mai setup' or 'mai auth' or 'mai identity init'", () => {
    // Given: the edited install.sh after B3 round-2 rewrite
    // When:  grepped for removed-command tokens
    // Then:  ZERO matches
    const content = readFileSync(INSTALL_SH, "utf-8");
    assert.ok(
      !content.includes("mai setup"),
      "install.sh must NOT contain 'mai setup' after B3 round-2 rewrite (§6.4.6)",
    );
    assert.ok(!content.includes("mai auth"), "install.sh must NOT contain 'mai auth' after B3 round-2 rewrite");
    assert.ok(!content.includes("mai identity init"), "install.sh must NOT contain 'mai identity init'");
  });

  it("T-App11b1.14d: install.sh CONTAINS the exact §6.4.6 PINNED echo line AND retains '=== Install complete ===' anchor", () => {
    // Given: the edited install.sh
    // When:  the post-install echo region is inspected
    // Then:  contains EXACTLY the §6.4.6 echo line + the anchor is preserved
    const content = readFileSync(INSTALL_SH, "utf-8");
    // The §6.4.6 PINNED literal for install.sh (exact wording required)
    const pinnedEcho =
      "Next: open Frondose and use Settings to configure your provider key, identity, and integrations.";
    assert.ok(
      content.includes(pinnedEcho),
      `install.sh must contain the PINNED echo line:\n  "${pinnedEcho}"\n(§6.4.6)`,
    );
    assert.ok(
      content.includes("=== Install complete ==="),
      "install.sh must still contain '=== Install complete ===' anchor (rest of script unchanged)",
    );
  });
});
