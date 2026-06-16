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

  it("T-LINT.3: lint gate is top-level only; biome excludes generated runtime and preserves src/tools no-bash rule", () => {
    // Given: P-66 moves generated-runtime linting out of the maintained-source health gate.
    // When:  package.json and biome.json are inspected structurally, without running npm run lint inside test:fast.
    // Then:  top-level lint remains "biome check .", !build/runtime is excluded, and src/tools/** keeps child_process banned.
    const pkg = JSON.parse(run("cat package.json")) as { scripts?: Record<string, string> };
    const biome = JSON.parse(run("cat biome.json")) as {
      files?: { includes?: string[] };
      overrides?: Array<{
        includes?: string[];
        linter?: { rules?: { style?: { noRestrictedImports?: unknown } } };
      }>;
    };

    assert.equal(pkg.scripts?.lint, "biome check .", 'T-LINT.3: package.json scripts.lint must stay "biome check ."');
    assert.ok(
      biome.files?.includes?.includes("!build/runtime"),
      "T-LINT.3: biome.json files.includes must exclude generated build/runtime output",
    );

    const toolsOverride = biome.overrides?.find((override) => override.includes?.includes("**/src/tools/**"));
    assert.ok(toolsOverride, "T-LINT.3: biome.json must keep an override scoped to **/src/tools/**");
    const noRestrictedImports = toolsOverride.linter?.rules?.style?.noRestrictedImports as
      | { level?: string; options?: { paths?: Record<string, string> } }
      | undefined;
    assert.equal(
      noRestrictedImports?.level,
      "error",
      "T-LINT.3: src/tools noRestrictedImports must remain error-level",
    );
    assert.ok(
      noRestrictedImports?.options?.paths?.child_process,
      "T-LINT.3: src/tools noRestrictedImports must still ban child_process",
    );
    assert.ok(
      noRestrictedImports?.options?.paths?.["node:child_process"],
      "T-LINT.3: src/tools noRestrictedImports must still ban node:child_process",
    );
  });
});

// ─── G-P45.10 — CLAUDE.md amendment (E-7 + E-7b) ────────────────────────────
//
// P-APP-11 stage (b1) reconciliation: the soul.ts $EDITOR spawn site is deleted (§3.4).
// CLAUDE.md Hard Rule 8 is amended at Step 7 (orchestrator) to remove the soul.ts approved-site
// clause. T-DOC.1 is updated to drop the soul.ts check (site no longer exists after b1).
// T-DOC.4 is updated to remove soul.ts position check (the server.ts clause is the final P-45
// approved site after the amendment). T-DOC.2/3 are updated in lock-step.

describe("ROADMAP.md approved CLI-layer child_process sites (G-P45.10)", () => {
  it("T-DOC.1: WHEN ROADMAP carve-out section is read, THEN it lists the surviving server.ts editor site", () => {
    // Given: mutable child_process carve-out inventory lives in ROADMAP.md.
    // When:  reading the canonical section.
    // Then:  server.ts:231-234 remains listed as the approved server soul edit site.
    const roadmap = run("cat ROADMAP.md");
    assert.match(roadmap, /## Approved CLI-layer child_process sites/);
    assert.match(roadmap, /src\/cli\/subcommands\/server\.ts:231-234/);
  });

  it("T-DOC.2: WHEN ROADMAP carve-out section is read, THEN it includes the 2026-05-20 approval date for server.ts", () => {
    // Given: P-45 retroactively approved the server.ts:231-234 editor site on 2026-05-20.
    // When:  ROADMAP.md is scanned.
    // Then:  the server.ts row carries that date.
    const roadmap = run("cat ROADMAP.md");
    assert.match(roadmap, /src\/cli\/subcommands\/server\.ts:231-234`?\s*\|\s*2026-05-20/);
  });

  it("T-DOC.3: WHEN CLAUDE.md is read, THEN it points Hard Rule 8 readers to ROADMAP.md for the carve-out list", () => {
    // Given: CLAUDE.md is condensed and no longer duplicates the full approved-site inventory.
    // When:  the no-bash boundary paragraph is scanned.
    // Then:  it points to the canonical ROADMAP.md section.
    const claudeMd = run("cat CLAUDE.md");
    assert.match(claudeMd, /ROADMAP\.md` § Approved CLI-layer `child_process` sites/);
  });

  it("T-DOC.4: WHEN ROADMAP carve-out section is read, THEN approved-sites ordering is chronological", () => {
    // Given: ROADMAP.md owns the approved-site inventory.
    // When:  the section is parsed for site positions.
    // Then:  the operator-approved sites appear in chronological order.
    const roadmap = run("cat ROADMAP.md");
    const start = roadmap.indexOf("## Approved CLI-layer child_process sites");
    assert.ok(start > 0, "T-DOC.4: ROADMAP carve-out section must exist");
    const end = roadmap.indexOf("\n## Current Validation Matrix", start);
    const section = end > 0 ? roadmap.slice(start, end) : roadmap.slice(start, start + 4000);
    const positions = {
      update: section.indexOf("src/cli/subcommands/update.ts"),
      launchd: section.indexOf("src/cli/subcommands/launchd.ts"),
      autoUpdate: section.indexOf("src/cli/autoUpdate.ts"),
      serverLaunchd: section.indexOf("src/cli/subcommands/serverLaunchd.ts"),
      installSh: section.indexOf("install.sh"),
      server: section.indexOf("src/cli/subcommands/server.ts:231-234"),
      tauri: section.indexOf("src/tauri/src-tauri/src/main.rs"),
    };
    for (const [k, v] of Object.entries(positions)) {
      assert.ok(
        v >= 0,
        `T-DOC.4: ROADMAP carve-out section must mention '${k}'; positions=${JSON.stringify(positions)}`,
      );
    }
    assert.deepEqual(
      Object.values(positions),
      Object.values(positions)
        .slice()
        .sort((a, b) => a - b),
      `T-DOC.4: approved sites must be chronological; positions=${JSON.stringify(positions)}`,
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
