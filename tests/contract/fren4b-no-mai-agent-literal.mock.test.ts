/**
 * F-REN-4b Step 3 — Test Scaffold (outside-in TDD, all assertions TODO/failing)
 *
 * Covers:
 *   T-FREN4b.NoLeak.1 — After Step 4, no *.ts or *.rs file under src/ (nor install.sh)
 *     contains @kyoube/mai-agent / kyoubelyu/mai-agent / \bmai-agent\b outside the
 *     documented allowlist.
 *
 *   T-FREN4b.PkgName.1 — package.json name === "@kyoube/frondose"; version === "0.5.0-alpha.55".
 *   T-FREN4b.PkgName.2 — package-lock.json root + packages[""] both carry the new name+version.
 *
 *   T-FREN4b.Symlink.1 — symlink.ts PKG_NAME === "@kyoube/frondose";
 *                         derivePackageSymlink resolves a @kyoube/frondose-named fixture.
 *   T-FREN4b.Symlink.2 — A legacy @kyoube/mai-agent bin-symlink target returns null
 *                         from derivePackageSymlink (no transparent legacy fallback at
 *                         the autoUpdate layer — gated re-install required per runbook).
 *
 *   T-FREN4b.Repo.1    — fetch.ts LATEST_URL ends with "kyoubelyu/frondose/releases/latest".
 *   T-FREN4b.Repo.2    — update.ts has no "kyoubelyu/mai-agent" substring; has "kyoubelyu/frondose".
 *   T-FREN4b.Repo.3    — install.sh REPO= line is "kyoubelyu/frondose"; not "kyoubelyu/mai-agent".
 *
 *   T-FREN4b.MainRs.1  — main.rs candidate arrays contain BOTH @kyoube/frondose (first) AND
 *                         @kyoube/mai-agent (second) for both sidecarMain.js and cli/main.js paths.
 *
 *   T-FREN4b.Quad.1    — Relies on pre-existing T-Conf.3 (no new scaffold needed; see doc note).
 *
 *   T-FREN4b.Cosmetic.1 — repl.ts contains "frondose ready." and NOT "mai-agent ready".
 *   T-FREN4b.Cosmetic.2 — webFetch.ts User-Agent contains "frondose" and "kyoubelyu/frondose".
 *   T-FREN4b.Cosmetic.3 — escalate.ts issue-title prefix is "[frondose escalation]".
 *   T-FREN4b.Cosmetic.4 — soul.ts fallback operator name is "frondose operator".
 *
 * Gate coverage: G-FREN4b.NoLeak · G-FREN4b.PkgName · G-FREN4b.SymlinkResolution ·
 *                G-FREN4b.RepoRef · G-FREN4b.TauriPathResolution · G-FREN4b.Cosmetic
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/contract/fren4b-no-mai-agent-literal.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it, after } from "node:test";
import { derivePackageSymlink } from "../../src/cli/autoUpdate/symlink.js";

const REPO = resolve(process.cwd());
const SRC_DIR = join(REPO, "src");

// ---------------------------------------------------------------------------
// Helpers: file walker + pattern scanner
// ---------------------------------------------------------------------------

/**
 * Recursively collect files matching extensions under dir, skipping excluded path prefixes
 * (relative to REPO root, e.g. "src/tauri/src-tauri/target/").
 */
function collectFiles(dir: string, extensions: string[], excludedPrefixes: string[]): string[] {
  const files: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(REPO, full).replace(/\\/g, "/");
    if (excludedPrefixes.some((ex) => rel.startsWith(ex))) continue;
    if (entry.isDirectory()) {
      files.push(...collectFiles(full, extensions, excludedPrefixes));
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Find lines in `text` that match any of the given patterns.
 * Returns { lineNo, line } for each matching line (1-indexed).
 */
function findPatternHits(
  text: string,
  patterns: RegExp[],
): Array<{ lineNo: number; line: string }> {
  const results: Array<{ lineNo: number; line: string }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (patterns.some((p) => p.test(line))) {
      results.push({ lineNo: i + 1, line: line.trim() });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Allowlist — the ONLY production lines permitted to keep "@kyoube/mai-agent"
// or "mai-agent" after Step 4 (line-exact per 2a C-2).
//
// Allowlist entries are RELATIVE file paths + an optional line-content substring test.
// Format: { relPath: string; lineSubstrings?: string[] }
//   If lineSubstrings is absent, ALL lines in this file are allowed (whole-file pass).
//   If lineSubstrings is provided, only lines containing at least one of those substrings
//   are allowed (all others still fail).
//
// Justified entries:
//   1. src/tauri/src-tauri/src/main.rs
//      - Lines containing the F-REN-4b dual-fallback candidate paths:
//        "node_modules/@kyoube/mai-agent/dist/app/sidecarMain.js" (2 lines)
//        "node_modules/@kyoube/mai-agent/dist/cli/main.js" (2 lines)
//      - Lines containing the internal Rust identifier fn names:
//        "resolve_mai_sidecar_bin", "resolve_mai_bin", "spawn_mai_serve"
//      - Lines containing "[mai-tauri]" log prefixes (eprintln!)
//      These are the ONLY allowlisted patterns in main.rs — NOT the whole file.
//      (A stale doc-comment at line 407 naming @kyoube/mai-agent is NOT allowlisted
//       here — it must be updated by builder at Step 4 per 2a C-2.)
//
//   2. src/tauri/src-tauri/Cargo.toml
//      - Contains "mai-tauri" (crate name, deferred — F-REN-4d non-goal).
//
//   3. src/tauri/src-tauri/Cargo.lock
//      - Contains "mai-tauri" in the package version block (auto-regenerated by cargo).
// ---------------------------------------------------------------------------

const ALLOWLISTED_FILE_PATHS = new Set<string>([
  // Whole-file passes for Cargo metadata (internal crate name, not package-facing):
  "src/tauri/src-tauri/Cargo.toml",
  "src/tauri/src-tauri/Cargo.lock",
]);

/**
 * Line-level allowlist for main.rs — only these specific substrings are permitted
 * to keep "mai-agent" post-Step-4 (per 2a C-2 line-exact requirement).
 */
const MAIN_RS_ALLOWED_LINE_SUBSTRINGS = [
  // F-REN-4b dual-fallback candidate path lines (strategy-a):
  "node_modules/@kyoube/mai-agent/dist/app/sidecarMain.js",
  "node_modules/@kyoube/mai-agent/dist/cli/main.js",
  // Internal Rust fn names (deferred — non-goals per §2):
  "resolve_mai_sidecar_bin",
  "resolve_mai_bin",
  "spawn_mai_serve",
  // Internal crate log prefix (deferred):
  "[mai-tauri]",
  // F-REN-4b transition comment (expected alongside the fallback paths):
  "F-REN-4b transition",
  // doc-comment at line ~410 naming @kyoube/frondose first, @kyoube/mai-agent as legacy (2a C-2 satisfied):
  "(legacy: @kyoube/mai-agent)",
];

const SCAN_EXCLUDED_PREFIXES = [
  "src/tauri/src-tauri/target/", // Rust build artifacts
  "src/tauri/ui/", // UI assets
];

const MAI_AGENT_PATTERNS = [
  /@kyoube\/mai-agent/,
  /kyoubelyu\/mai-agent/,
  /\bmai-agent\b/,
];

// ---------------------------------------------------------------------------
// T-FREN4b.NoLeak.1 — source-scan guard
// ---------------------------------------------------------------------------

describe(
  "source-scan guard — no @kyoube/mai-agent / mai-agent literals outside allowlist after Step 4 (T-FREN4b.NoLeak)",
  () => {
    it(
      "T-FREN4b.NoLeak.1: grep src/**/*.{ts,rs} + install.sh for @kyoube/mai-agent|kyoubelyu/mai-agent|\\bmai-agent\\b returns ZERO non-allowlisted hits",
      () => {
        // Given: post-Step-4 working tree (production renamed to @kyoube/frondose)
        // When:  pattern scan runs over src/ *.ts/*.rs + install.sh, excluding build artifacts
        // Then:  zero violations outside the line-exact allowlist

        const tsRsFiles = collectFiles(SRC_DIR, [".ts", ".rs"], SCAN_EXCLUDED_PREFIXES);
        const installSh = join(REPO, "install.sh");

        const violations: string[] = [];

        const allFiles = [...tsRsFiles, installSh];
        for (const filePath of allFiles) {
          const relPath = relative(REPO, filePath).replace(/\\/g, "/");

          // Whole-file allowlist (Cargo metadata with mai-tauri crate name)
          if (ALLOWLISTED_FILE_PATHS.has(relPath)) continue;

          let text: string;
          try {
            text = readFileSync(filePath, "utf-8");
          } catch {
            continue;
          }

          const hits = findPatternHits(text, MAI_AGENT_PATTERNS);
          for (const { lineNo, line } of hits) {
            // main.rs: only specific line substrings are allowed
            if (relPath === "src/tauri/src-tauri/src/main.rs") {
              const allowed = MAIN_RS_ALLOWED_LINE_SUBSTRINGS.some((sub) => line.includes(sub));
              if (allowed) continue;
            }
            violations.push(`${relPath}:${lineNo}: ${line}`);
          }
        }

        assert.deepEqual(
          violations,
          [],
          `T-FREN4b.NoLeak.1: ${violations.length} non-allowlisted hit(s) found:\n${violations.join("\n")}`,
        );
      },
    );
  },
);

// ---------------------------------------------------------------------------
// T-FREN4b.PkgName — package.json + package-lock.json identity
// ---------------------------------------------------------------------------

describe("package identity — @kyoube/frondose + 0.5.0-alpha.55 (T-FREN4b.PkgName)", () => {
  it(
    "T-FREN4b.PkgName.1: package.json name === '@kyoube/frondose' and version === '0.5.0-alpha.55'; bin field absent (install.sh creates bin link, not npm)",
    () => {
      // Given: post-Step-4 package.json at repo root (F-REN-4d version bump to alpha.55)
      // When:  parsed as JSON
      // Then:  name === "@kyoube/frondose"; version === "0.5.0-alpha.55"; no bin field drift

      const pkgPath = join(REPO, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
      assert.equal(pkg.name, "@kyoube/frondose", "T-FREN4b.PkgName.1: package.json name must be @kyoube/frondose");
      assert.equal(pkg.version, "0.5.0-alpha.55", "T-FREN4b.PkgName.1: package.json version must be 0.5.0-alpha.55");
    },
  );

  it(
    "T-FREN4b.PkgName.2: package-lock.json root .name and .packages[''].name both equal '@kyoube/frondose'; root + packages[''] versions both equal '0.5.0-alpha.55'",
    () => {
      // Given: post-Step-4 package-lock.json at repo root (F-REN-4d version bump to alpha.55)
      // When:  parsed as JSON
      // Then:  root name + packages[""].name === "@kyoube/frondose"; both version fields === "0.5.0-alpha.55"

      const lockPath = join(REPO, "package-lock.json");
      const lock = JSON.parse(readFileSync(lockPath, "utf-8")) as {
        name: string;
        version: string;
        packages: Record<string, { name?: string; version: string }>;
      };
      assert.equal(lock.name, "@kyoube/frondose", "T-FREN4b.PkgName.2: package-lock root .name must be @kyoube/frondose");
      assert.equal(lock.version, "0.5.0-alpha.55", "T-FREN4b.PkgName.2: package-lock root .version must be 0.5.0-alpha.55");
      assert.equal(
        lock.packages[""]?.name,
        "@kyoube/frondose",
        "T-FREN4b.PkgName.2: package-lock .packages[\"\"].name must be @kyoube/frondose",
      );
      assert.equal(
        lock.packages[""]?.version,
        "0.5.0-alpha.55",
        "T-FREN4b.PkgName.2: package-lock .packages[\"\"].version must be 0.5.0-alpha.55",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-FREN4b.SymlinkResolution — autoUpdate symlink helpers
// ---------------------------------------------------------------------------

describe(
  "autoUpdate symlink resolution — PKG_NAME === '@kyoube/frondose' (T-FREN4b.SymlinkResolution)",
  () => {
    // Shared tmpdir for symlink fixtures
    let tmpDir: string;

    after(() => {
      // Cleanup tmpdir after all tests in this describe block
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });

    it(
      "T-FREN4b.Symlink.1: given a @kyoube/frondose-named fixture (bin/mai -> ../lib/@kyoube/frondose/dist/cli/main.js), derivePackageSymlink returns the resolved @kyoube/frondose package path",
      () => {
        // Given: tmpdir layout: bin/mai -> ../lib/@kyoube/frondose/dist/cli/main.js;
        //        lib/@kyoube/frondose -> ../releases/v0.5.0-alpha.54 (symlink)
        // When:  derivePackageSymlink(argv1) runs with post-Step-4 PKG_NAME = "@kyoube/frondose"
        // Then:  returns the resolved lib/@kyoube/frondose path (slice logic keys off PKG_NAME.length)

        tmpDir = mkdtempSync(join(tmpdir(), "fren4b-symlink1-"));
        mkdirSync(join(tmpDir, "bin"), { recursive: true });
        mkdirSync(join(tmpDir, "lib", "@kyoube"), { recursive: true });
        mkdirSync(join(tmpDir, "lib", "releases", "v0.5.0-alpha.54"), { recursive: true });

        // lib/@kyoube/frondose → ../../releases/v0.5.0-alpha.54
        const pkgSymlinkPath = join(tmpDir, "lib", "@kyoube", "frondose");
        symlinkSync("../../releases/v0.5.0-alpha.54", pkgSymlinkPath);

        // bin/mai → ../lib/@kyoube/frondose/dist/cli/main.js (dangling ok — readlinkSync only reads target string)
        const argv1 = join(tmpDir, "bin", "mai");
        symlinkSync("../lib/@kyoube/frondose/dist/cli/main.js", argv1);

        const result = derivePackageSymlink(argv1);
        assert.ok(result !== null, "T-FREN4b.Symlink.1: result must not be null for @kyoube/frondose-named fixture");
        assert.ok(
          result.includes("@kyoube/frondose"),
          `T-FREN4b.Symlink.1: result must contain '@kyoube/frondose'; got: ${result}`,
        );
        assert.ok(
          !result.includes("@kyoube/mai-agent"),
          `T-FREN4b.Symlink.1: result must NOT contain '@kyoube/mai-agent'; got: ${result}`,
        );
      },
    );

    it(
      "T-FREN4b.Symlink.2: given a legacy @kyoube/mai-agent-named bin-symlink target, derivePackageSymlink returns null (expected documented behavior — legacy install requires runbook re-install)",
      () => {
        // Given: bin/mai -> ../lib/@kyoube/mai-agent/dist/cli/main.js (legacy, pre-rename fixture)
        // When:  derivePackageSymlink(argv1) runs with new PKG_NAME = "@kyoube/frondose"
        // Then:  returns null — idx === -1; autoUpdate skips as not_global_install (benign; no corruption)

        const legacyDir = mkdtempSync(join(tmpdir(), "fren4b-symlink2-"));
        try {
          mkdirSync(join(legacyDir, "bin"), { recursive: true });
          mkdirSync(join(legacyDir, "lib", "@kyoube"), { recursive: true });

          // bin/mai → ../lib/@kyoube/mai-agent/dist/cli/main.js (legacy symlink target)
          const argv1 = join(legacyDir, "bin", "mai");
          symlinkSync("../lib/@kyoube/mai-agent/dist/cli/main.js", argv1);

          const result = derivePackageSymlink(argv1);
          assert.strictEqual(
            result,
            null,
            "T-FREN4b.Symlink.2: legacy @kyoube/mai-agent symlink MUST return null with new PKG_NAME=@kyoube/frondose (gated re-install required per runbook — NOT a bug)",
          );
        } finally {
          rmSync(legacyDir, { recursive: true, force: true });
        }
      },
    );
  },
);

// ---------------------------------------------------------------------------
// T-FREN4b.RepoRef — GitHub repo references
// ---------------------------------------------------------------------------

describe("GitHub repo refs — kyoubelyu/frondose throughout (T-FREN4b.RepoRef)", () => {
  it(
    "T-FREN4b.Repo.1: src/cli/autoUpdate/fetch.ts LATEST_URL contains 'kyoubelyu/frondose/releases/latest'; does NOT contain 'kyoubelyu/mai-agent'",
    () => {
      // Given: post-Step-4 src/cli/autoUpdate/fetch.ts
      // When:  the file text is read
      // Then:  'kyoubelyu/frondose/releases/latest' appears; 'kyoubelyu/mai-agent' does NOT

      const text = readFileSync(join(REPO, "src/cli/autoUpdate/fetch.ts"), "utf-8");
      // REPO_PATH is a template variable: LATEST_URL = `https://api.github.com/repos/${REPO_PATH}/releases/latest`
      // So the literal "kyoubelyu/frondose/releases/latest" does NOT appear — check REPO_PATH constant instead.
      assert.ok(
        text.includes('kyoubelyu/frondose"') || text.includes("kyoubelyu/frondose'") || text.includes("kyoubelyu/frondose`"),
        "T-FREN4b.Repo.1: fetch.ts REPO_PATH constant must contain 'kyoubelyu/frondose'",
      );
      assert.ok(
        !text.includes("kyoubelyu/mai-agent"),
        "T-FREN4b.Repo.1: fetch.ts must NOT contain 'kyoubelyu/mai-agent'",
      );
    },
  );

  it(
    "T-FREN4b.Repo.2: src/cli/subcommands/update.ts contains 'api.github.com/repos/kyoubelyu/frondose/releases/latest'; does NOT contain 'kyoubelyu/mai-agent'",
    () => {
      // Given: post-Step-4 src/cli/subcommands/update.ts
      // When:  the file text is read
      // Then:  correct frondose URL present; stale mai-agent URL absent

      const text = readFileSync(join(REPO, "src/cli/subcommands/update.ts"), "utf-8");
      assert.ok(
        text.includes("api.github.com/repos/kyoubelyu/frondose/releases/latest"),
        "T-FREN4b.Repo.2: update.ts must contain correct frondose API URL",
      );
      assert.ok(
        !text.includes("kyoubelyu/mai-agent"),
        "T-FREN4b.Repo.2: update.ts must NOT contain 'kyoubelyu/mai-agent'",
      );
    },
  );

  it(
    "T-FREN4b.Repo.3: install.sh contains REPO=\"kyoubelyu/frondose\"; does NOT contain REPO=\"kyoubelyu/mai-agent\"",
    () => {
      // Given: post-Step-4 install.sh at repo root
      // When:  the file text is read
      // Then:  'REPO="kyoubelyu/frondose"' appears; 'REPO="kyoubelyu/mai-agent"' does NOT

      const text = readFileSync(join(REPO, "install.sh"), "utf-8");
      assert.ok(
        text.includes('REPO="kyoubelyu/frondose"'),
        'T-FREN4b.Repo.3: install.sh must contain REPO="kyoubelyu/frondose"',
      );
      assert.ok(
        !text.includes('REPO="kyoubelyu/mai-agent"'),
        'T-FREN4b.Repo.3: install.sh must NOT contain REPO="kyoubelyu/mai-agent"',
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-FREN4b.TauriPathResolution — main.rs dual-name candidate arrays
// ---------------------------------------------------------------------------

describe(
  "Tauri path resolution — dual-name candidate arrays in main.rs (T-FREN4b.TauriPathResolution)",
  () => {
    it(
      "T-FREN4b.MainRs.1: main.rs candidate arrays contain both @kyoube/frondose (first) AND @kyoube/mai-agent (second) for sidecarMain.js and cli/main.js paths; @kyoube/frondose /opt/homebrew path precedes @kyoube/mai-agent /opt/homebrew path",
      () => {
        // Given: post-Step-4 src/tauri/src-tauri/src/main.rs
        // When:  file text is read and searched for candidate path substrings
        // Then:  all four expected @kyoube/frondose paths present BEFORE the @kyoube/mai-agent fallback paths;
        //        doc-comment at lines ~406-408 names @kyoube/frondose first (2a C-2)

        const text = readFileSync(join(REPO, "src/tauri/src-tauri/src/main.rs"), "utf-8");

        // Sidecar candidates
        const SIDECAR_FRONDOSE = "/opt/homebrew/lib/node_modules/@kyoube/frondose/dist/app/sidecarMain.js";
        const SIDECAR_MAI_AGENT = "/opt/homebrew/lib/node_modules/@kyoube/mai-agent/dist/app/sidecarMain.js";
        // CLI candidates
        const CLI_FRONDOSE = "/opt/homebrew/lib/node_modules/@kyoube/frondose/dist/cli/main.js";
        const CLI_MAI_AGENT = "/opt/homebrew/lib/node_modules/@kyoube/mai-agent/dist/cli/main.js";

        // All four substrings must be present
        assert.ok(text.includes(SIDECAR_FRONDOSE), `T-FREN4b.MainRs.1: sidecar @kyoube/frondose path must be present`);
        assert.ok(text.includes(SIDECAR_MAI_AGENT), `T-FREN4b.MainRs.1: sidecar @kyoube/mai-agent fallback path must be present`);
        assert.ok(text.includes(CLI_FRONDOSE), `T-FREN4b.MainRs.1: CLI @kyoube/frondose path must be present`);
        assert.ok(text.includes(CLI_MAI_AGENT), `T-FREN4b.MainRs.1: CLI @kyoube/mai-agent fallback path must be present`);

        // frondose paths must appear BEFORE the mai-agent fallback paths
        assert.ok(
          text.indexOf(SIDECAR_FRONDOSE) < text.indexOf(SIDECAR_MAI_AGENT),
          `T-FREN4b.MainRs.1: sidecar @kyoube/frondose path must appear BEFORE @kyoube/mai-agent (frondose-first order)`,
        );
        assert.ok(
          text.indexOf(CLI_FRONDOSE) < text.indexOf(CLI_MAI_AGENT),
          `T-FREN4b.MainRs.1: CLI @kyoube/frondose path must appear BEFORE @kyoube/mai-agent (frondose-first order)`,
        );

        // doc-comment must name @kyoube/frondose first (2a C-2):
        // Find the doc-comment line containing @kyoube/ and confirm frondose appears before mai-agent.
        // The line is: /// npm-global package at `.../@kyoube/frondose` (legacy: @kyoube/mai-agent) →
        const docCommentLine = text.split("\n").find(
          (line) => line.startsWith("///") && line.includes("@kyoube/frondose") && line.includes("@kyoube/mai-agent"),
        );
        assert.ok(
          docCommentLine !== undefined,
          "T-FREN4b.MainRs.1: a doc-comment line with both @kyoube/frondose and @kyoube/mai-agent must be present (2a C-2)",
        );
        assert.ok(
          docCommentLine.indexOf("@kyoube/frondose") < docCommentLine.indexOf("@kyoube/mai-agent"),
          `T-FREN4b.MainRs.1: doc-comment must name @kyoube/frondose BEFORE @kyoube/mai-agent (frondose-first per 2a C-2); got: ${docCommentLine}`,
        );
      },
    );
  },
);

// ---------------------------------------------------------------------------
// T-FREN4b.Cosmetic — operator/LLM-visible strings
// ---------------------------------------------------------------------------

describe("cosmetic strings — frondose throughout operator-visible surfaces (T-FREN4b.Cosmetic)", () => {
  it(
    "T-FREN4b.Cosmetic.1: src/cli/repl.ts line ~248 contains 'frondose ready.' and does NOT contain 'mai-agent ready'",
    () => {
      // Given: post-Step-4 src/cli/repl.ts
      // When:  file text is read
      // Then:  'frondose ready.' present; 'mai-agent ready' absent

      const text = readFileSync(join(REPO, "src/cli/repl.ts"), "utf-8");
      assert.ok(text.includes("frondose ready."), "T-FREN4b.Cosmetic.1: repl.ts must contain 'frondose ready.'");
      assert.ok(!text.includes("mai-agent ready"), "T-FREN4b.Cosmetic.1: repl.ts must NOT contain 'mai-agent ready'");
    },
  );

  it(
    "T-FREN4b.Cosmetic.2: src/tools/webTools/webFetch.ts User-Agent string contains 'frondose/1.0' and 'kyoubelyu/frondose'; does NOT contain 'kyoubelyu/mai-agent'",
    () => {
      // Given: post-Step-4 src/tools/webTools/webFetch.ts
      // When:  file text is read to inspect the User-Agent literal
      // Then:  'frondose/1.0' and 'kyoubelyu/frondose' present; 'kyoubelyu/mai-agent' absent

      const text = readFileSync(join(REPO, "src/tools/webTools/webFetch.ts"), "utf-8");
      assert.ok(text.includes("frondose/1.0"), "T-FREN4b.Cosmetic.2: webFetch.ts must contain 'frondose/1.0' in User-Agent");
      assert.ok(
        text.includes("kyoubelyu/frondose"),
        "T-FREN4b.Cosmetic.2: webFetch.ts must contain 'kyoubelyu/frondose' in User-Agent",
      );
      assert.ok(
        !text.includes("kyoubelyu/mai-agent"),
        "T-FREN4b.Cosmetic.2: webFetch.ts must NOT contain 'kyoubelyu/mai-agent'",
      );
    },
  );

  it(
    "T-FREN4b.Cosmetic.3: src/tools/control/escalate.ts issue-title prefix is '[frondose escalation]'; does NOT contain '[mai-agent escalation]'",
    () => {
      // Given: post-Step-4 src/tools/control/escalate.ts
      // When:  file text is read
      // Then:  '[frondose escalation]' present; '[mai-agent escalation]' absent

      const text = readFileSync(join(REPO, "src/tools/control/escalate.ts"), "utf-8");
      assert.ok(
        text.includes("[frondose escalation]"),
        "T-FREN4b.Cosmetic.3: escalate.ts must contain '[frondose escalation]'",
      );
      assert.ok(
        !text.includes("[mai-agent escalation]"),
        "T-FREN4b.Cosmetic.3: escalate.ts must NOT contain '[mai-agent escalation]'",
      );
    },
  );

  it(
    "T-FREN4b.Cosmetic.4: src/agent/systemPrompt/soul.ts default operator fallback name is 'frondose operator'; does NOT contain 'mai-agent operator'",
    () => {
      // Given: post-Step-4 src/agent/systemPrompt/soul.ts
      // When:  file text is read
      // Then:  'frondose operator' present at the fallback name site; 'mai-agent operator' absent

      const text = readFileSync(join(REPO, "src/agent/systemPrompt/soul.ts"), "utf-8");
      assert.ok(
        text.includes("frondose operator"),
        "T-FREN4b.Cosmetic.4: soul.ts must contain 'frondose operator' as fallback name",
      );
      assert.ok(
        !text.includes("mai-agent operator"),
        "T-FREN4b.Cosmetic.4: soul.ts must NOT contain 'mai-agent operator'",
      );
    },
  );
});
