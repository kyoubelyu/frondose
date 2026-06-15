/**
 * F-REN-4d Step 3 — Test Scaffold (outside-in TDD)
 *
 * Covers:
 *   T-FREN4d.Identifier.1 — tauri.conf.json .identifier === "com.kyoube.frondose";
 *                            NOT "com.kyoube.mai"
 *   T-FREN4d.Socket.1     — src/tauri/src-tauri/src/main.rs text scan:
 *                            contains "frondose-com.kyoube.frondose-" AND "frondose.sock";
 *                            does NOT contain "mai-com.kyoube.mai-" or the literal "mai.sock"
 *   T-FREN4d.Quad.1       — all 5 quad sites === "0.5.0-alpha.56":
 *                            package.json .version; package-lock.json root .version +
 *                            .packages[""].version; tauri.conf.json .version; Cargo.toml
 *                            [package].version; Cargo.lock mai-tauri block version
 *   T-FREN4d.NoLeak.1     — collectFiles(src, [.ts,.rs,.json], [tauri/target, tauri/ui])
 *                            scanned for /com\.kyoube\.mai/ (plain substring, NO \b —
 *                            per 2a CONCERN-1 fix) → ZERO hits; this is the CAPSTONE guard
 *                            completing the F-REN program
 *
 * Gate coverage:
 *   G-FREN4d.Identifier · G-FREN4d.Socket · G-FREN4d.Quad · G-FREN4d.NoLeak
 *
 * Outside-in TDD pre-flip red state (current = com.kyoube.mai / mai.sock / alpha.54):
 *   T-FREN4d.Identifier.1  — FAILS (identifier is still "com.kyoube.mai")
 *   T-FREN4d.Socket.1      — FAILS (main.rs still has "mai-com.kyoube.mai-" + "mai.sock")
 *   T-FREN4d.Quad.1        — FAILS (version is "0.5.0-alpha.54", not "0.5.0-alpha.56")
 *   T-FREN4d.NoLeak.1      — FAILS with exactly 2 hits:
 *                              src/tauri/src-tauri/src/main.rs:313
 *                              src/tauri/src-tauri/tauri.conf.json:5
 *
 * All turn green after Step 4 flips identifier + socket-dir + bumps version quad.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/contract/fren4d-no-mai-bundle-literal.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";

const REPO = resolve(process.cwd());
const SRC_DIR = join(REPO, "src");

// ---------------------------------------------------------------------------
// Helpers: file walker + pattern scanner (mirrored from fren4b/fren4c guards)
// ---------------------------------------------------------------------------

/**
 * Recursively collect files matching extensions under dir, skipping excluded path
 * prefixes (relative to REPO root, e.g. "src/tauri/src-tauri/target/").
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
// Cargo version extractors (mirrored from selfContainedBundle.mock.test.ts)
// ---------------------------------------------------------------------------

const cargoToml = readFileSync(join(REPO, "src/tauri/src-tauri/Cargo.toml"), "utf-8");
const cargoLock = readFileSync(join(REPO, "src/tauri/src-tauri/Cargo.lock"), "utf-8");

function cargoTomlPackageVersion(): string {
  const packageSection = cargoToml.match(/\[package\][\s\S]*?(?:\n\[|$)/)?.[0] ?? "";
  const version = packageSection.match(/\nversion\s*=\s*"([^"]+)"/)?.[1];
  assert.ok(version, "Cargo.toml [package].version must be present");
  return version;
}

function cargoLockMaiTauriVersion(): string {
  const version = cargoLock.match(/\[\[package\]\]\s*\nname = "frondose"\s*\nversion = "([^"]+)"/)?.[1];
  assert.ok(version, 'Cargo.lock [[package]] name = "frondose" version must be present');
  return version;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXPECTED_IDENTIFIER = "com.kyoube.frondose";
const EXPECTED_VERSION = "0.5.0-alpha.56";

const SCAN_EXCLUDED_PREFIXES = [
  "src/tauri/src-tauri/target/", // Rust build artifacts
  "src/tauri/ui/",               // UI assets
];

// Plain substring regex — NO \b (per 2a CONCERN-1 fix).
// The rationale: after 4d, the ONLY two com.kyoube.mai occurrences in src/ are
// tauri.conf.json:5 (identifier) and main.rs:313 (socket dir prefix); both are
// renamed in Step 4. \b was dropped because it fires at the `.` boundary and would
// therefore also match "com.kyoube.mai.telegram" — but that is irrelevant here since
// the 4c guard already removed dotted sub-labels. The plain substring is the correct
// capstone: "ZERO com.kyoube.mai of ANY form in src/".
const COM_KYOUBE_MAI_PATTERN = /com\.kyoube\.mai/;

// ---------------------------------------------------------------------------
// T-FREN4d.Identifier.1 — bundle identifier (tauri.conf.json)
// ---------------------------------------------------------------------------

describe("bundle identifier — com.kyoube.frondose (T-FREN4d.Identifier)", () => {
  it(
    "T-FREN4d.Identifier.1: when tauri.conf.json is parsed, .identifier === 'com.kyoube.frondose' and NOT 'com.kyoube.mai'",
    () => {
      // Given: src/tauri/src-tauri/tauri.conf.json (post-Step-4 — identifier flipped)
      // When:  parsed as JSON
      // Then:  .identifier === "com.kyoube.frondose"; NOT "com.kyoube.mai"

      const tauriConf = JSON.parse(
        readFileSync(join(REPO, "src/tauri/src-tauri/tauri.conf.json"), "utf-8"),
      ) as { identifier?: string };

      assert.equal(
        tauriConf.identifier,
        EXPECTED_IDENTIFIER,
        `T-FREN4d.Identifier.1: tauri.conf.json .identifier must be "${EXPECTED_IDENTIFIER}"; got "${tauriConf.identifier}"`,
      );
      assert.ok(
        tauriConf.identifier !== "com.kyoube.mai",
        `T-FREN4d.Identifier.1: tauri.conf.json .identifier must NOT be "com.kyoube.mai"`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-FREN4d.Socket.1 — socket-dir identity (main.rs text scan)
// ---------------------------------------------------------------------------

describe("port-file identity — frondose-com.kyoube.frondose-* / frondose.port (T-FREN4d.Socket)", () => {
  it(
    "T-FREN4d.Socket.1: when main.rs text is read, it contains 'frondose-com.kyoube.frondose-' AND 'frondose.port'; does NOT contain 'mai-com.kyoube.mai-' or 'mai.sock' or 'frondose.sock'",
    () => {
      // Given: src/tauri/src-tauri/src/main.rs (post-WIN-1 — UDS transport replaced with
      //        TCP loopback + port-file; frondose.sock replaced by frondose.port)
      // When:  file text is read and searched for identity substrings
      // Then:  frondose-com.kyoube.frondose- present (temp dir prefix, unchanged);
      //        frondose.port present (new port-file name replacing frondose.sock);
      //        mai-com.kyoube.mai- absent (old dir prefix gone);
      //        frondose.sock absent (replaced by frondose.port in WIN-1);
      //        "mai.sock" literal absent
      //
      // NOTE: This is a Rust source text-assertion mirroring T-FREN4b.MainRs.1 pattern.
      // main.rs is not unit-testable from Node; the text scan is the correct approach.

      const mainRs = readFileSync(
        join(REPO, "src/tauri/src-tauri/src/main.rs"),
        "utf-8",
      );

      assert.ok(
        mainRs.includes("frondose-com.kyoube.frondose-"),
        `T-FREN4d.Socket.1: main.rs must contain "frondose-com.kyoube.frondose-" (temp dir prefix)`,
      );
      assert.ok(
        mainRs.includes("frondose.port"),
        `T-FREN4d.Socket.1: main.rs must contain "frondose.port" (WIN-1 port-file replacing frondose.sock)`,
      );
      assert.ok(
        !mainRs.includes("mai-com.kyoube.mai-"),
        `T-FREN4d.Socket.1: main.rs must NOT contain "mai-com.kyoube.mai-" (old socket dir prefix)`,
      );
      assert.ok(
        !mainRs.includes("frondose.sock"),
        `T-FREN4d.Socket.1: main.rs must NOT contain "frondose.sock" (replaced by frondose.port in WIN-1)`,
      );
      assert.ok(
        !mainRs.includes('"mai.sock"'),
        `T-FREN4d.Socket.1: main.rs must NOT contain the literal "mai.sock" string`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// T-FREN4d.Quad.1 — version bump to alpha.55 (all 5 quad sites)
// ---------------------------------------------------------------------------

describe("version quad — all 5 sites === '0.5.0-alpha.56' (T-FREN4d.Quad)", () => {
  it(
    "T-FREN4d.Quad.1: package.json, package-lock.json root + packages[''], tauri.conf.json, Cargo.toml, Cargo.lock mai-tauri all share '0.5.0-alpha.56'",
    () => {
      // Given: the 5 quad files at their post-Step-4 state
      // When:  each version field is read
      // Then:  all 5 sites === "0.5.0-alpha.56" (the F-REN-4d version bump)

      const pkgJson = JSON.parse(
        readFileSync(join(REPO, "package.json"), "utf-8"),
      ) as { version: string };

      const packageLock = JSON.parse(
        readFileSync(join(REPO, "package-lock.json"), "utf-8"),
      ) as {
        version?: string;
        packages?: Record<string, { version?: string }>;
      };

      const tauriConf = JSON.parse(
        readFileSync(join(REPO, "src/tauri/src-tauri/tauri.conf.json"), "utf-8"),
      ) as { version?: string };

      const versions: Record<string, string | undefined> = {
        "package.json.version": pkgJson.version,
        "package-lock.json.version": packageLock.version,
        'package-lock.json.packages[""].version': packageLock.packages?.[""]?.version,
        "tauri.conf.json.version": tauriConf.version,
        "Cargo.toml [package].version": cargoTomlPackageVersion(),
        "Cargo.lock mai-tauri version": cargoLockMaiTauriVersion(),
      };

      for (const [label, version] of Object.entries(versions)) {
        assert.strictEqual(
          version,
          EXPECTED_VERSION,
          `T-FREN4d.Quad.1: ${label} must be "${EXPECTED_VERSION}"; got "${version}"`,
        );
      }
    },
  );
});

// ---------------------------------------------------------------------------
// T-FREN4d.NoLeak.1 — CAPSTONE: zero com.kyoube.mai of any form in src/
// ---------------------------------------------------------------------------

describe(
  "source-scan CAPSTONE guard — ZERO com.kyoube.mai of any form in src/ (T-FREN4d.NoLeak)",
  () => {
    it(
      "T-FREN4d.NoLeak.1: collectFiles(src, [.ts,.rs,.json], [tauri/target, tauri/ui]) scanned for /com\\.kyoube\\.mai/ (plain substring, NO \\b) → ZERO hits",
      () => {
        // Given: src/ tree (post-Step-4): tauri.conf.json identifier flipped to frondose;
        //        main.rs socket-dir infix flipped to frondose; all 4c dotted sub-labels
        //        (com.kyoube.mai.telegram/server) already removed in F-REN-4c;
        //        .ts, .rs, AND .json extensions in scope (tauri.conf.json must be reachable)
        // When:  plain-substring scan /com\.kyoube\.mai/ runs over src/**/*.{ts,rs,json}
        //        (excluding tauri/target build artifacts and tauri/ui UI assets)
        // Then:  ZERO violations — no com.kyoube.mai identity literal of ANY form remains
        //
        // Pre-flip red state: exactly 2 hits expected:
        //   src/tauri/src-tauri/src/main.rs:313 (socket dir: "mai-com.kyoube.mai-...")
        //   src/tauri/src-tauri/tauri.conf.json:5 (identifier: "com.kyoube.mai")
        //
        // This guard does NOT match the KEPT internal identifiers:
        //   - "mai-tauri" (hyphen, no dotted namespace)
        //   - "@kyoube/mai-agent" (slash, no dotted namespace)
        //   - "MAI_*" env vars (no dotted namespace)
        //   - "spawn_mai_serve" / "resolve_mai_*" Rust fns (no dotted namespace)

        // Include .ts, .rs, and .json (tauri.conf.json must be in scope)
        const files = collectFiles(SRC_DIR, [".ts", ".rs", ".json"], SCAN_EXCLUDED_PREFIXES);

        const violations: string[] = [];

        for (const filePath of files) {
          const relPath = relative(REPO, filePath).replace(/\\/g, "/");
          let text: string;
          try {
            text = readFileSync(filePath, "utf-8");
          } catch {
            continue;
          }
          const hits = findPatternHits(text, [COM_KYOUBE_MAI_PATTERN]);
          for (const { lineNo, line } of hits) {
            violations.push(`${relPath}:${lineNo}: ${line}`);
          }
        }

        assert.deepEqual(
          violations,
          [],
          `T-FREN4d.NoLeak.1: ${violations.length} hit(s) found — "com.kyoube.mai" must not appear anywhere in src/**/*.{ts,rs,json} after Step 4:\n${violations.join("\n")}`,
        );
      },
    );
  },
);
