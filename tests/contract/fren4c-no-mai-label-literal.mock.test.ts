/**
 * F-REN-4c Step 3 — Test Scaffold (outside-in TDD)
 *
 * Covers:
 *   T-FREN4c.Label.1  — LABEL === "com.kyoube.frondose.telegram"
 *   T-FREN4c.Label.2  — SERVER_LABEL === "com.kyoube.frondose.server"
 *   T-FREN4c.Plist.1  — renderPlist XML contains frondose.telegram label; NOT mai.telegram
 *   T-FREN4c.Plist.2  — renderServerPlist XML contains frondose.server label; NOT mai.server
 *   T-FREN4c.PlistPath.1 — plistPath ends with Library/LaunchAgents/com.kyoube.frondose.telegram.plist
 *   T-FREN4c.PlistPath.2 — serverPlistPath ends with com.kyoube.frondose.server.plist
 *   T-FREN4c.NoLeak.1 — src/**\/*.ts scan for /com\.kyoube\.mai\.(telegram|server)/ → ZERO hits
 *
 * Gate coverage: G-FREN4c.Label · G-FREN4c.Plist · G-FREN4c.PlistPath · G-FREN4c.NoLeak
 *
 * Outside-in TDD: T-FREN4c.Label.1/2 + Plist.1/2 + PlistPath.1/2 FAIL pre-flip
 * (current constants emit "com.kyoube.mai.*").
 * T-FREN4c.NoLeak.1 PASSES pre-flip (source is already templated — no hardcoded literal).
 * All assertions turn green after Step 4 flips LEGACY_LABEL_NAMESPACE → LABEL_NAMESPACE = "frondose".
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/contract/fren4c-no-mai-label-literal.mock.test.ts
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";

const REPO = resolve(process.cwd());
const SRC_DIR = join(REPO, "src");

// ---------------------------------------------------------------------------
// Helpers — mirrored from fren4b-no-mai-agent-literal.mock.test.ts
// ---------------------------------------------------------------------------

/**
 * Recursively collect *.ts files under dir, skipping excluded path prefixes
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

const SCAN_EXCLUDED_PREFIXES = [
  "src/tauri/src-tauri/target/", // Rust build artifacts
  "src/tauri/ui/", // UI assets
];

const MAI_LABEL_PATTERNS = [/com\.kyoube\.mai\.(telegram|server)/];

// ---------------------------------------------------------------------------
// T-FREN4c.Label / T-FREN4c.Plist / T-FREN4c.PlistPath — RETIRED with the CLI
// launchd vertical (src/cli/subcommands/launchd.ts + serverLaunchd.ts are
// deleted per the P-OPEN-SOURCE-SPLIT ledger; the App is Tauri-managed).
// The NoLeak source-scan guard below remains.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T-FREN4c.NoLeak.1 — source-scan regression guard
// ---------------------------------------------------------------------------

describe("source-scan guard — no com.kyoube.mai.(telegram|server) literal in src/**/*.ts (T-FREN4c.NoLeak)", () => {
  it("T-FREN4c.NoLeak.1: grep src/**/*.ts for /com\\.kyoube\\.mai\\.(telegram|server)/ returns ZERO hits", () => {
    // Given: src/ TypeScript tree with constants templatized (LABEL_NAMESPACE replaces LEGACY_LABEL_NAMESPACE)
    // When:  pattern scan runs over src/**/*.ts, excluding build artifacts
    // Then:  zero violations — the literal "com.kyoube.mai.telegram" or "com.kyoube.mai.server"
    //        does NOT appear anywhere in source (the guard locks against future hardcodes)
    // NOTE:  The regex does NOT match com.kyoube.mai.update-server, bare com.kyoube.mai,
    //        or mai-com.kyoube.mai- (socket dir prefix in main.rs — 4d scope).

    const tsFiles = collectFiles(SRC_DIR, [".ts"], SCAN_EXCLUDED_PREFIXES);
    const violations: string[] = [];

    for (const filePath of tsFiles) {
      const relPath = relative(REPO, filePath).replace(/\\/g, "/");
      let text: string;
      try {
        text = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const hits = findPatternHits(text, MAI_LABEL_PATTERNS);
      for (const { lineNo, line } of hits) {
        violations.push(`${relPath}:${lineNo}: ${line}`);
      }
    }

    assert.deepEqual(
      violations,
      [],
      `T-FREN4c.NoLeak.1: ${violations.length} hit(s) found — "com.kyoube.mai.(telegram|server)" must not appear in src/**/*.ts:\n${violations.join("\n")}`,
    );
  });
});
