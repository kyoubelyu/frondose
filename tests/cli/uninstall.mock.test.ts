/**
 * P-38 Step 5 — T-UI.1..T-UI.8 (+ T-UI.1b daemon-warning) — assertions filled.
 *
 * `mai uninstall` — remove the global mai install (bin + pkg symlink + releases dir);
 * --purge also removes ~/.mai/ behind a second confirm.
 *
 * Gate coverage:
 *   G-P38.3 (plain uninstall removes bin + pkg + releases; preserves ~/.mai/state),
 *   G-P38.4 (null derivePackageSymlink → "not a global install"),
 *   G-P38.5 (confirm prompt; false → abort; --yes skips),
 *   G-P38.6 (--purge second confirm; warning names chrome-profile + irreversible),
 *   G-P38.7 (no child_process in uninstall.ts),
 *   G-P38.9 (pkg path can be real dir → rmSync({recursive}))
 *
 * DI: argv1 (tmp bin symlink), homeDir (tmp home dir), confirm (async stub).
 * Real tmp symlinks are used so derivePackageSymlink / isDevLink run on real readlinkSync.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { runUninstallSubcommand } from "../../src/cli/subcommands/uninstall.js";

// ─── Repo root ───────────────────────────────────────────────────────────────

const ROOT = resolve(new URL(".", import.meta.url).pathname, "../../");

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PKG_NAME = "@kyoube/mai-agent";

interface TmpInstall {
  tmpDir: string;
  homeDir: string;
  /** The bin symlink (e.g. <tmpDir>/bin/mai) passed as argv1. */
  argv1: string;
  /** The resolved pkg symlink path (<tmpDir>/lib/node_modules/@kyoube/mai-agent). */
  pkgSymlinkPath: string;
  /** The releases directory (<homeDir>/.mai/agent/releases). */
  releasesDir: string;
  /** The ~/.mai directory (<homeDir>/.mai). */
  maiDir: string;
  cleanup: () => void;
}

/**
 * Build a tmp install layout mimicking a global npm install:
 *   <tmpDir>/bin/mai               → symlink to <tmpDir>/lib/node_modules/@kyoube/mai-agent/dist/cli/main.js
 *   <tmpDir>/lib/node_modules/@kyoube/mai-agent  → (symlink to pkgTarget, OR real dir if pkgAsRealDir)
 *   <homeDir>/.mai/agent/releases/ → real directory
 *   <homeDir>/.mai/secrets.json    → stub file
 *
 * @param pkgAsRealDir — when true, the pkg path is a real directory (not a symlink). Tests G-P38.9.
 */
function makeTmpInstall(opts: { pkgAsRealDir?: boolean } = {}): TmpInstall {
  const tmpDir = mkdtempSync(join(tmpdir(), "mai-p38-ui-"));
  const homeDir = join(tmpDir, "home");
  const binDir = join(tmpDir, "bin");
  const libDir = join(tmpDir, "lib", "node_modules", "@kyoube");
  const pkgSymlinkPath = join(tmpDir, "lib", "node_modules", PKG_NAME);
  const releasesDir = join(homeDir, ".frondose", "agent", "releases");
  const maiDir = join(homeDir, ".frondose");

  // Create directory scaffolding
  mkdirSync(binDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  mkdirSync(join(releasesDir, "v0.4.35"), { recursive: true });
  mkdirSync(join(maiDir, "agent"), { recursive: true });
  writeFileSync(join(maiDir, "secrets.json"), JSON.stringify({ test: true }));

  // The bin symlink target: <tmpDir>/lib/node_modules/@kyoube/mai-agent/dist/cli/main.js
  // The target need not exist — derivePackageSymlink only calls readlinkSync(argv1) to read the
  // link string; it never stat()s the target. Keeping it dangling avoids pre-creating the
  // @kyoube/mai-agent directory that pkgSymlinkPath must occupy.
  const binTarget = join(tmpDir, "lib", "node_modules", PKG_NAME, "dist", "cli", "main.js");
  const argv1 = join(binDir, "mai");
  symlinkSync(binTarget, argv1);

  // The pkg location: symlink or real directory
  if (opts.pkgAsRealDir) {
    mkdirSync(pkgSymlinkPath, { recursive: true });
  } else {
    // Symlink to a stub target (content doesn't matter — derivePackageSymlink reads readlinkSync(argv1))
    const pkgTarget = join(tmpDir, "pkg-target");
    mkdirSync(pkgTarget, { recursive: true });
    symlinkSync(pkgTarget, pkgSymlinkPath);
  }

  return {
    tmpDir,
    homeDir,
    argv1,
    pkgSymlinkPath,
    releasesDir,
    maiDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/** Capture process.stdout.write output during fn(). */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: capturing variadic stdout.write
  (process.stdout.write as any) = (chunk: string | Uint8Array, ...rest: any[]) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return orig(chunk, ...rest);
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

// ─── T-UI.1 ──────────────────────────────────────────────────────────────────

describe("mai uninstall — plain uninstall (G-P38.3)", () => {
  it("T-UI.1: given full tmp install layout, confirm→true, no --purge: bin symlink + pkg symlink + releases dir removed; secrets.json preserved", async () => {
    // Given: a tmp layout with bin symlink + pkg symlink + releases dir + secrets.json
    // When:  runUninstallSubcommand({purge:false, yes:false, argv1, homeDir, confirm:→true})
    // Then:  argv1 (bin symlink) gone; pkgSymlinkPath gone; releasesDir gone;
    //        homeDir/.mai/secrets.json still exists; exit clean

    const inst = makeTmpInstall();
    try {
      // existsSync follows symlinks — dangling target returns false. Use lstatSync (no-follow).
      let binStatBefore = false;
      try {
        lstatSync(inst.argv1);
        binStatBefore = true;
      } catch {
        /* */
      }
      assert.ok(binStatBefore, "precondition: bin symlink must exist before uninstall");
      assert.ok(existsSync(inst.pkgSymlinkPath), "precondition: pkg symlink must exist before uninstall");
      assert.ok(existsSync(inst.releasesDir), "precondition: releases dir must exist before uninstall");
      assert.ok(
        existsSync(join(inst.maiDir, "secrets.json")),
        "precondition: secrets.json must exist before uninstall",
      );

      await runUninstallSubcommand({
        purge: false,
        yes: false,
        argv1: inst.argv1,
        homeDir: inst.homeDir,
        confirm: async (_msg: string) => true,
      });

      // Bin symlink gone (lstatSync — does not follow symlinks)
      let binExists = false;
      try {
        lstatSync(inst.argv1);
        binExists = true;
      } catch {
        /* expected — ENOENT */
      }
      assert.ok(!binExists, "bin symlink must be removed after uninstall");

      assert.ok(!existsSync(inst.pkgSymlinkPath), "pkg symlink must be removed after uninstall");
      assert.ok(!existsSync(inst.releasesDir), "releases dir must be removed after uninstall");
      assert.ok(existsSync(join(inst.maiDir, "secrets.json")), "secrets.json must be preserved (--purge NOT passed)");
    } finally {
      inst.cleanup();
    }
  });

  it("T-UI.1b: given confirm→true, no --purge: stdout contains daemon-warning ('mai server uninstall' / 'mai telegram off') — CONCERN-1 D-8 fix", async () => {
    // Given: a tmp layout; confirm→true; no --yes (so warning text is printed)
    // When:  runUninstallSubcommand called
    // Then:  captured stdout contains "mai server uninstall" AND "mai telegram off" (daemon-warning per D-8)

    const inst = makeTmpInstall();
    try {
      const stdout = await captureStdout(async () => {
        await runUninstallSubcommand({
          purge: false,
          yes: false,
          argv1: inst.argv1,
          homeDir: inst.homeDir,
          confirm: async (_msg: string) => true,
        });
      });

      assert.ok(
        stdout.includes("mai server uninstall"),
        `stdout must contain 'mai server uninstall' (daemon-warning D-8 fix). Got: ${stdout}`,
      );
      assert.ok(
        stdout.includes("mai telegram off"),
        `stdout must contain 'mai telegram off' (daemon-warning D-8 fix). Got: ${stdout}`,
      );
    } finally {
      inst.cleanup();
    }
  });
});

// ─── T-UI.2 ──────────────────────────────────────────────────────────────────

describe("mai uninstall — non-global install (G-P38.4)", () => {
  it("T-UI.2: given argv1 is a plain (non-symlink) file, derivePackageSymlink→null: prints 'not a global install'; nothing removed", async () => {
    // Given: argv1 points to a plain file (not a symlink) → derivePackageSymlink returns null
    // When:  runUninstallSubcommand called
    // Then:  stdout contains "not a global install" (or equivalent); no files removed

    const tmpDir = mkdtempSync(join(tmpdir(), "mai-p38-notglobal-"));
    const plainFile = join(tmpDir, "mai-plain");
    writeFileSync(plainFile, "#!/usr/bin/env node\n");

    try {
      const stdout = await captureStdout(async () => {
        await runUninstallSubcommand({
          purge: false,
          yes: false,
          argv1: plainFile,
          homeDir: tmpDir,
          confirm: async () => {
            throw new Error("confirm must NOT be called for non-global install");
          },
        });
      });

      assert.ok(
        stdout.toLowerCase().includes("not a global install"),
        `stdout must contain 'not a global install'. Got: ${stdout}`,
      );
      // plain file must still exist (nothing removed)
      assert.ok(existsSync(plainFile), "plainFile must still exist after non-global-install early-exit");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── T-UI.3 ──────────────────────────────────────────────────────────────────

describe("mai uninstall — confirm→false aborts (G-P38.5)", () => {
  it("T-UI.3: given confirm→false: prints abort message; bin symlink, pkg symlink, releases dir all still exist", async () => {
    // Given: full tmp layout; confirm returns false (operator declines)
    // When:  runUninstallSubcommand called
    // Then:  stdout contains abort message; argv1, pkgSymlinkPath, releasesDir all still exist

    const inst = makeTmpInstall();
    try {
      const stdout = await captureStdout(async () => {
        await runUninstallSubcommand({
          purge: false,
          yes: false,
          argv1: inst.argv1,
          homeDir: inst.homeDir,
          confirm: async (_msg: string) => false,
        });
      });

      assert.ok(
        stdout.toLowerCase().includes("aborted") || stdout.toLowerCase().includes("nothing removed"),
        `stdout must contain abort message. Got: ${stdout}`,
      );

      // Nothing removed — use lstatSync for bin symlink (follows real path)
      let binExists = false;
      try {
        lstatSync(inst.argv1);
        binExists = true;
      } catch {
        /* */
      }
      assert.ok(binExists, "bin symlink must still exist after abort");
      assert.ok(existsSync(inst.pkgSymlinkPath), "pkg symlink must still exist after abort");
      assert.ok(existsSync(inst.releasesDir), "releases dir must still exist after abort");
    } finally {
      inst.cleanup();
    }
  });
});

// ─── T-UI.4 ──────────────────────────────────────────────────────────────────

describe("mai uninstall — --yes skips confirm (G-P38.5)", () => {
  it("T-UI.4: given yes:true: confirm is NOT called; removal proceeds", async () => {
    // Given: full tmp layout; yes:true; injected confirm that tracks call count
    // When:  runUninstallSubcommand called
    // Then:  injected confirm NEVER called; argv1, pkgSymlinkPath, releasesDir removed

    let confirmCallCount = 0;
    const inst = makeTmpInstall();
    try {
      await runUninstallSubcommand({
        purge: false,
        yes: true,
        argv1: inst.argv1,
        homeDir: inst.homeDir,
        confirm: async (_msg: string) => {
          confirmCallCount++;
          return true; // would succeed if called — but must NOT be called
        },
      });

      assert.equal(confirmCallCount, 0, "confirm must NOT be called when yes:true");

      let binExists = false;
      try {
        lstatSync(inst.argv1);
        binExists = true;
      } catch {
        /* */
      }
      assert.ok(!binExists, "bin symlink must be removed");
      assert.ok(!existsSync(inst.pkgSymlinkPath), "pkg symlink must be removed");
      assert.ok(!existsSync(inst.releasesDir), "releases dir must be removed");
    } finally {
      inst.cleanup();
    }
  });
});

// ─── T-UI.5 ──────────────────────────────────────────────────────────────────

describe("mai uninstall --purge — removes ~/.mai/ (G-P38.6)", () => {
  it("T-UI.5: given purge:true, both confirms→true: ~/.mai/ fully removed", async () => {
    // Given: full tmp layout; purge:true; both confirms return true
    // When:  runUninstallSubcommand called (confirm called twice — once for uninstall, once for purge)
    // Then:  homeDir/.mai/ does NOT exist after the call

    let confirmCallCount = 0;
    const inst = makeTmpInstall();
    try {
      assert.ok(existsSync(inst.maiDir), "precondition: ~/.mai/ must exist before purge");

      await runUninstallSubcommand({
        purge: true,
        yes: false,
        argv1: inst.argv1,
        homeDir: inst.homeDir,
        confirm: async (_msg: string) => {
          confirmCallCount++;
          return true;
        },
      });

      assert.equal(confirmCallCount, 2, "confirm must be called exactly twice (uninstall + purge)");
      assert.ok(!existsSync(inst.maiDir), "~/.mai/ must be fully removed after --purge");
    } finally {
      inst.cleanup();
    }
  });
});

// ─── T-UI.6 ──────────────────────────────────────────────────────────────────

describe("mai uninstall --purge — warning text (G-P38.6)", () => {
  it("T-UI.6: given purge:true, confirms→true: stdout contains 'chrome-profile' + 'mai-browser' + 'IRREVERSIBLY' (or equivalent purge-destruction warning)", async () => {
    // Given: full tmp layout; purge:true; both confirms return true
    // When:  runUninstallSubcommand called; stdout captured
    // Then:  captured stdout contains "chrome-profile" AND "mai-browser" AND "IRREVERSIBLY"

    const inst = makeTmpInstall();
    try {
      const stdout = await captureStdout(async () => {
        await runUninstallSubcommand({
          purge: true,
          yes: false,
          argv1: inst.argv1,
          homeDir: inst.homeDir,
          confirm: async (_msg: string) => true,
        });
      });

      assert.ok(stdout.includes("chrome-profile"), `stdout must mention 'chrome-profile'. Got: ${stdout}`);
      assert.ok(stdout.includes("IRREVERSIBLY"), `stdout must mention 'IRREVERSIBLY'. Got: ${stdout}`);
      assert.ok(stdout.includes("mai-browser"), `stdout must mention 'mai-browser'. Got: ${stdout}`);
    } finally {
      inst.cleanup();
    }
  });
});

// ─── T-UI.7 ──────────────────────────────────────────────────────────────────

describe("mai uninstall — pkg path is real directory (G-P38.9)", () => {
  it("T-UI.7: given pkg symlink path is actually a real directory (not a symlink): removed via rmSync({recursive}), not left behind", async () => {
    // Given: tmp layout where pkgSymlinkPath is a real directory (not a symlink); confirm→true
    // When:  runUninstallSubcommand called
    // Then:  pkgSymlinkPath does NOT exist after the call (rmSync({recursive}) handled it)

    const inst = makeTmpInstall({ pkgAsRealDir: true });
    try {
      assert.ok(existsSync(inst.pkgSymlinkPath), "precondition: pkg real dir must exist");
      // Verify it's really a directory (not a symlink) — the G-P38.9 edge case
      assert.ok(
        !lstatSync(inst.pkgSymlinkPath).isSymbolicLink(),
        "precondition: pkg path must be real dir, not symlink",
      );

      await runUninstallSubcommand({
        purge: false,
        yes: false,
        argv1: inst.argv1,
        homeDir: inst.homeDir,
        confirm: async (_msg: string) => true,
      });

      assert.ok(!existsSync(inst.pkgSymlinkPath), "real-dir pkg path must be removed via rmSync({recursive})");
    } finally {
      inst.cleanup();
    }
  });
});

// ─── T-UI.8 ──────────────────────────────────────────────────────────────────

describe("mai uninstall — no child_process import (G-P38.7)", () => {
  it("T-UI.8: uninstall.ts source does NOT import 'child_process' or 'node:child_process'", () => {
    // Given: src/cli/subcommands/uninstall.ts source read from disk
    // When:  source text scanned for child_process import statements
    // Then:  zero import occurrences (fs-only — no child_process in uninstall.ts)

    // Note: autoUpdate.ts has an approved child_process import, but that import must NOT
    // propagate into uninstall.ts's own source. Transitive runtime use is irrelevant to
    // this check — the lint rule targets direct imports (the uninstall.ts source file itself).

    const src = readFileSync(resolve(ROOT, "src/cli/subcommands/uninstall.ts"), "utf-8");
    // Matches: import ... from "child_process" or import ... from "node:child_process"
    const importRe = /\bimport\b[^;]*from\s+["'](?:node:)?child_process["']/;
    assert.ok(!importRe.test(src), "uninstall.ts must NOT import child_process (fs-only constraint, G-P38.7)");
  });
});
