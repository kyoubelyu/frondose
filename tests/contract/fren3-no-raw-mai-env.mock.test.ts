/**
 * F-REN-3 Step 5 — Filled assertions: T-FREN3.7
 *
 * Source-scan guard: asserts that after Step 4 lands, zero raw
 * `process.env.MAI_*` reads remain in production src/ outside the shim
 * self-reference (src/env.ts) and the server-path documentation exception.
 *
 * PRE-STEP-4 BASELINE (measured 2026-06-12 on main before any F-REN-3 builder edits):
 *   grep -rlE "process\.env\.MAI_[A-Z0-9_]+" src/ --include='*.ts' | grep -v /target/ | wc -l
 *   → 25 distinct files (raw count)
 *
 *   Files with process.env.MAI_* (Group A + Group C + docstring):
 *     src/agent/maxSteps.ts
 *     src/agent/modelResolver.ts
 *     src/agent/pi/model.ts
 *     src/app/sidecarMain.ts
 *     src/cli/autoUpdate.ts
 *     src/cli/bootstrap-agent.ts
 *     src/cli/env.ts
 *     src/cli/main.ts
 *     src/cli/repl.ts
 *     src/cli/serverDaemon.ts
 *     src/cli/serverRepl.ts
 *     src/cli/subcommands/_prompts.ts
 *     src/cli/subcommands/passiveRateLimit.ts
 *     src/app/backend/index.ts
 *     src/cli/subcommands/server.ts
 *     src/cli/subcommands/telegram.ts
 *     src/cli/subcommands/telegramDaemon.ts
 *     src/cli/subcommands/update.ts
 *     src/linkedin/pacing.ts
 *     src/linkedin/uploadAllowlist.ts
 *     src/overlay/host.ts
 *     src/persistence/paths.ts
 *     src/persistence/secrets.ts          ← historical Group C, now deleted
 *     src/persistence/serverPaths.ts      ← docstring only at :3, not a live read — plan §2 excludes
 *     src/tools/webTools/analyzeScreenshot.ts
 *
 *   NOTE: src/tier.ts reads env.MAI_TIER via param-injected env (not process.env.MAI_TIER),
 *   so it does NOT appear in the grep scan — it is still in builder scope via a different path.
 *
 *   NOTE: src/persistence/serverPaths.ts:3 is a docstring comment containing the text
 *   "process.env.MAI_HOME_BASE" as documentation. It is NOT a live read. The plan excludes
 *   it from the rename scope (§2, N-1 corrected totals). The guard below includes it in the
 *   allowlist so a docstring comment does not fail the test.
 *
 *   ROSTER GAP CHECK: All 24 plan §3 Group A files + the historical Group C file + 1 docstring
 *   (serverPaths.ts) = 26 files expected in the pre-Step-4 scan. Observed: 25 raw files.
 *   Reconciliation: src/tier.ts is excluded from the raw scan because its read is via the
 *   param-injected `env` argument (env.MAI_TIER), not process.env.MAI_TIER directly — this
 *   matches the plan's corrected totals (§2, N-1). No undocumented file found.
 *
 * Gate coverage: G-FREN3.guard ("61 reads go through the shim" ROADMAP target)
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/contract/fren3-no-raw-mai-env.mock.test.ts
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it } from "node:test";

const REPO = resolve(process.cwd());
const SRC_DIR = join(REPO, "src");

// ─── scan helpers ─────────────────────────────────────────────────────────────

/** Recursively collect *.ts files under dir, skipping excluded paths. */
function collectTsFiles(dir: string, excluded: string[]): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(REPO, full).replace(/\\/g, "/");
    if (excluded.some((ex) => rel.startsWith(ex))) continue;
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full, excluded));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Find all `process.env.MAI_<NAME>` occurrences in a file's text.
 * Returns an array of { lineNo, match } for each hit.
 */
function findRawMaiReads(text: string): Array<{ lineNo: number; match: string }> {
  const pattern = /process\.env\.MAI_[A-Z0-9_]+/g;
  const results: Array<{ lineNo: number; match: string }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const p = new RegExp(pattern.source, "g");
    for (let m = p.exec(line); m !== null; m = p.exec(line)) {
      results.push({ lineNo: i + 1, match: m[0] });
    }
  }
  return results;
}

// ─── allowlist: files permitted to contain raw process.env.MAI_ after Step 4 ─

/**
 * After Step 4, the ONLY files permitted to contain raw `process.env.MAI_*` are:
 *
 *   1. src/env.ts — the shim itself (it references the literal MAI_ prefix string as
 *      `env["MAI_${name}"]`; this is NOT a raw process.env.MAI_LITERAL read — it's
 *      a computed access. The regex `process\.env\.MAI_[A-Z]` does NOT match this
 *      pattern. But we include it in the allowlist for safety.)
 *
 *   2. src/persistence/serverPaths.ts — docstring at line :3 contains the text
 *      "process.env.MAI_HOME_BASE" as documentation. Not a live read; kept as-is.
 */
const ALLOWLISTED_RELATIVE_PATHS = new Set<string>([
  "src/env.ts", // shim self-reference
  "src/persistence/serverPaths.ts", // docstring only — not a live read
]);

// Directories to exclude from the scan:
const EXCLUDED_PREFIXES = [
  "src/tauri/src-tauri/target/", // Rust build artifacts
  "src/tauri/ui/", // Tauri UI (confirmed: no MAI env reads)
];

// ─── T-FREN3.7 ────────────────────────────────────────────────────────────────

describe("source-scan guard — zero raw process.env.MAI_ reads in production src/ (G-FREN3.guard)", () => {
  it("T-FREN3.7: after Step 4, no production *.ts file outside declared non-code exceptions contains process.env.MAI_<NAME>", () => {
    // Given: production src/ tree (*.ts, excluding target/ and tauri/ui/)
    // When:  regex scan for process.env.MAI_[A-Z0-9_]+ in every non-allowlisted file
    // Then:  the match set is empty — every former MAI_* read is now routed through frondoseEnv()

    const tsFiles = collectTsFiles(SRC_DIR, EXCLUDED_PREFIXES);

    const violations: string[] = [];

    for (const filePath of tsFiles) {
      const rel = relative(REPO, filePath).replace(/\\/g, "/");
      if (ALLOWLISTED_RELATIVE_PATHS.has(rel)) continue;

      let text: string;
      try {
        text = readFileSync(filePath, "utf8");
      } catch {
        continue; // file not readable — skip (e.g. generated artifacts)
      }

      const hits = findRawMaiReads(text);
      for (const hit of hits) {
        violations.push(`  ${rel}:${hit.lineNo}  ${hit.match}`);
      }
    }

    assert.deepEqual(violations, [], `Raw process.env.MAI_* reads found outside allowlist:\n${violations.join("\n")}`);
  });
});
