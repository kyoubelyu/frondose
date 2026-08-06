/**
 * WIN-2 Step 3 (scaffold) — T-WIN2.4a..d
 *
 * Structural assertions on `package.json` scripts shape.
 *
 * Gate coverage:
 *   G-WIN2.4  — T-WIN2.4a (scripts.install is cross-platform no-op, NOT bare "true")
 *              T-WIN2.4b (scripts.build uses node scripts/chmod-dist.mjs, NOT chmod +x)
 *              T-WIN2.4c (scripts["build:web"] uses node scripts/copy-web-assets.mjs, NOT cp )
 *              T-WIN2.4d (scripts["build:tauri"] uses node scripts/chmod-dist.mjs, NOT chmod +x)
 *
 * These tests READ the real package.json and FAIL NOW (pre-impl) because:
 *   - scripts.install is still "true"  → T-WIN2.4a fails
 *   - scripts.build still has "chmod +x" → T-WIN2.4b fails
 *   - scripts["build:web"] still has "cp " → T-WIN2.4c fails
 *   - scripts["build:tauri"] still has "chmod +x" → T-WIN2.4d fails
 * This is the CORRECT pre-impl red state; Step 4 implementer makes these green.
 *
 * Design note (R-4): these are repo-wide assertions that catch any re-introduction
 * of POSIX shell-isms in the 4 targeted scripts across future edits.
 *
 * Run: node --import tsx --test --test-force-exit tests/build/package-json-scripts.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

// ─── G-WIN2.4: package.json scripts are cross-platform ───────────────────────

describe("G-WIN2.4 — package.json: scripts use cross-platform helpers; no POSIX shell-isms", () => {
  it("T-WIN2.4a: scripts.install is a cross-platform no-op using `node -e` and NOT the bare word `true`", () => {
    // Given: package.json scripts.install reflects the WIN-2 implementation
    // When:  scripts.install is read
    // Then:  it contains "node -e" (uses Node, not a POSIX /bin/true or bare shell `true`)
    //        AND does NOT equal exactly "true" (which fails on Windows — no true.exe)

    const installScript = pkg.scripts.install;
    assert.ok(typeof installScript === "string", "T-WIN2.4a: scripts.install must exist");
    assert.notEqual(
      installScript,
      "true",
      "T-WIN2.4a: scripts.install must NOT be the bare string 'true' (breaks on Windows — no true.exe)",
    );
    assert.ok(
      installScript.includes("node -e"),
      `T-WIN2.4a: scripts.install must contain 'node -e' (got: ${JSON.stringify(installScript)})`,
    );
  });

  it("T-WIN2.4b: scripts.build contains `node scripts/chmod-dist.mjs` and does NOT contain `chmod +x`", () => {
    // Given: package.json scripts.build reflects the WIN-2 implementation
    // When:  scripts.build is read
    // Then:  it contains "node scripts/chmod-dist.mjs" (the new cross-platform helper)
    //        AND does NOT contain "chmod +x" (POSIX-only — fails on Windows)

    const buildScript = pkg.scripts.build;
    assert.ok(typeof buildScript === "string", "T-WIN2.4b: scripts.build must exist");
    assert.ok(
      !buildScript.includes("chmod +x"),
      `T-WIN2.4b: scripts.build must NOT contain 'chmod +x' (POSIX-only; got: ${JSON.stringify(buildScript)})`,
    );
    assert.ok(
      buildScript.includes("node scripts/chmod-dist.mjs"),
      `T-WIN2.4b: scripts.build must contain 'node scripts/chmod-dist.mjs' (got: ${JSON.stringify(buildScript)})`,
    );
  });

  it("T-WIN2.4c: scripts['build:web'] is retired with the fleet console (P-OPEN-SOURCE-SPLIT §9.3)", () => {
    // Given: the fleet web console (src/web/**) and its build chain are retired
    // When:  scripts["build:web"] is read
    // Then:  it is absent — no POSIX shell-ism can be reintroduced through it

    const webScript = pkg.scripts["build:web"];
    assert.ok(webScript === undefined, "T-WIN2.4c: scripts['build:web'] must be removed (fleet console retired)");
  });

  it("T-WIN2.4d: scripts['build:tauri'] contains `node scripts/chmod-dist.mjs` and does NOT contain `chmod +x`", () => {
    // Given: package.json scripts["build:tauri"] reflects the WIN-2 implementation
    // When:  scripts["build:tauri"] is read
    // Then:  it contains "node scripts/chmod-dist.mjs" (the new cross-platform helper)
    //        AND does NOT contain "chmod +x" (POSIX-only — fails on Windows)

    const tauriScript = pkg.scripts["build:tauri"];
    assert.ok(typeof tauriScript === "string", "T-WIN2.4d: scripts['build:tauri'] must exist");
    assert.ok(
      !tauriScript.includes("chmod +x"),
      `T-WIN2.4d: scripts['build:tauri'] must NOT contain 'chmod +x' (POSIX-only; got: ${JSON.stringify(tauriScript)})`,
    );
    assert.ok(
      tauriScript.includes("node scripts/chmod-dist.mjs"),
      `T-WIN2.4d: scripts['build:tauri'] must contain 'node scripts/chmod-dist.mjs' (got: ${JSON.stringify(tauriScript)})`,
    );
  });
});
