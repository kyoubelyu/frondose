/**
 * P-APP-6 Step 3a — main.rs spawn path scaffold
 *
 * Covers:
 *   T-Sidecar.Spawn.1 — main.rs references dist/app/sidecarMain.js in resolve_sidecar_bin
 *                        and spawn_frondose_serve uses resolve_sidecar_bin (not resolve_frondose_bin);
 *                        "serve" positional arg is NOT passed by spawn_frondose_serve
 *   T-Sidecar.Spawn.2 — spawn_frondose_serve still passes MAI_AUTOUPDATE=skip + MAI_SIDECAR_OWNER=frondose-app
 *   T-Sidecar.Spawn.3 — FRONDOSE_SIDECAR_BIN_PATH env override exists in resolve_sidecar_bin
 *   T-Sidecar.Spawn.4 — resolve_frondose_bin is kept with #[allow(dead_code)] annotation
 *
 * Strategy: source-scan src/tauri/src-tauri/src/main.rs as text.
 * These tests fail pre-impl because main.rs has not been edited yet.
 *
 * Run:
 *   node --import tsx --test --experimental-test-module-mocks --test-force-exit \
 *     tests/tauri/sidecarSpawnPath-papp6.mock.test.ts
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const REPO = resolve(process.cwd());
const MAIN_RS_PATH = resolve(REPO, "src/tauri/src-tauri/src/main.rs");

// CH-3 module split (2026-06-18): spawn_frondose_serve moved to sidecar.rs;
// resolve_sidecar_bin, FRONDOSE_SIDECAR_BIN_PATH, and resolve_frondose_bin moved
// to resolve.rs. Concatenate all *.rs files in the crate so every T-Sidecar.Spawn
// assertion continues to find the symbol it guards regardless of its module.
// spawnMaiServeSource() extracts the function body from the concatenated source —
// the function is still present and still ends with Ok(child)+closing brace.
const CRATE_SRC_DIR = resolve(REPO, "src/tauri/src-tauri/src");
const MAIN_RS = readdirSync(CRATE_SRC_DIR)
  .filter((f) => f.endsWith(".rs"))
  .sort()
  .map((f) => readFileSync(resolve(CRATE_SRC_DIR, f), "utf8"))
  .join("\n");

/** Extract the body of a named Rust function (simple, non-nested approach). */
function extractRustFn(name: string): string | null {
  // Match "async fn <name>" or "fn <name>" followed by the function body
  const pattern = new RegExp(`(?:async\\s+)?fn\\s+${name}\\s*\\([\\s\\S]*?^}`, "m");
  const match = MAIN_RS.match(pattern);
  return match ? match[0] : null;
}

/** Extract the spawn_frondose_serve body (multi-line, ends at the final Ok(child) + closing brace). */
function spawnMaiServeSource(): string {
  const match = MAIN_RS.match(/async fn spawn_frondose_serve[\s\S]*?Ok\(child\)\s*\n}/);
  assert.ok(match, "main.rs must contain spawn_frondose_serve");
  return match[0];
}

describe("T-Sidecar.Spawn — main.rs sidecar spawn path after P-APP-6", () => {
  it("T-Sidecar.Spawn.1: main.rs spawn_frondose_serve uses resolve_sidecar_bin + dist/app/sidecarMain.js path + no 'serve' positional arg", () => {
    // Given: main.rs has been edited by Codex builder (Step 4)
    // When:  validator reads spawn_frondose_serve source + resolve_sidecar_bin function
    // Then:  spawn_frondose_serve calls resolve_sidecar_bin() (not resolve_frondose_bin());
    //        resolve_sidecar_bin contains "dist/app/sidecarMain.js";
    //        spawn_frondose_serve does NOT pass .arg("serve") as the third arg after the bin
    const spawnSrc = spawnMaiServeSource();

    // Must reference resolve_sidecar_bin, not resolve_frondose_bin
    assert.match(spawnSrc, /resolve_sidecar_bin\s*\(\s*\)/, "spawn_frondose_serve must call resolve_sidecar_bin()");
    assert.doesNotMatch(
      spawnSrc,
      /resolve_frondose_bin\s*\(\s*\)/,
      "spawn_frondose_serve must NOT call resolve_frondose_bin() after P-APP-6",
    );

    // "serve" positional arg must be gone from spawn arg list
    // The old code had: .arg(&mai_bin).arg("serve").arg("--sock")
    // New code: .arg(&sidecar_bin).arg("--sock") — no intermediate .arg("serve")
    assert.doesNotMatch(
      spawnSrc,
      /\.arg\s*\(\s*"serve"\s*\)/,
      'spawn_frondose_serve must NOT pass .arg("serve") — sidecarMain.ts has no subcommand routing',
    );

    // dist/app/sidecarMain.js must appear somewhere in main.rs (in resolve_sidecar_bin)
    assert.ok(
      MAIN_RS.includes("dist/app/sidecarMain.js"),
      'main.rs must contain "dist/app/sidecarMain.js" in resolve_sidecar_bin',
    );
  });

  it("T-Sidecar.Spawn.2: spawn_frondose_serve preserves FRONDOSE_AUTOUPDATE=skip and FRONDOSE_SIDECAR_OWNER=frondose-app (F-REN-3 Group B flip)", () => {
    // Given: main.rs spawn_frondose_serve body after F-REN-3 Group B Rust SET rename
    // When:  validator greps spawn_frondose_serve body
    // Then:  .env("FRONDOSE_AUTOUPDATE", "skip") present (defense in depth; F-REN-3 renamed)
    //        .env("FRONDOSE_SIDECAR_OWNER", "frondose-app") present (marker for overlay; F-REN-3 renamed)
    const spawnSrc = spawnMaiServeSource();

    assert.match(
      spawnSrc,
      /\.env\s*\(\s*"FRONDOSE_AUTOUPDATE"\s*,\s*"skip"\s*\)/,
      'spawn_frondose_serve must set .env("FRONDOSE_AUTOUPDATE", "skip") (F-REN-3 Group B rename)',
    );
    assert.match(
      spawnSrc,
      /\.env\s*\(\s*"FRONDOSE_SIDECAR_OWNER"\s*,\s*"frondose-app"\s*\)/,
      'spawn_frondose_serve must set .env("FRONDOSE_SIDECAR_OWNER", "frondose-app") (F-REN-3 Group B rename)',
    );
  });

  it("T-Sidecar.Spawn.3: resolve_sidecar_bin reads FRONDOSE_SIDECAR_BIN_PATH env override", () => {
    // Given: main.rs after P-APP-6 adds resolve_sidecar_bin
    // When:  validator reads resolve_sidecar_bin source
    // Then:  FRONDOSE_SIDECAR_BIN_PATH env var override is present
    assert.ok(
      MAIN_RS.includes("resolve_sidecar_bin"),
      "main.rs must define resolve_sidecar_bin (pre-impl: intentional scaffold failure)",
    );
    assert.ok(
      MAIN_RS.includes("FRONDOSE_SIDECAR_BIN_PATH"),
      "main.rs must reference FRONDOSE_SIDECAR_BIN_PATH in resolve_sidecar_bin (pre-impl: intentional scaffold failure)",
    );
  });

  it("T-Sidecar.Spawn.4: resolve_frondose_bin is removed — the P-APP-11 transition is complete (P-OPEN-SOURCE-SPLIT)", () => {
    // Given: the CLI entrypoint is retired (T-RETIRE.CLI.1 — no dist/cli/main.js in
    //        source, package, Rust resolver or build scripts)
    // When:  validator reads the Rust crate source
    // Then:  the CLI-entry resolver no longer exists and no dist/cli/main.js literal
    //        remains anywhere in the crate
    assert.ok(
      !MAIN_RS.includes("fn resolve_frondose_bin"),
      "resolve_frondose_bin must be deleted (CLI entrypoint retired with P-OPEN-SOURCE-SPLIT)",
    );
    assert.ok(
      !MAIN_RS.includes("dist/cli/main.js"),
      "no dist/cli/main.js literal may remain in the Rust crate (T-RETIRE.CLI.1)",
    );
  });
});
