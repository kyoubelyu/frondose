/**
 * P-APP-6 Step 3a — main.rs spawn path scaffold
 *
 * Covers:
 *   T-Sidecar.Spawn.1 — main.rs references dist/app/sidecarMain.js in resolve_sidecar_bin
 *                        and spawn_mai_serve uses resolve_sidecar_bin (not resolve_mai_bin);
 *                        "serve" positional arg is NOT passed by spawn_mai_serve
 *   T-Sidecar.Spawn.2 — spawn_mai_serve still passes MAI_AUTOUPDATE=skip + MAI_SIDECAR_OWNER=frondose-app
 *   T-Sidecar.Spawn.3 — MAI_SIDECAR_BIN_PATH env override exists in resolve_sidecar_bin
 *   T-Sidecar.Spawn.4 — resolve_mai_bin is kept with #[allow(dead_code)] annotation
 *
 * Strategy: source-scan src/tauri/src-tauri/src/main.rs as text.
 * These tests fail pre-impl because main.rs has not been edited yet.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/tauri/sidecarSpawnPath-papp6.mock.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const REPO = resolve(process.cwd());
const MAIN_RS_PATH = resolve(REPO, "src/tauri/src-tauri/src/main.rs");
const MAIN_RS = readFileSync(MAIN_RS_PATH, "utf8");

/** Extract the body of a named Rust function (simple, non-nested approach). */
function extractRustFn(name: string): string | null {
  // Match "async fn <name>" or "fn <name>" followed by the function body
  const pattern = new RegExp(`(?:async\\s+)?fn\\s+${name}\\s*\\([\\s\\S]*?^}`, "m");
  const match = MAIN_RS.match(pattern);
  return match ? match[0] : null;
}

/** Extract the spawn_mai_serve body (multi-line, ends at the final Ok(child) + closing brace). */
function spawnMaiServeSource(): string {
  const match = MAIN_RS.match(/async fn spawn_mai_serve[\s\S]*?Ok\(child\)\s*\n}/);
  assert.ok(match, "main.rs must contain spawn_mai_serve");
  return match[0];
}

describe("T-Sidecar.Spawn — main.rs sidecar spawn path after P-APP-6", () => {
  it("T-Sidecar.Spawn.1: main.rs spawn_mai_serve uses resolve_sidecar_bin + dist/app/sidecarMain.js path + no 'serve' positional arg", () => {
    // Given: main.rs has been edited by Codex builder (Step 4)
    // When:  validator reads spawn_mai_serve source + resolve_sidecar_bin function
    // Then:  spawn_mai_serve calls resolve_sidecar_bin() (not resolve_mai_bin());
    //        resolve_sidecar_bin contains "dist/app/sidecarMain.js";
    //        spawn_mai_serve does NOT pass .arg("serve") as the third arg after the bin
    const spawnSrc = spawnMaiServeSource();

    // Must reference resolve_sidecar_bin, not resolve_mai_bin
    assert.match(
      spawnSrc,
      /resolve_sidecar_bin\s*\(\s*\)/,
      "spawn_mai_serve must call resolve_sidecar_bin()",
    );
    assert.doesNotMatch(
      spawnSrc,
      /resolve_mai_bin\s*\(\s*\)/,
      "spawn_mai_serve must NOT call resolve_mai_bin() after P-APP-6",
    );

    // "serve" positional arg must be gone from spawn arg list
    // The old code had: .arg(&mai_bin).arg("serve").arg("--sock")
    // New code: .arg(&sidecar_bin).arg("--sock") — no intermediate .arg("serve")
    assert.doesNotMatch(
      spawnSrc,
      /\.arg\s*\(\s*"serve"\s*\)/,
      'spawn_mai_serve must NOT pass .arg("serve") — sidecarMain.ts has no subcommand routing',
    );

    // dist/app/sidecarMain.js must appear somewhere in main.rs (in resolve_sidecar_bin)
    assert.ok(
      MAIN_RS.includes("dist/app/sidecarMain.js"),
      'main.rs must contain "dist/app/sidecarMain.js" in resolve_sidecar_bin',
    );
  });

  it("T-Sidecar.Spawn.2: spawn_mai_serve preserves MAI_AUTOUPDATE=skip and MAI_SIDECAR_OWNER=frondose-app", () => {
    // Given: main.rs spawn_mai_serve body after P-APP-6 edit
    // When:  validator greps spawn_mai_serve body
    // Then:  .env("MAI_AUTOUPDATE", "skip") present (defense in depth)
    //        .env("MAI_SIDECAR_OWNER", "frondose-app") present (marker for overlay)
    const spawnSrc = spawnMaiServeSource();

    assert.match(
      spawnSrc,
      /\.env\s*\(\s*"MAI_AUTOUPDATE"\s*,\s*"skip"\s*\)/,
      'spawn_mai_serve must set .env("MAI_AUTOUPDATE", "skip")',
    );
    assert.match(
      spawnSrc,
      /\.env\s*\(\s*"MAI_SIDECAR_OWNER"\s*,\s*"frondose-app"\s*\)/,
      'spawn_mai_serve must set .env("MAI_SIDECAR_OWNER", "frondose-app")',
    );
  });

  it("T-Sidecar.Spawn.3: resolve_sidecar_bin reads MAI_SIDECAR_BIN_PATH env override", () => {
    // Given: main.rs after P-APP-6 adds resolve_sidecar_bin
    // When:  validator reads resolve_sidecar_bin source
    // Then:  MAI_SIDECAR_BIN_PATH env var override is present
    assert.ok(
      MAIN_RS.includes("resolve_sidecar_bin"),
      "main.rs must define resolve_sidecar_bin (pre-impl: intentional scaffold failure)",
    );
    assert.ok(
      MAIN_RS.includes("MAI_SIDECAR_BIN_PATH"),
      'main.rs must reference MAI_SIDECAR_BIN_PATH in resolve_sidecar_bin (pre-impl: intentional scaffold failure)',
    );
  });

  it("T-Sidecar.Spawn.4: resolve_mai_bin is kept with #[allow(dead_code)] for P-APP-11 transition", () => {
    // Given: main.rs after P-APP-6; resolve_mai_bin is no longer called by spawn_mai_serve
    // When:  validator reads the main.rs source
    // Then:  resolve_mai_bin function is still present (not deleted);
    //        #[allow(dead_code)] annotation appears above it
    assert.ok(
      MAIN_RS.includes("fn resolve_mai_bin"),
      "main.rs must retain resolve_mai_bin function (kept for P-APP-11 transition)",
    );
    // Check that allow(dead_code) appears near (within 3 lines of) resolve_mai_bin
    const deadCodeIdx = MAIN_RS.indexOf("#[allow(dead_code)]");
    const resolveMaiBinIdx = MAIN_RS.indexOf("fn resolve_mai_bin");
    assert.ok(deadCodeIdx !== -1, "#[allow(dead_code)] must be present in main.rs");
    assert.ok(
      resolveMaiBinIdx !== -1 && Math.abs(deadCodeIdx - resolveMaiBinIdx) < 200,
      "#[allow(dead_code)] must appear close to resolve_mai_bin",
    );
  });
});
