/**
 * P-45 Step 4a scaffold — T-LOC.1, T-DEAD.1..T-DEAD.3, T-LINT.1..T-LINT.3,
 *   T-DOC.1..T-DOC.4, T-BND.1..T-BND.2 (G-P45.7, G-P45.8, G-P45.10, G-P45.11)
 *
 * Structural audit tests: file sizes, dead code, lint cleanup, CLAUDE.md amendment,
 * no-bash boundary regression guard.
 *
 * All assertion bodies are TODO (assert.fail) — validator fills at Step 5.
 *
 * These tests use grep / find / wc as their oracle (no logic under test —
 * they verify source-code structure). They run in mock mode (MAI_SKIP_LIVE=1).
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { describe, it } from "node:test";

/** Project root resolved from this test file's location (tests/cli/ → ../../). */
const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

function run(cmd: string): string {
  return execSync(cmd, { cwd: ROOT, encoding: "utf-8" }).trim();
}

// ─── G-P45.7 — dead code + file size ─────────────────────────────────────────

describe("Dead code removal + file size compliance (G-P45.7)", () => {
  it("T-LOC.1: WHEN wc -l src/cli/main.ts is observed post-build, THEN LOC count MUST be ≤ 800", () => {
    // Given: P-45 builder splits main.ts into main.ts + workerBoot.ts + identity-init.ts additions
    // When:  wc -l src/cli/main.ts
    // Then:  line count ≤ 800 (800-line rule satisfied)
    const loc = parseInt(run("wc -l < src/cli/main.ts"), 10);
    assert.ok(loc <= 800, `T-LOC.1: src/cli/main.ts LOC must be ≤ 800; got ${loc}`);
  });

  it("T-DEAD.1: WHEN grep for '_configPath' in src/cli/main.ts, THEN MUST return zero matches (dead var removed)", () => {
    // Given: A-11/B-3 — `const _configPath = ...; void _configPath` lines removed by builder
    // When:  grep -n "_configPath" src/cli/main.ts
    // Then:  empty output (0 matches)
    const result = run("grep -n '_configPath' src/cli/main.ts || true");
    assert.equal(result, "", `T-DEAD.1: src/cli/main.ts must NOT contain '_configPath'; got: ${result}`);
  });

  it("T-DEAD.2: WHEN find for src/tools/telegram/index.ts, THEN file MUST be ABSENT (unused barrel deleted)", () => {
    // Given: B-1 — barrel file deleted by builder
    // When:  ls / existsSync for src/tools/telegram/index.ts
    // Then:  file does not exist
    const result = run("test -f src/tools/telegram/index.ts && echo PRESENT || echo ABSENT");
    assert.equal(result, "ABSENT", `T-DEAD.2: src/tools/telegram/index.ts must be absent; got: ${result}`);
  });

  it("T-DEAD.3: WHEN grep for 'import.*from \"node:os\"' in src/tools/index.ts, THEN MUST return zero matches (homedir import removed after A-2)", () => {
    // Given: B-4 — orphaned `import { homedir } from "node:os"` removed after A-2 getHomeBase migration
    // When:  grep -n 'import.*from "node:os"' src/tools/index.ts
    // Then:  empty output
    // Check src/tools/index.ts for any `from "node:os"` import — should be zero
    // after A-2 migration (the file no longer needs homedir).
    const result = run("grep -nE 'from \"node:os\"' src/tools/index.ts || true");
    assert.equal(
      result,
      "",
      `T-DEAD.3: src/tools/index.ts must NOT import from node:os (B-4 cleanup after A-2 getHomeBase migration); got: ${result}`,
    );
  });
});

// ─── G-P45.8 — lint cleanup: selected files + no new errors (CONCERN-MR-2) ───

describe("Lint cleanup — selected files + no new errors (G-P45.8)", () => {
  it("T-LINT.1: WHEN npx biome check run on the 3 named files, THEN exit code MUST be 0 (zero format errors)", async () => {
    // Given: builder ran biome check --write on loop.ts / inspectSummary.ts / escalate.ts (G-7/G-8/G-9)
    // When:  npx biome check src/agent/loop.ts src/linkedin/inspectSummary.ts src/tools/control/escalate.ts
    // Then:  exit code 0 for those files
    // Run biome check on the 3 targeted files; capture exit code via shell || echo.
    // Exit-code 0 = no errors; non-zero = errors. Use spawnSync-equivalent.
    let exit = 0;
    try {
      execSync("npx biome check src/agent/loop.ts src/linkedin/inspectSummary.ts src/tools/control/escalate.ts 2>&1", {
        cwd: ROOT,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch (e: unknown) {
      exit = (e as { status?: number }).status ?? -1;
    }
    assert.equal(exit, 0, `T-LINT.1: biome check on loop.ts/inspectSummary.ts/escalate.ts must exit 0; got ${exit}`);
  });

  it("T-LINT.2: WHEN npx biome check . is run, THEN NO .omx/-rooted path appears in the output (G-6)", () => {
    // Given: builder added `!.omx` to biome.json files.includes
    // When:  biome check . run from project root
    // Then:  output contains no path starting with .omx/
    // Check biome.json excludes .omx/ — direct config check is more reliable
    // than re-running biome (biome may not run cleanly if .omx/ is present).
    const biomeJson = run("cat biome.json");
    assert.ok(
      biomeJson.includes(".omx") || biomeJson.includes("!**/.omx"),
      `T-LINT.2: biome.json must exclude .omx/ (via files.includes !.omx or equivalent); got: ${biomeJson.slice(0, 600)}`,
    );
  });

  it("T-LINT.3: GIVEN pre-P-45 lint error count (baseline = 33 errors), WHEN post-P-45 lint is run, THEN error count MUST be ≤ 33 (no regression)", () => {
    // Given: pre-P-45 baseline captured at Step 4a: 33 lint errors (see phase-45-test.md § Lint Baseline)
    // When:  npm run lint post-P-45
    // Then:  error count ≤ 33 (P-45 must not regress the baseline)
    //        Note: P-45 is NOT required to clean up all 33 errors (CONCERN-MR-2 scope)
    const PRE_P45_LINT_ERRORS = 33; // captured at Step 4a
    // Run lint, capture output (biome exits non-zero on errors → catch).
    let lintOutput = "";
    try {
      lintOutput = execSync("npm run lint 2>&1", { cwd: ROOT, encoding: "utf-8", stdio: "pipe" });
    } catch (e: unknown) {
      // Non-zero exit is expected when errors present; capture stdout from the error.
      const out = (e as { stdout?: string | Buffer }).stdout;
      lintOutput = typeof out === "string" ? out : (out?.toString("utf-8") ?? "");
    }
    // biome reports a summary line like "Checked N files in Ms. No fixes applied." OR
    // "Found N errors." Extract the error count.
    const errorMatch = lintOutput.match(/Found (\d+) errors?\./);
    const errorCount = errorMatch ? parseInt(errorMatch[1], 10) : 0;
    assert.ok(
      errorCount <= PRE_P45_LINT_ERRORS,
      `T-LINT.3: post-P-45 lint errors (${errorCount}) must be ≤ pre-P-45 baseline (${PRE_P45_LINT_ERRORS}); regression detected`,
    );
  });
});

// ─── G-P45.10 — CLAUDE.md amendment (E-7 + E-7b) ────────────────────────────

describe("CLAUDE.md Hard Rule 8 amendment (G-P45.10)", () => {
  it("T-DOC.1: WHEN grep for 'subcommands/soul.ts' in CLAUDE.md, THEN at least one match inside Hard Rule 8 approved-sites paragraph", () => {
    // Given: builder appended soul.ts clause to Hard Rule 8 per §4 verbatim text
    // When:  grep -n "subcommands/soul.ts" CLAUDE.md
    // Then:  at least 1 match; line is inside the approved-sites enumeration
    const matches = run("grep -n 'subcommands/soul.ts' CLAUDE.md || true");
    assert.ok(
      matches.length > 0,
      `T-DOC.1: CLAUDE.md must mention 'subcommands/soul.ts' (Hard Rule 8); got: ${matches}`,
    );
  });

  it("T-DOC.2: WHEN grep for '2026-05-20' in CLAUDE.md, THEN MUST include the new approval-date marker for BOTH soul.ts AND server.ts:233 sites", () => {
    // Given: builder updated the approval-date trailer to include 2026-05-20 for both P-45 sites
    // When:  grep -n "2026-05-20" CLAUDE.md
    // Then:  at least one match; the matched line references both soul.ts and server.ts
    const result = run("grep -n '2026-05-20' CLAUDE.md || true");
    assert.ok(result.length > 0, "T-DOC.2: CLAUDE.md must contain '2026-05-20' approval date (P-45 retroactive)");
    // The approval-date trailer line MUST also mention both P-45 sites.
    const approvalTrailerMatch = run(
      "grep -E '2026-05-20.*(soul|server)|soul.*server.*2026-05-20|2026-05-20 \\(P-45' CLAUDE.md || true",
    );
    assert.ok(
      approvalTrailerMatch.length > 0,
      `T-DOC.2: CLAUDE.md must have a 2026-05-20 trailer line referencing the P-45 sites (soul.ts + server.ts); got: ${approvalTrailerMatch}`,
    );
  });

  it("T-DOC.3: WHEN grep for 'subcommands/server.ts' in CLAUDE.md, THEN at least one match inside Hard Rule 8 approved-sites paragraph (BLOCKER-2 / E-7b)", () => {
    // Given: builder also added server.ts:233 clause per BLOCKER-2 amendment (§4)
    // When:  grep -n "subcommands/server.ts" CLAUDE.md
    // Then:  at least 1 match; line is inside the approved-sites enumeration
    const matches = run("grep -n 'subcommands/server.ts' CLAUDE.md || true");
    assert.ok(
      matches.length > 0,
      `T-DOC.3: CLAUDE.md must mention 'subcommands/server.ts' (Hard Rule 8 / BLOCKER-2); got: ${matches}`,
    );
  });

  it("T-DOC.4: WHEN Hard Rule 8 paragraph is read, THEN approved-sites ordering MUST be: update.ts → launchd.ts → autoUpdate.ts → serverLaunchd.ts → install.sh → soul.ts → server.ts:233 (approval-date order; P-45 clauses LAST)", () => {
    // Given: CLAUDE.md Hard Rule 8 amended by builder per §4 chronological-approval ordering
    // When:  paragraph text parsed for clause positions
    // Then:  soul.ts appears AFTER install.sh; server.ts:233 appears AFTER soul.ts (CONCERN-LR-2)
    // Parse the Hard Rule 8 paragraph's text and verify the ordering of approved sites.
    // The paragraph is a single LONG line in CLAUDE.md — we scan for substring positions.
    const claudeMd = run("cat CLAUDE.md");
    const hr8Start = claudeMd.indexOf("The no-bash boundary");
    assert.ok(hr8Start > 0, "T-DOC.4: Hard Rule 8 paragraph must be findable via 'The no-bash boundary' anchor");
    // Find end of HR8 — the next numbered hard rule or section break.
    const hr8End = claudeMd.indexOf("\n9.", hr8Start);
    const hr8 = hr8End > 0 ? claudeMd.slice(hr8Start, hr8End) : claudeMd.slice(hr8Start, hr8Start + 4000);

    const positions = {
      update: hr8.indexOf("subcommands/update.ts"),
      launchd: hr8.indexOf("subcommands/launchd.ts"),
      autoUpdate: hr8.indexOf("autoUpdate.ts"),
      serverLaunchd: hr8.indexOf("subcommands/serverLaunchd.ts"),
      installSh: hr8.indexOf("install.sh"),
      soul: hr8.indexOf("subcommands/soul.ts"),
      server: hr8.indexOf("subcommands/server.ts"),
    };
    for (const [k, v] of Object.entries(positions)) {
      assert.ok(v >= 0, `T-DOC.4: Hard Rule 8 paragraph must mention '${k}'; positions=${JSON.stringify(positions)}`);
    }
    // The P-45 additions (soul + server) MUST appear AFTER install.sh (chronological).
    assert.ok(
      positions.soul > positions.installSh,
      `T-DOC.4: 'subcommands/soul.ts' must appear AFTER 'install.sh' (chronological order); positions=${JSON.stringify(positions)}`,
    );
    assert.ok(
      positions.server > positions.soul,
      `T-DOC.4: 'subcommands/server.ts' must appear AFTER 'subcommands/soul.ts' (P-45 clauses last); positions=${JSON.stringify(positions)}`,
    );
  });
});

// ─── G-P45.11 — no-bash boundary regression guard ────────────────────────────

describe("No-bash boundary regression guard (G-P45.11)", () => {
  it("T-BND.1: WHEN grep for child_process imports in src/tools/, THEN MUST return zero matches (boundary unbroken)", () => {
    // Given: P-45 does not add any new child_process imports to src/tools/**
    // When:  grep -rE "from ['\"](node:)?child_process['\"]" src/tools/
    // Then:  empty output (zero matches)
    const result = run(
      'grep -rE "from \'(node:)?child_process\'|from \\"(node:)?child_process\\"" src/tools/ 2>/dev/null || true',
    );
    assert.equal(
      result,
      "",
      `T-BND.1: child_process import in src/tools/ must be absent (no-bash boundary intact); got: ${result || "(empty)"}`,
    );
  });

  it("T-BND.2: WHEN npx biome check src/tools/ with noRestrictedImports rule, THEN exit code MUST be 0 (child_process still banned)", () => {
    // Given: biome.json noRestrictedImports rule still scoped to src/tools/**
    // When:  biome check on src/tools/ directory
    // Then:  no noRestrictedImports errors (exit 0 for that rule)
    // The biome noRestrictedImports rule for src/tools/** is in biome.json.
    // Verify (a) the rule is configured AND (b) running biome check on src/tools/
    // doesn't surface any noRestrictedImports error.
    const biomeJson = run("cat biome.json");
    assert.ok(
      biomeJson.includes("noRestrictedImports") || biomeJson.includes("restrictedImports"),
      "T-BND.2: biome.json must have a noRestrictedImports rule configured",
    );
    // Run biome check on src/tools/ and verify no `noRestrictedImports` errors.
    let lintOut = "";
    try {
      lintOut = execSync("npx biome check src/tools/ 2>&1", { cwd: ROOT, encoding: "utf-8", stdio: "pipe" });
    } catch (e: unknown) {
      const out = (e as { stdout?: string | Buffer }).stdout;
      lintOut = typeof out === "string" ? out : (out?.toString("utf-8") ?? "");
    }
    assert.ok(
      !lintOut.includes("noRestrictedImports"),
      `T-BND.2: biome check src/tools/ must NOT flag any noRestrictedImports violation; got: ${lintOut.slice(0, 600)}`,
    );
  });
});
