/**
 * F-REN-4a Step 5 — Assertion bodies filled: no surviving .mai literal in production src/
 *
 * Covers:
 *   T-FREN4a.Paths.NoLeak — C-2-corrected scan: after Step 4 no *.ts or *.rs file
 *     under src/ (outside the documented allowlist) contains a `.mai` path literal.
 *     Allowlist: dataDirMigration.ts (LEGACY_DATA_DIR_NAME constant + prose comments) +
 *                main.rs (Rust back-compat fallback read + prose comments).
 *
 *   T-FREN4a.NoBashSafe — src/persistence/dataDirMigration.ts contains no
 *     child_process / spawnSync / exec call.
 *
 * Gate coverage: T-FREN4a.Paths.NoLeak (C-2), T-FREN4a.NoBashSafe
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/contract/fren4a-no-mai-literal.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";

const REPO = resolve(process.cwd());
const SRC_DIR = join(REPO, "src");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect *.ts + *.rs files under dir, skipping excluded paths. */
function collectFiles(dir: string, extensions: string[], excluded: string[]): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(REPO, full).replace(/\\/g, "/");
    if (excluded.some((ex) => rel.startsWith(ex))) continue;
    if (entry.isDirectory()) {
      files.push(...collectFiles(full, extensions, excluded));
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Find all `.mai\b` occurrences in a line of text that are NOT:
 *   - preceded by `.mai-` (e.g. "mai-browser", "mai-agent")
 *   - part of `MAI_` env var names
 *
 * Returns an array of {lineNo, line} for each offending line.
 */
function findMaiLiterals(text: string): Array<{ lineNo: number; line: string }> {
  const results: Array<{ lineNo: number; line: string }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Check for .mai\b pattern — catches both segment ".mai" and string ".mai/..."
    if (/\.mai\b/.test(line)) {
      // Exclude: .mai- prefix (mai-browser, mai-agent, etc.)
      // Exclude: MAI_ env names
      // Keep: actual .mai path literals (both standalone and with path suffix)
      const cleaned = line.replace(/\.mai-\w*/g, "").replace(/MAI_[A-Z0-9_]*/g, "");
      if (/\.mai\b/.test(cleaned)) {
        results.push({ lineNo: i + 1, line: line.trim() });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Allowlist: files permitted to contain .mai\b after Step 4
// ---------------------------------------------------------------------------

/**
 * After F-REN-4e, the ONLY non-test production files permitted to contain `.mai\b` are:
 *
 *   1. src/tauri/src-tauri/src/main.rs — the back-compat fallback lines (both code literals
 *      and prose doc-comments) inside read_update_server_url + read_update_check_interval_sec.
 *      These are the ONLY Rust allowlist entries. (§6.4 R-1 design)
 *
 *   NOTE: src/persistence/dataDirMigration.ts was deleted in F-REN-4e — no longer allowlisted.
 */
const ALLOWLISTED_RELATIVE_PATHS = new Set<string>([
  "src/tauri/src-tauri/src/main.rs",
]);

const EXCLUDED_PREFIXES = [
  "src/tauri/src-tauri/target/", // Rust build artifacts
  "src/tauri/ui/", // Tauri UI (no path literals)
];

// ---------------------------------------------------------------------------
// T-FREN4a.Paths.NoLeak — no .mai literal outside allowlist after Step 4
// ---------------------------------------------------------------------------

describe("source-scan guard — no .mai path literals outside allowlist after Step 4 (T-FREN4a.Paths.NoLeak)", () => {
  it("T-FREN4a.Paths.NoLeak: grep -rnE '.mai\\b' src/ --include='*.ts' --include='*.rs' (excluding .mai-/MAI_) returns ZERO non-allowlisted hits", () => {
    // Given: post-Step-4 working tree
    // When:  C-2-corrected scan runs: .mai\b pattern, both segment and string forms caught
    // Then:  zero violations outside the documented allowlist
    const files = collectFiles(SRC_DIR, [".ts", ".rs"], EXCLUDED_PREFIXES);
    const violations: string[] = [];

    for (const filePath of files) {
      const rel = relative(REPO, filePath).replace(/\\/g, "/");
      if (ALLOWLISTED_RELATIVE_PATHS.has(rel)) continue;
      let text: string;
      try {
        text = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }
      const hits = findMaiLiterals(text);
      for (const hit of hits) {
        violations.push(`  ${rel}:${hit.lineNo}  ${hit.line}`);
      }
    }

    assert.deepEqual(violations, [],
      `C-2 violation: ${violations.length} .mai literal(s) found outside the allowlist:\n${violations.join("\n")}`);
  });
});

// ---------------------------------------------------------------------------
// T-FREN4a.NoBashSafe — dataDirMigration.ts has no child_process/exec
// ---------------------------------------------------------------------------

describe("NoBashSafe: src/persistence/dataDirMigration.ts was deleted in F-REN-4e (T-FREN4a.NoBashSafe)", () => {
  it("T-FREN4a.NoBashSafe: dataDirMigration.ts contains no child_process, spawnSync, execSync, exec, or spawn call", () => {
    // Given: F-REN-4e deleted src/persistence/dataDirMigration.ts entirely
    // When:  the file path is checked for existence
    // Then:  the file does NOT exist — bash-safety is guaranteed by deletion
    const migrationPath = join(REPO, "src/persistence/dataDirMigration.ts");

    assert.ok(!existsSync(migrationPath),
      "src/persistence/dataDirMigration.ts must NOT exist after F-REN-4e deletion (migration logic was removed)");
  });
});
