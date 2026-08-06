/**
 * F-REN-4b Step 3 — Test Scaffold (outside-in TDD, all assertions TODO/failing)
 *
 * Covers:
 *   T-FREN4b.NoLeak.1 — After Step 4, no *.ts or *.rs file under src/ (nor install.sh)
 *     contains @kyoube/mai-agent / kyoubelyu/mai-agent / \bmai-agent\b outside the
 *     documented allowlist.
 *
 *   T-FREN4b.PkgName.1 — package.json name === "@kyoube/frondose"; version === "0.5.0-alpha.56".
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
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";

const REPO = resolve(process.cwd());

// Derive expected version from package.json so this test self-updates each release.
const EXPECTED_VERSION = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf-8")) as { version: string }).version;
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
function findPatternHits(text: string, patterns: RegExp[]): Array<{ lineNo: number; line: string }> {
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

const MAI_AGENT_PATTERNS = [/@kyoube\/mai-agent/, /kyoubelyu\/mai-agent/, /\bmai-agent\b/];

// ---------------------------------------------------------------------------
// T-FREN4b.NoLeak.1 — source-scan guard
// ---------------------------------------------------------------------------

describe("source-scan guard — no @kyoube/mai-agent / mai-agent literals outside allowlist after Step 4 (T-FREN4b.NoLeak)", () => {
  it("T-FREN4b.NoLeak.1: grep src/**/*.{ts,rs} + install.sh for @kyoube/mai-agent|kyoubelyu/mai-agent|\\bmai-agent\\b returns ZERO non-allowlisted hits", () => {
    // Given: post-Step-4 working tree (production renamed to @kyoube/frondose)
    // When:  pattern scan runs over src/ *.ts/*.rs + install.sh, excluding build artifacts
    // Then:  zero violations outside the line-exact allowlist

    const tsRsFiles = collectFiles(SRC_DIR, [".ts", ".rs"], SCAN_EXCLUDED_PREFIXES);

    const violations: string[] = [];

    const allFiles = [...tsRsFiles];
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
  });
});

// ---------------------------------------------------------------------------
// T-FREN4b.PkgName — package.json + package-lock.json identity
// ---------------------------------------------------------------------------

describe(`package identity — @kyoube/frondose + ${EXPECTED_VERSION} (T-FREN4b.PkgName)`, () => {
  it(`T-FREN4b.PkgName.1: package.json name === '@kyoube/frondose' and version === '${EXPECTED_VERSION}'; bin field absent (install.sh creates bin link, not npm)`, () => {
    // Given: post-Step-4 package.json at repo root; version derived dynamically
    // When:  parsed as JSON
    // Then:  name === "@kyoube/frondose"; version === EXPECTED_VERSION; no bin field drift

    const pkgPath = join(REPO, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
    assert.equal(pkg.name, "@kyoube/frondose", "T-FREN4b.PkgName.1: package.json name must be @kyoube/frondose");
    assert.equal(pkg.version, EXPECTED_VERSION, `T-FREN4b.PkgName.1: package.json version must be ${EXPECTED_VERSION}`);
  });

  it(`T-FREN4b.PkgName.2: package-lock.json root .name and .packages[''].name both equal '@kyoube/frondose'; root + packages[''] versions both equal '${EXPECTED_VERSION}'`, () => {
    // Given: post-Step-4 package-lock.json at repo root; version derived from package.json
    // When:  parsed as JSON
    // Then:  root name + packages[""].name === "@kyoube/frondose"; both version fields === EXPECTED_VERSION

    const lockPath = join(REPO, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf-8")) as {
      name: string;
      version: string;
      packages: Record<string, { name?: string; version: string }>;
    };
    assert.equal(lock.name, "@kyoube/frondose", "T-FREN4b.PkgName.2: package-lock root .name must be @kyoube/frondose");
    assert.equal(
      lock.version,
      EXPECTED_VERSION,
      `T-FREN4b.PkgName.2: package-lock root .version must be ${EXPECTED_VERSION}`,
    );
    assert.equal(
      lock.packages[""]?.name,
      "@kyoube/frondose",
      'T-FREN4b.PkgName.2: package-lock .packages[""].name must be @kyoube/frondose',
    );
    assert.equal(
      lock.packages[""]?.version,
      EXPECTED_VERSION,
      `T-FREN4b.PkgName.2: package-lock .packages[""].version must be ${EXPECTED_VERSION}`,
    );
  });
});

// ---------------------------------------------------------------------------
// T-FREN4b.SymlinkResolution + T-FREN4b.RepoRef — RETIRED with the CLI
// autoUpdate/update/install vertical (src/cli/autoUpdate/**, src/cli/subcommands/
// update.ts, install.sh all deleted per the P-OPEN-SOURCE-SPLIT ledger; the App
// updates via the Tauri updater, not the CLI installer).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T-FREN4b.TauriPathResolution — main.rs dual-name candidate arrays
// ---------------------------------------------------------------------------

describe("Tauri path resolution — dual-name candidate arrays in main.rs (T-FREN4b.TauriPathResolution)", () => {
  it("T-FREN4b.MainRs.1: full retirement — the Rust crate contains ONLY the App sidecar candidate; no CLI entry path remains", () => {
    // Given: full-rebrand Rust crate (operator directive 2026-06-15 — drop mai-agent back-compat)
    //        CH-3 module split: path resolution moved from main.rs to resolve.rs
    //        P-OPEN-SOURCE-SPLIT: the CLI entrypoint is retired (T-RETIRE.CLI.1)
    // When:  concatenated crate source is read and searched for candidate path substrings
    // Then:  the App sidecar @kyoube/frondose path is present; no dist/cli/main.js and no
    //        @kyoube/mai-agent path remains

    const crateDir = join(REPO, "src/tauri/src-tauri/src");
    const text = readdirSync(crateDir)
      .filter((f) => f.endsWith(".rs"))
      .sort()
      .map((f) => readFileSync(join(crateDir, f), "utf-8"))
      .join("\n");

    // Sidecar candidate — the only executable entry the App resolver knows
    const SIDECAR_FRONDOSE = "/opt/homebrew/lib/node_modules/@kyoube/frondose/dist/app/sidecarMain.js";

    assert.ok(text.includes(SIDECAR_FRONDOSE), `T-FREN4b.MainRs.1: sidecar @kyoube/frondose path must be present`);

    // No CLI entry literal and no @kyoube/mai-agent fallback may remain anywhere in the crate
    assert.ok(
      !text.includes("dist/cli/main.js"),
      `T-FREN4b.MainRs.1: no dist/cli/main.js literal may remain in the Rust crate (T-RETIRE.CLI.1)`,
    );
    assert.ok(
      !text.includes("@kyoube/mai-agent"),
      `T-FREN4b.MainRs.1: the crate must not contain any @kyoube/mai-agent fallback path`,
    );
  });
});

// ---------------------------------------------------------------------------
// T-FREN4b.Cosmetic — operator/LLM-visible strings
// ---------------------------------------------------------------------------

describe("cosmetic strings — frondose throughout operator-visible surfaces (T-FREN4b.Cosmetic)", () => {
  // (T-FREN4b.Cosmetic.1 — src/cli/repl.ts — retired with the REPL vertical.)
  it("T-FREN4b.Cosmetic.2: src/tools/webTools/webFetch.ts User-Agent string contains 'frondose/1.0' and 'kyoubelyu/frondose'; does NOT contain 'kyoubelyu/mai-agent'", () => {
    // Given: post-Step-4 src/tools/webTools/webFetch.ts
    // When:  file text is read to inspect the User-Agent literal
    // Then:  'frondose/1.0' and 'kyoubelyu/frondose' present; 'kyoubelyu/mai-agent' absent

    const text = readFileSync(join(REPO, "src/tools/webTools/webFetch.ts"), "utf-8");
    assert.ok(
      text.includes("frondose/1.0"),
      "T-FREN4b.Cosmetic.2: webFetch.ts must contain 'frondose/1.0' in User-Agent",
    );
    assert.ok(
      text.includes("kyoubelyu/frondose"),
      "T-FREN4b.Cosmetic.2: webFetch.ts must contain 'kyoubelyu/frondose' in User-Agent",
    );
    assert.ok(
      !text.includes("kyoubelyu/mai-agent"),
      "T-FREN4b.Cosmetic.2: webFetch.ts must NOT contain 'kyoubelyu/mai-agent'",
    );
  });

  it("T-FREN4b.Cosmetic.3: src/tools/control/escalate.ts issue-title prefix is '[frondose escalation]'; does NOT contain '[mai-agent escalation]'", () => {
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
  });

  it("T-FREN4b.Cosmetic.4: src/agent/systemPrompt/soul.ts default operator fallback name is 'frondose operator'; does NOT contain 'mai-agent operator'", () => {
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
  });
});
